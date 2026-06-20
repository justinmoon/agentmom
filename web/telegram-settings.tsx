import { Link2, MessageCircle, Unlink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { MeState, PublicTelegramLink } from "../src/types.js";
import { readError, readJsonResponse } from "./http.js";

type TelegramSettingsResponse = {
  ok: true;
  enabled: boolean;
  botUsername?: string;
  linkCode?: TelegramLinkCode;
  links: PublicTelegramLink[];
};

type TelegramLinkCode = {
  code: string;
  command: string;
  expiresAt: number;
  botUsername?: string;
};

type TelegramLinkCodeResponse = TelegramLinkCode & { ok: true };

export function TelegramSettingsPage({
  authEnabled,
  me,
  onLogout
}: {
  authEnabled: boolean;
  me: MeState;
  onLogout: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<TelegramSettingsResponse | undefined>();
  const [linkCode, setLinkCode] = useState<TelegramLinkCode | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const loadSettings = useCallback(async () => {
    const response = await fetch("/api/telegram");
    const payload = (await readJsonResponse(response)) as TelegramSettingsResponse & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
    setSettings(payload);
    setLinkCode(payload.linkCode);
  }, []);

  useEffect(() => {
    void loadSettings().catch((err) => setError(readError(err)));
  }, [loadSettings]);

  useEffect(() => {
    function refreshVisiblePage() {
      if (document.visibilityState === "visible") {
        void loadSettings().catch((err) => setError(readError(err)));
      }
    }
    window.addEventListener("focus", refreshVisiblePage);
    document.addEventListener("visibilitychange", refreshVisiblePage);
    return () => {
      window.removeEventListener("focus", refreshVisiblePage);
      document.removeEventListener("visibilitychange", refreshVisiblePage);
    };
  }, [loadSettings]);

  useEffect(() => {
    if (!linkCode) return undefined;
    const delay = Math.max(0, linkCode.expiresAt * 1000 - Date.now() + 1000);
    const timeout = window.setTimeout(() => {
      void loadSettings().catch((err) => setError(readError(err)));
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [linkCode, loadSettings]);

  async function createLinkCode() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/telegram/link-code", { method: "POST" });
      const payload = (await readJsonResponse(response)) as TelegramLinkCodeResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
      setLinkCode(payload);
      await loadSettings();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function unlink(link: PublicTelegramLink) {
    setError(undefined);
    const response = await fetch(`/api/telegram/links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      setError(payload.error ?? JSON.stringify(payload));
      return;
    }
    await loadSettings();
  }

  const botUsername = linkCode?.botUsername ?? settings?.botUsername;
  const telegramStartUrl = botUsername && linkCode ? `https://t.me/${botUsername}?start=${encodeURIComponent(linkCode.code)}` : undefined;

  return (
    <main className="settings-shell">
      <header className="admin-header">
        <div className="brand">
          <div className="brand-mark">AM</div>
          <div>
            <h1>Telegram</h1>
            <p>{me.user.email}</p>
          </div>
        </div>
        <div className="admin-header-actions">
          <a className="admin-link-button" href="/">
            Back to app
          </a>
          {authEnabled && (
            <button type="button" className="admin-link-button" onClick={() => void onLogout()}>
              Logout
            </button>
          )}
        </div>
      </header>

      <section className="settings-panel">
        {error && <div className="deploy-error">{error}</div>}

        <div className="telegram-setup-grid">
          <article className="settings-card">
            <div className="settings-card-header">
              <MessageCircle size={18} />
              <div>
                <strong>{botUsername ? `@${botUsername}` : settings?.enabled ? "Telegram bot" : "Telegram disabled"}</strong>
                <small>{settings?.enabled ? "Ready to link chats" : "Bot token is not configured"}</small>
              </div>
            </div>
            <button type="button" className="settings-primary-button" onClick={() => void createLinkCode()} disabled={busy || !settings?.enabled}>
              <Link2 size={16} />
              <span>{busy ? "Creating" : "Create link code"}</span>
            </button>
          </article>

          {linkCode && (
            <article className="settings-card">
              <div className="settings-card-header">
                <Link2 size={18} />
                <div>
                  <strong>Link code</strong>
                  <small>Expires {new Date(linkCode.expiresAt * 1000).toLocaleTimeString()}</small>
                </div>
              </div>
              <code className="telegram-command">{linkCode.command}</code>
              <div className="telegram-command-actions">
                <button type="button" onClick={() => void navigator.clipboard?.writeText(linkCode.command)}>
                  Copy command
                </button>
                {telegramStartUrl && (
                  <a href={telegramStartUrl} target="_blank" rel="noreferrer">
                    Open Telegram
                  </a>
                )}
              </div>
            </article>
          )}
        </div>

        <section className="settings-list-block">
          <h2>Linked chats</h2>
          <div className="admin-list">
            {!settings || settings.links.length === 0 ? (
              <p className="muted">No Telegram chats linked.</p>
            ) : (
              settings.links.map((link) => (
                <article className={link.active ? "admin-row telegram-link-row" : "admin-row telegram-link-row inactive"} key={link.id}>
                  <div>
                    <strong>{link.title || link.username || link.chatId}</strong>
                    <small>
                      {link.chatType} · {link.active ? "active" : "disabled"}
                    </small>
                  </div>
                  <code>{link.chatId}</code>
                  <div>
                    <span>{link.telegramUsername ? `@${link.telegramUsername}` : link.telegramUserId ?? "unknown sender"}</span>
                    <small>{new Date(link.createdAt * 1000).toLocaleString()}</small>
                  </div>
                  {link.active && (
                    <button type="button" onClick={() => void unlink(link)} title="Unlink chat">
                      <Unlink size={16} />
                    </button>
                  )}
                </article>
              ))
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
