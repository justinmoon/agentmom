export type ChatRole = "user" | "assistant";
export type UserRole = "admin" | "user";
export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export type PublicUser = {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  inviteId?: string;
  createdAt: number;
  lastSeenAt?: number;
};

export type PublicWorkspace = {
  id: string;
  slug: string;
  displayName: string;
  ownerUserId: string;
  machineName: string;
  createdAt: number;
  updatedAt: number;
};

export type PublicInvite = {
  id: string;
  code: string;
  label: string;
  role: UserRole;
  usedCount: number;
  active: boolean;
  createdByUserId: string;
  createdAt: number;
  disabledAt?: number;
};

export type PublicAdminUser = PublicUser & {
  workspace?: PublicWorkspace;
  invite?: PublicInvite;
};

export type PublicTelegramLink = {
  id: string;
  userId: string;
  workspaceId: string;
  chatId: string;
  chatType: TelegramChatType;
  title?: string;
  username?: string;
  telegramUserId?: string;
  telegramUsername?: string;
  active: boolean;
  createdAt: number;
  lastSeenAt?: number;
};

export type MeState = {
  ok: true;
  authEnabled: boolean;
  user: PublicUser;
  workspace: PublicWorkspace;
  workspaces: PublicWorkspace[];
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  attachments?: MessageAttachment[];
  createdAt: string;
  status?: "running" | "complete" | "error";
};

export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

export type MessageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataBase64?: string;
  path?: string;
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

export type PreviewService = {
  id: string;
  name: string;
  port: number;
  runtime: "local" | "fly";
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentRecord = {
  id: string;
  workspaceId?: string;
  slug: string;
  name: string;
  projectPath: string;
  /** Older records predate this field; undefined means "container". */
  kind?: "container" | "static";
  image: string;
  container: string;
  containerPort: number;
  hostPort: number;
  /** Directory the deployed files are served from (static deployments only). */
  staticDir?: string;
  urlPath: string;
  url?: string;
  urlHost?: string;
  status: "building" | "running" | "suspended" | "failed" | "stopped";
  createdAt: string;
  updatedAt: string;
  lastDeployAt?: string;
  lastRequestAt?: string;
  error?: string;
  buildLog?: string;
};

export type SkillSource = "workspace" | "project";

export type SkillSummary = {
  name: string;
  description: string;
  source: SkillSource;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
};

export type SkillFileEntry = {
  path: string;
  size: number;
};

export const MAX_SKILL_FILE_BYTES = 1024 * 1024;

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
  previews: PreviewService[];
  skills: SkillSummary[];
  messages: ChatMessage[];
  events: UiEvent[];
  isRunning: boolean;
  model: string;
  tools: string[];
  error?: string;
  runtime: {
    executor: "local" | "fly";
    guestWorkspace?: string;
  };
};
