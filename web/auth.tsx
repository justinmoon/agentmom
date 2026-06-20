import React, { useState } from "react";
import type { MeState } from "../src/types.js";
import { readError } from "./http.js";

export function AuthScreen({
  onAuth,
  onAuthEnabled
}: {
  onAuth: (me: MeState) => void;
  onAuthEnabled: (enabled: boolean) => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, fullName, password, inviteCode })
      });
      const payload = await response.json();
      onAuthEnabled(Boolean(payload.authEnabled));
      if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
      onAuth(payload as MeState);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <div className="brand auth-brand">
          <div className="brand-mark">AM</div>
          <div>
            <h1>Agent Mom</h1>
            <p>{mode === "login" ? "Sign in" : "Create account"}</p>
          </div>
        </div>
        {mode === "signup" && (
          <input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Full name" />
        )}
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" type="email" />
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          type="password"
        />
        {mode === "signup" && (
          <input
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            placeholder="Invite code"
          />
        )}
        {error && <div className="form-error">{error}</div>}
        <button type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? "Working" : mode === "login" ? "Log in" : "Sign up"}
        </button>
        <button
          type="button"
          className="auth-switch"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(undefined);
          }}
        >
          {mode === "login" ? "Need an account?" : "Have an account?"}
        </button>
      </form>
    </main>
  );
}

export function LoadingScreen({ text, error, onRetry }: { text: string; error?: string; onRetry?: () => void }) {
  return (
    <main className="auth-shell">
      <div className="auth-form">
        <div className="brand auth-brand">
          <div className="brand-mark">AM</div>
          <div>
            <h1>Agent Mom</h1>
            <p>{text}</p>
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        {onRetry && (
          <button type="button" className="auth-switch" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </main>
  );
}
