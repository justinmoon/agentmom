import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config.js";
import { MAX_SKILL_FILE_BYTES, type SkillFileEntry, type SkillSource, type SkillSummary } from "./types.js";

const MAX_SKILL_FILES = 200;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "__pycache__"]);

export function skillRoots(config: AppConfig): { workspace: string; project: string; projectAgent: string } {
  return {
    workspace: resolve(config.agentDir, "skills"),
    project: resolve(config.agentCwd, ".pi", "skills"),
    // Where pi's documented "global" convention (~/.pi/agent/skills) lands once the
    // sandboxed agent's HOME is the mounted workspace.
    projectAgent: resolve(config.agentCwd, ".pi", "agent", "skills")
  };
}

export function ensureSkillRoots(config: AppConfig): void {
  const roots = skillRoots(config);
  mkdirSync(roots.workspace, { recursive: true });
  mkdirSync(roots.project, { recursive: true });
}

export function skillSource(config: AppConfig, path: string): SkillSource {
  const roots = skillRoots(config);
  return isWithin(roots.workspace, resolve(path)) ? "workspace" : "project";
}

export function toSkillSummary(config: AppConfig, skill: Skill): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    source: skillSource(config, skill.filePath),
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    disableModelInvocation: skill.disableModelInvocation
  };
}

/** Resolve a client-supplied path and ensure it stays inside one of the skill roots. */
export function resolveSkillPath(config: AppConfig, rawPath: string): string {
  const roots = skillRoots(config);
  const path = resolve(rawPath);
  if (![roots.workspace, roots.project, roots.projectAgent].some((root) => isWithin(root, path))) {
    throw Object.assign(new Error("path is outside the skill directories"), { status: 400 });
  }
  return path;
}

export function listSkillFiles(config: AppConfig, baseDir: string): SkillFileEntry[] {
  const root = resolveSkillPath(config, baseDir);
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) {
    return [{ path: root, size: statSync(root).size }];
  }

  const files: SkillFileEntry[] = [];
  const walk = (dir: string) => {
    if (files.length >= MAX_SKILL_FILES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= MAX_SKILL_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
        continue;
      }
      if (entry.isFile()) files.push({ path, size: statSync(path).size });
    }
  };
  walk(root);

  files.sort((a, b) => {
    const aTop = relative(root, a.path).includes(sep) ? 1 : 0;
    const bTop = relative(root, b.path).includes(sep) ? 1 : 0;
    if (aTop !== bTop) return aTop - bTop;
    return a.path.localeCompare(b.path);
  });
  return files;
}

export function readSkillFile(config: AppConfig, rawPath: string): { path: string; content: string } {
  const path = resolveSkillPath(config, rawPath);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw Object.assign(new Error("skill file not found"), { status: 404 });
  }
  if (statSync(path).size > MAX_SKILL_FILE_BYTES) {
    throw Object.assign(new Error("skill file is too large to edit"), { status: 400 });
  }
  return { path, content: readFileSync(path, "utf8") };
}

export function writeSkillFile(config: AppConfig, rawPath: string, content: string): string {
  const path = resolveSkillPath(config, rawPath);
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_FILE_BYTES) {
    throw Object.assign(new Error("skill file is too large"), { status: 400 });
  }
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

export function createSkill(config: AppConfig, rawName: string): string {
  const name = rawName.trim().toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  if (!name) {
    throw Object.assign(new Error("skill name is required"), { status: 400 });
  }

  const roots = skillRoots(config);
  const skillDir = join(roots.workspace, name);
  const skillFile = join(skillDir, "SKILL.md");
  if (existsSync(skillFile)) {
    throw Object.assign(new Error(`skill "${name}" already exists`), { status: 400 });
  }

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    skillFile,
    [
      "---",
      `name: ${name}`,
      "description: Describe when this skill should be used.",
      "---",
      "",
      `# ${name}`,
      "",
      "Explain what to do when this skill is invoked.",
      ""
    ].join("\n"),
    "utf8"
  );
  return skillFile;
}

export function deleteSkill(config: AppConfig, baseDir: string): void {
  const roots = skillRoots(config);
  const path = resolveSkillPath(config, baseDir);
  if ([roots.workspace, roots.project, roots.projectAgent].includes(path)) {
    throw Object.assign(new Error("refusing to delete a skill root directory"), { status: 400 });
  }
  rmSync(path, { recursive: true, force: true });
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
