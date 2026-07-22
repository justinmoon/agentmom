import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import type { AppConfig } from "./config.js";
import type { MessageAttachment } from "./types.js";

export type SavedAttachment = MessageAttachment & {
  dataBase64: string;
  path: string;
  visiblePath: string;
};

export function saveMessageAttachments(config: AppConfig, attachments: MessageAttachment[]): SavedAttachment[] {
  if (attachments.length === 0) return [];

  const batch = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const uploadDir = join(config.agentCwd, ".agentmom", "uploads", batch);
  mkdirSync(uploadDir, { recursive: true });

  return attachments.map((attachment, index) => {
    if (!attachment.dataBase64) {
      throw new Error(`${attachment.name} is missing file data`);
    }
    const data = Buffer.from(attachment.dataBase64, "base64");
    const fileName = `${String(index + 1).padStart(2, "0")}-${safeFileName(attachment.name)}`;
    const filePath = join(uploadDir, fileName);
    writeFileSync(filePath, data);
    return {
      ...attachment,
      dataBase64: attachment.dataBase64,
      size: data.byteLength,
      path: filePath,
      visiblePath: agentVisiblePath(config, filePath)
    };
  });
}

export function attachmentImages(attachments: SavedAttachment[]): ImageContent[] {
  return attachments
    .filter((attachment) => attachment.mimeType.startsWith("image/"))
    .map((attachment) => ({
      type: "image",
      data: attachment.dataBase64,
      mimeType: attachment.mimeType
    }));
}

export function messagePromptText(text: string, attachments: SavedAttachment[]): string {
  if (attachments.length === 0) return text;
  const fileList = attachments
    .map(
      (attachment) =>
        `- ${attachment.visiblePath} (${attachment.mimeType || "application/octet-stream"}, ${formatBytes(attachment.size)})`
    )
    .join("\n");
  return [text, `Attached files:\n${fileList}\n\nUse the saved file paths above when you need to inspect an attachment.`]
    .filter(Boolean)
    .join("\n\n");
}

export function userMessageAttachments(message: UserMessage): MessageAttachment[] | undefined {
  if (typeof message.content === "string") return undefined;
  const attachments = message.content.flatMap((part, index) => {
    if (part.type !== "image") return [];
    return [
      {
        id: `image-${index + 1}`,
        name: `image-${index + 1}${imageExtension(part.mimeType)}`,
        mimeType: part.mimeType,
        size: base64ByteLength(part.data),
        dataBase64: part.data
      }
    ];
  });
  return attachments.length > 0 ? attachments : undefined;
}

function agentVisiblePath(config: AppConfig, hostPath: string): string {
  const guestWorkspace = config.executor === "fly" ? "/workspace" : undefined;
  const projectRelative = relative(resolve(config.projectsDir), hostPath);
  if (guestWorkspace && projectRelative && !projectRelative.startsWith("..") && !isAbsolute(projectRelative)) {
    return posix.join(guestWorkspace.replace(/\/+$/, ""), projectRelative.split(sep).join("/"));
  }
  return hostPath;
}

function safeFileName(name: string): string {
  const safe = name.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return safe || "attachment";
}

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  return "";
}

function base64ByteLength(dataBase64: string): number {
  return Buffer.from(dataBase64, "base64").byteLength;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}
