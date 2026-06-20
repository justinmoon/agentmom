import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";

const root = mkdtempSync(join(tmpdir(), "agentmom-telegram-"));

process.env.AGENTMOM_AUTH_ENABLED = "1";
process.env.AGENTMOM_WORKSPACE = join(root, "workspace");
process.env.AGENTMOM_WORKSPACE_ROOT = join(root, "workspace-root");
process.env.AGENTMOM_STATE_DIR = join(root, "state");
process.env.AGENTMOM_EXECUTOR = "local";

try {
  const catalog = new CatalogStore(loadConfig());
  const admin = catalog.signup({
    email: "admin@example.com",
    fullName: "Admin User",
    password: "password123"
  });
  const adminUser = catalog.currentUser(`agentmom_session=${admin.token}`)!;
  const invite = catalog.createInvite(adminUser, { label: "team", role: "user" });
  const user = catalog.signup({
    email: "user@example.com",
    fullName: "Normal User",
    password: "password123",
    inviteCode: invite.code
  });
  const normalUser = catalog.currentUser(`agentmom_session=${user.token}`)!;
  const userWorkspace = catalog.workspaceForUser(normalUser);

  const telegramCode = catalog.createTelegramLinkCode(normalUser);
  assert.match(telegramCode.code, /^[a-z0-9]{4}$/);
  assert.equal(telegramCode.userId, normalUser.id);
  assert.equal(telegramCode.workspaceId, userWorkspace.id);
  assert.equal(catalog.currentTelegramLinkCode(normalUser)?.code, telegramCode.code);

  const telegramLink = catalog.linkTelegramChat({
    code: telegramCode.code,
    chatId: "517118295",
    chatType: "private",
    title: "Bitcoin User",
    username: "bitcoin",
    telegramUserId: "517118295",
    telegramUsername: "bitcoin"
  });
  assert.equal(telegramLink.workspace.id, userWorkspace.id);
  assert.equal(telegramLink.link.userId, normalUser.id);
  assert.equal(catalog.telegramLinks(normalUser)[0].chatId, "517118295");
  assert.equal(catalog.telegramWorkspaceForChat("517118295")?.workspace.id, userWorkspace.id);
  assert.throws(
    () =>
      catalog.linkTelegramChat({
        code: telegramCode.code,
        chatId: "other",
        chatType: "private"
      }),
    /telegram link code is invalid/
  );
  catalog.unlinkTelegram(normalUser, telegramLink.link.id);
  assert.equal(catalog.telegramWorkspaceForChat("517118295"), undefined);
  assert.equal(catalog.telegramLinks(normalUser).length, 0);
  assert.equal(catalog.currentTelegramLinkCode(normalUser), undefined);

  console.log("telegram catalog smoke ok");
} finally {
  if (process.env.AGENTMOM_KEEP_SMOKE !== "1") {
    rmSync(root, { recursive: true, force: true });
  }
}
