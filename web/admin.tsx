import { UserPlus, X } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import type { MeState, PublicAdminUser, PublicInvite } from "../src/types.js";
import { readError, readJsonResponse } from "./http.js";

export function AdminPage({
  authEnabled,
  me,
  onLogout
}: {
  authEnabled: boolean;
  me: MeState;
  onLogout: () => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<"invites" | "users">("invites");
  const [invites, setInvites] = useState<PublicInvite[]>([]);
  const [users, setUsers] = useState<PublicAdminUser[]>([]);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const loadInvites = useCallback(async () => {
    const response = await fetch("/api/admin/invites");
    const payload = (await readJsonResponse(response)) as { invites: PublicInvite[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
    setInvites(payload.invites);
  }, []);

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/admin/users");
    const payload = (await readJsonResponse(response)) as { users: PublicAdminUser[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
    setUsers(payload.users);
  }, []);

  useEffect(() => {
    if (me.user.role !== "admin") return;
    void Promise.all([loadInvites(), loadUsers()]).catch((err) => setError(readError(err)));
  }, [loadInvites, loadUsers, me.user.role]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, role })
      });
      const payload = (await readJsonResponse(response)) as { invite: PublicInvite; code: string; error?: string };
      if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
      setLabel("");
      await loadInvites();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function disableInvite(invite: PublicInvite) {
    setError(undefined);
    const response = await fetch(`/api/admin/invites/${encodeURIComponent(invite.id)}/disable`, { method: "POST" });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      setError(payload.error ?? JSON.stringify(payload));
      return;
    }
    await loadInvites();
  }

  if (me.user.role !== "admin") {
    return (
      <main className="admin-shell">
        <header className="admin-header">
          <div className="brand">
            <div className="brand-mark">AM</div>
            <div>
              <h1>Admin</h1>
              <p>Admin access required</p>
            </div>
          </div>
          <a className="admin-link-button" href="/">
            Back to app
          </a>
        </header>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div className="brand">
          <div className="brand-mark">AM</div>
          <div>
            <h1>Admin</h1>
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

      <section className="admin-panel">
        <div className="admin-tabs" role="tablist" aria-label="Admin tabs">
          <button
            type="button"
            className={activeTab === "invites" ? "active" : ""}
            onClick={() => setActiveTab("invites")}
            role="tab"
            aria-selected={activeTab === "invites"}
          >
            Invites
          </button>
          <button
            type="button"
            className={activeTab === "users" ? "active" : ""}
            onClick={() => setActiveTab("users")}
            role="tab"
            aria-selected={activeTab === "users"}
          >
            Users
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        {activeTab === "invites" ? (
          <div className="admin-tab-body">
            <form className="admin-create-form" onSubmit={(event) => void submit(event)}>
              <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label" />
              <select value={role} onChange={(event) => setRole(event.target.value)}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <button type="submit" disabled={busy}>
                <UserPlus size={16} />
                <span>{busy ? "Creating" : "Create"}</span>
              </button>
            </form>

            <div className="admin-list">
              {invites.length === 0 ? (
                <p className="muted">No invites yet.</p>
              ) : (
                invites.map((invite) => (
                  <article className="admin-row invite-admin-row" key={invite.id}>
                    <div>
                      <strong>{invite.label}</strong>
                      <code>{invite.code}</code>
                      <small>
                        {invite.role} · used {invite.usedCount} · {invite.active ? "active" : "disabled"}
                      </small>
                    </div>
                    {invite.active && (
                      <button type="button" onClick={() => void disableInvite(invite)} title="Disable invite">
                        <X size={16} />
                      </button>
                    )}
                  </article>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="admin-tab-body">
            <div className="admin-list">
              {users.length === 0 ? (
                <p className="muted">No users yet.</p>
              ) : (
                users.map((user) => (
                  <article className="admin-row user-admin-row" key={user.id}>
                    <div>
                      <strong>{user.fullName}</strong>
                      <span>{user.email}</span>
                    </div>
                    <div>
                      <span>{user.role}</span>
                      <small>{user.workspace?.displayName ?? "No workspace"}</small>
                    </div>
                    <div>
                      <span>{user.invite ? user.invite.label : "First/admin seed"}</span>
                      <small>{user.invite?.code ?? "No invite"}</small>
                    </div>
                    <time dateTime={new Date(user.createdAt * 1000).toISOString()}>
                      {new Date(user.createdAt * 1000).toLocaleDateString()}
                    </time>
                  </article>
                ))
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
