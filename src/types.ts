export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  status?: "running" | "complete" | "error";
};

export type UiEvent = {
  id: string;
  type: string;
  title: string;
  detail?: string;
  isError?: boolean;
  createdAt: string;
};

export type SessionSummary = {
  id: string;
  path?: string;
  name?: string;
  cwd: string;
  firstMessage?: string;
  messageCount?: number;
  modified?: string;
};

export type AppState = {
  app: {
    commit?: string;
    sourceDir: string;
  };
  workspace: string;
  projectsDir: string;
  agentCwd: string;
  sessionDir: string;
  session?: SessionSummary;
  sessions: SessionSummary[];
  messages: ChatMessage[];
  events: UiEvent[];
  isRunning: boolean;
  model: string;
  tools: string[];
  error?: string;
  runtime: {
    executor: "local" | "smolvm";
    guestWorkspace?: string;
    vm?: {
      name: string;
      state: string;
      pid: number | null;
    };
  };
};
