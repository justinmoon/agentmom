import { CircleStop, File as FileIcon, Image, Plus, Send, X } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import {
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_TOTAL_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  type MessageAttachment
} from "../src/types.js";
import { readError } from "./http.js";

type AttachmentComposerProps = {
  isRunning: boolean;
  onCancel: () => Promise<void>;
  onSend: (content: string, attachments: MessageAttachment[]) => Promise<void>;
};

export function AttachmentComposer({ isRunning, onCancel, onSend }: AttachmentComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const accepted: File[] = [];
      let totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
      let message: string | undefined;

      for (const file of files) {
        if (accepted.length + attachments.length >= MAX_MESSAGE_ATTACHMENTS) {
          message = `Maximum ${MAX_MESSAGE_ATTACHMENTS} attachments.`;
          break;
        }
        if (file.size > MAX_MESSAGE_ATTACHMENT_BYTES) {
          message = `${file.name} is too large.`;
          continue;
        }
        if (totalBytes + file.size > MAX_MESSAGE_ATTACHMENT_TOTAL_BYTES) {
          message = "Attachments exceed the total upload limit.";
          continue;
        }
        accepted.push(file);
        totalBytes += file.size;
      }

      if (message) setUploadError(message);
      if (accepted.length === 0) return;

      const next = await Promise.all(accepted.map(fileToAttachment));
      setAttachments((current) => [...current, ...next]);
      setUploadError(undefined);
    },
    [attachments]
  );

  async function submit() {
    const submittedDraft = draft;
    const submittedAttachments = attachments;
    const content = submittedDraft.trim();
    if (!content && submittedAttachments.length === 0) return;

    setDraft("");
    setAttachments([]);
    setIsSending(true);
    setUploadError(undefined);
    try {
      await onSend(content, submittedAttachments);
    } catch (error) {
      setDraft(submittedDraft);
      setAttachments(submittedAttachments);
      setUploadError(readError(error));
    } finally {
      setIsSending(false);
    }
  }

  const busy = isRunning || isSending;
  const canSend = draft.trim().length > 0 || attachments.length > 0;

  return (
    <form
      className={dragActive ? "composer drag-active" : "composer"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onPaste={(event) => {
        const files = dataTransferFiles(event.clipboardData);
        if (files.length === 0) return;
        event.preventDefault();
        void addFiles(files);
      }}
      onDragEnter={(event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        const files = dataTransferFiles(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        setDragActive(false);
        void addFiles(files);
      }}
    >
      <input
        ref={inputRef}
        className="composer-file-input"
        type="file"
        multiple
        onChange={(event) => {
          void addFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />

      {attachments.length > 0 && (
        <MessageAttachments
          attachments={attachments}
          onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
        />
      )}

      {uploadError && <div className="composer-error">{uploadError}</div>}

      <button
        type="button"
        className="composer-file-button"
        title="Attach files"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <Plus size={20} />
      </button>

      <textarea
        autoFocus
        className="composer-input"
        placeholder="Ask for a code change, command, or explanation..."
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void submit();
        }}
      />

      {isRunning ? (
        <button type="button" className="icon-button danger" title="Stop" onClick={() => void onCancel()}>
          <CircleStop size={18} />
        </button>
      ) : (
        <button type="submit" className="icon-button primary" title="Send" disabled={busy || !canSend}>
          <Send size={18} />
        </button>
      )}
    </form>
  );
}

export function MessageAttachments({
  attachments,
  onRemove
}: {
  attachments: MessageAttachment[];
  onRemove?: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-list">
      {attachments.map((attachment) => {
        const isImage = attachment.mimeType.startsWith("image/") && attachment.dataBase64;
        return (
          <div className="attachment-chip" key={attachment.id} title={attachment.name}>
            <div className="attachment-thumb">
              {isImage ? (
                <img src={`data:${attachment.mimeType};base64,${attachment.dataBase64}`} alt="" />
              ) : attachment.mimeType.startsWith("image/") ? (
                <Image size={20} />
              ) : (
                <FileIcon size={20} />
              )}
            </div>
            <div className="attachment-meta">
              <span>{attachment.name}</span>
              <small>{formatBytes(attachment.size)}</small>
            </div>
            {onRemove && (
              <button type="button" className="attachment-remove" title="Remove" onClick={() => onRemove(attachment.id)}>
                <X size={16} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function dataTransferFiles(dataTransfer: DataTransfer): File[] {
  const files = Array.from(dataTransfer.files ?? []);
  if (files.length > 0) return files;
  return Array.from(dataTransfer.items ?? []).flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

function hasFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

function fileToAttachment(file: File): Promise<MessageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve({
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || "attachment",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        dataBase64: comma === -1 ? result : result.slice(comma + 1)
      });
    };
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}
