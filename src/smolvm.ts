import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { posix as pathPosix } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config.js";

export type SmolvmSnapshot = {
  name: string;
  state: string;
  pid: number | null;
  guestWorkspace: string;
};

export class SmolvmRuntime {
  private currentState?: SmolvmSnapshot;
  private startPromise?: Promise<void>;

  constructor(private readonly config: AppConfig) {}

  async ensureReady(): Promise<void> {
    this.startPromise ??= this.start();
    await this.startPromise;
  }

  snapshot(): SmolvmSnapshot | undefined {
    return this.currentState;
  }

  createBashOperations(): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        await this.ensureReady();
        if (options.signal?.aborted) throw new Error("aborted");

        const result = await this.execInGuest(command, this.hostCwdToGuest(cwd), {
          timeout: options.timeout,
          signal: options.signal,
          onData: options.onData
        });

        if (options.signal?.aborted) throw new Error("aborted");
        return { exitCode: result.exitCode };
      }
    };
  }

  async dispose(): Promise<void> {}

  private async start(): Promise<void> {
    mkdirSync(this.config.workspace, { recursive: true });
    mkdirSync(this.config.projectsDir, { recursive: true });
    mkdirSync(this.config.agentCwd, { recursive: true });

    if (!(await this.machineExists())) {
      await this.runSmolvm([
        "machine",
        "create",
        "--name",
        this.config.smolvm.name,
        "--image",
        this.config.smolvm.image,
        "--cpus",
        String(this.config.smolvm.cpus),
        "--mem",
        String(this.config.smolvm.memoryMb),
        "--storage",
        String(this.config.smolvm.storageGib),
        "--overlay",
        String(this.config.smolvm.overlayGib),
        "--volume",
        `${this.config.projectsDir}:${this.config.smolvm.guestWorkspace}`,
        "--workdir",
        this.config.smolvm.guestWorkspace,
        ...(this.config.smolvm.network ? ["--net"] : [])
      ]);
    }

    await this.runSmolvm(["machine", "start", "--name", this.config.smolvm.name]);
    await this.refreshState();

    const check = await this.execInGuest(`test -d ${shellQuote(this.config.smolvm.guestWorkspace)} && pwd`, this.config.smolvm.guestWorkspace, {
      timeout: 30
    });
    if (check.exitCode !== 0) {
      throw new Error(`smolvm workspace check failed: ${check.stderr || check.stdout}`);
    }
  }

  private hostCwdToGuest(cwd: string): string {
    const projectsDir = resolve(this.config.projectsDir);
    const resolvedCwd = resolve(cwd);
    const rel = relative(projectsDir, resolvedCwd);
    const insideProjects = rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
    if (!insideProjects) return this.config.smolvm.guestWorkspace;
    return pathPosix.join(this.config.smolvm.guestWorkspace, rel.split(sep).join("/"));
  }

  private async machineExists(): Promise<boolean> {
    const result = await this.runSmolvm(["machine", "status", "--name", this.config.smolvm.name, "--json"], {
      allowFailure: true
    });
    return result.exitCode === 0;
  }

  private async refreshState(): Promise<void> {
    const result = await this.runSmolvm(["machine", "status", "--name", this.config.smolvm.name, "--json"]);
    const parsed = JSON.parse(result.stdout) as { state?: string; pid?: number | null };
    this.currentState = {
      name: this.config.smolvm.name,
      state: parsed.state ?? "unknown",
      pid: parsed.pid ?? null,
      guestWorkspace: this.config.smolvm.guestWorkspace
    };
  }

  private async execInGuest(
    command: string,
    workdir: string,
    options: {
      timeout?: number;
      signal?: AbortSignal;
      onData?: (data: Buffer) => void;
    } = {}
  ): Promise<CommandResult> {
    return this.runSmolvm(
      [
        "machine",
        "exec",
        "--stream",
        "--name",
        this.config.smolvm.name,
        "--workdir",
        workdir,
        ...(options.timeout ? ["--timeout", `${options.timeout}s`] : []),
        "--",
        "sh",
        "-lc",
        command
      ],
      {
        signal: options.signal,
        onData: options.onData
      }
    );
  }

  private async runSmolvm(
    args: string[],
    options: {
      allowFailure?: boolean;
      signal?: AbortSignal;
      onData?: (data: Buffer) => void;
    } = {}
  ): Promise<CommandResult> {
    return runCommand(this.config.smolvm.command, args, options);
  }
}

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

function runCommand(
  command: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    signal?: AbortSignal;
    onData?: (data: Buffer) => void;
  }
): Promise<CommandResult> {
  if (options.signal?.aborted) return Promise.reject(new Error("aborted"));

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (data: Buffer) => {
      stdout.push(data);
      options.onData?.(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr.push(data);
      options.onData?.(data);
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      options.signal?.removeEventListener("abort", onAbort);
      const result = {
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed (${exitCode}): ${result.stderr || result.stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
