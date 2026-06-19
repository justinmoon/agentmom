import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike
} from "@assistant-ui/react";
import { CircleStop, GitBranch, Play, RefreshCw, Send, SquarePen, Terminal } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppState, ChatMessage, SessionSummary } from "../src/types.js";
import "./styles.css";

const emptyState: AppState = {
  workspace: "",
  sessionDir: "",
  sessions: [],
  messages: [],
  events: [],
  isRunning: false,
  model: "",
  tools: [],
  references: {
    pi: "",
    assistantUi: ""
  }
};

function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    const response = await fetch("/api/state");
    const next = (await response.json()) as AppState;
    setState(next);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError(readError(err)));

    const events = new EventSource("/api/events");
    events.addEventListener("state", (event) => {
      setState(JSON.parse((event as MessageEvent).data) as AppState);
      setError(undefined);
    });
    events.onerror = () => setError("Event stream disconnected. Refresh or restart the dev server.");
    return () => events.close();
  }, [refresh]);

  const messages = useMemo(() => state.messages.map(toThreadMessage), [state.messages]);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: state.isRunning,
    convertMessage: (message) => message,
    onNew: async (message) => {
      const content = appendMessageText(message);
      if (!content.trim()) return;
      setError(undefined);
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      if (!response.ok) throw new Error(await response.text());
      setState((await response.json()) as AppState);
    },
    onCancel: async () => {
      const response = await fetch("/api/cancel", { method: "POST" });
      if (response.ok) setState((await response.json()) as AppState);
    }
  });

  async function newSession() {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new: true })
    });
    setState((await response.json()) as AppState);
  }

  async function openSession(session: SessionSummary) {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: session.path })
    });
    setState((await response.json()) as AppState);
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">G2</div>
            <div>
              <h1>Agent Granny 2</h1>
              <p>Pi-backed local coding loop</p>
            </div>
          </div>

          <div className="workspace-block">
            <span>Workspace</span>
            <code title={state.workspace}>{state.workspace || "loading"}</code>
          </div>

          <div className="actions">
            <button type="button" onClick={newSession}>
              <SquarePen size={16} />
              <span>New</span>
            </button>
            <button type="button" onClick={() => void refresh()}>
              <RefreshCw size={16} />
              <span>Refresh</span>
            </button>
          </div>

          <section className="sessions">
            <h2>Sessions</h2>
            <div className="session-list">
              {state.sessions.length === 0 ? (
                <p className="muted">No persisted sessions yet.</p>
              ) : (
                state.sessions.map((session) => (
                  <button
                    type="button"
                    className={session.path === state.session?.path ? "session active" : "session"}
                    key={session.path ?? session.id}
                    onClick={() => void openSession(session)}
                  >
                    <GitBranch size={14} />
                    <span>{session.firstMessage || session.name || session.id}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <strong>{state.model || "loading model"}</strong>
              <span>{state.tools.join(", ")}</span>
            </div>
            <div className={state.isRunning ? "run-state running" : "run-state"}>
              {state.isRunning ? <Play size={14} /> : <Terminal size={14} />}
              <span>{state.isRunning ? "running" : "idle"}</span>
            </div>
          </header>

          {(error || state.error) && <div className="error-line">{error ?? state.error}</div>}

          <div className="content-grid">
            <section className="thread-panel">
              <ThreadPrimitive.Root className="thread-root">
                <ThreadPrimitive.Viewport className="thread-viewport">
                  <ThreadPrimitive.Empty>
                    <div className="empty-thread">
                      <h2>Ask Pi to work in this workspace.</h2>
                      <p>Messages go straight to a Pi session with read, bash, edit, and write.</p>
                    </div>
                  </ThreadPrimitive.Empty>
                  <ThreadPrimitive.Messages>
                    {({ message }) => (
                      <MessagePrimitive.Root className={`message ${message.role}`}>
                        <div className="message-role">{message.role}</div>
                        <div className="message-body">
                          <MessagePrimitive.Content />
                        </div>
                      </MessagePrimitive.Root>
                    )}
                  </ThreadPrimitive.Messages>
                </ThreadPrimitive.Viewport>

                <ComposerPrimitive.Root className="composer">
                  <ComposerPrimitive.Input
                    autoFocus
                    className="composer-input"
                    placeholder="Ask for a code change, command, or explanation..."
                    submitMode="enter"
                  />
                  {state.isRunning ? (
                    <ComposerPrimitive.Cancel className="icon-button danger" title="Stop">
                      <CircleStop size={18} />
                    </ComposerPrimitive.Cancel>
                  ) : (
                    <ComposerPrimitive.Send className="icon-button primary" title="Send">
                      <Send size={18} />
                    </ComposerPrimitive.Send>
                  )}
                </ComposerPrimitive.Root>
              </ThreadPrimitive.Root>
            </section>

            <aside className="events-panel">
              <h2>Events</h2>
              <div className="event-list">
                {state.events.length === 0 ? (
                  <p className="muted">Tool and turn events appear here.</p>
                ) : (
                  state.events.map((event) => (
                    <article className={event.isError ? "event error" : "event"} key={event.id}>
                      <div>
                        <strong>{event.title}</strong>
                        <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                      </div>
                      {event.detail && <pre>{event.detail}</pre>}
                    </article>
                  ))
                )}
              </div>
            </aside>
          </div>
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
}

function toThreadMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt),
    status:
      message.role === "assistant"
        ? message.status === "running"
          ? { type: "running" }
          : message.status === "error"
            ? { type: "incomplete", reason: "error" }
            : { type: "complete", reason: "stop" }
        : undefined
  };
}

function appendMessageText(message: AppendMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
