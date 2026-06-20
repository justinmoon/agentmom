import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { DeploymentManager } from "../src/deployments.js";
import type { DeploymentRecord } from "../src/types.js";
import { workspaceConfig } from "../src/workspace-runtime.js";

const root = mkdtempSync(join(tmpdir(), "agentmom-workspace-"));

process.env.AGENTMOM_AUTH_ENABLED = "1";
process.env.AGENTMOM_WORKSPACE = join(root, "workspace");
process.env.AGENTMOM_WORKSPACE_ROOT = join(root, "workspace-root");
process.env.AGENTMOM_STATE_DIR = join(root, "state");
process.env.AGENTMOM_EXECUTOR = "local";

try {
  const config = loadConfig();
  const catalog = new CatalogStore(config);

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

  const adminWorkspace = catalog.workspaceForUser(adminUser);
  const userWorkspace = catalog.workspaceForUser(normalUser);
  const adminRuntimeConfig = workspaceConfig(config, adminWorkspace);
  assert.equal(catalog.authorizeWorkspace(adminUser, userWorkspace.id).id, userWorkspace.id);
  assert.throws(() => catalog.authorizeWorkspace(normalUser, adminWorkspace.id), /forbidden/);

  const runtimeConfig = workspaceConfig(config, userWorkspace);
  assert.equal(runtimeConfig.workspace.startsWith(config.workspaceRoot), true);
  assert.equal(runtimeConfig.smolvm.name, userWorkspace.machineName);
  assert.equal(runtimeConfig.previewBasePath, `/w/${encodeURIComponent(userWorkspace.id)}/preview`);
  assert.equal(runtimeConfig.workspaceId, userWorkspace.id);

  const deploymentManager = new DeploymentManager(config);
  const stoppedDeployment = (slug: string, workspaceId?: string, projectPath = join(root, slug)): DeploymentRecord => ({
    id: slug,
    workspaceId,
    slug,
    name: slug,
    projectPath,
    image: `localhost/${slug}:test`,
    container: `container-${slug}`,
    containerPort: 3000,
    hostPort: 41000,
    urlPath: `/deploy/${slug}/`,
    status: "stopped",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });
  mkdirSync(config.deploymentDir, { recursive: true });
  writeFileSync(
    join(config.deploymentDir, "deployments.json"),
    `${JSON.stringify(
      {
        deployments: [
          stoppedDeployment("legacy-global"),
          stoppedDeployment("legacy-user-deploy", undefined, join(runtimeConfig.projectsDir, "legacy-user-deploy")),
          stoppedDeployment("user-one-deploy", userWorkspace.id),
          stoppedDeployment("admin-deploy", adminWorkspace.id)
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const userDeployments = (
    await deploymentManager.list({
      workspaceId: userWorkspace.id,
      workspaceDirName: runtimeConfig.workspaceDirName
    })
  ).map((deployment) => deployment.slug);
  assert.equal(userDeployments.includes("legacy-user-deploy"), true);
  assert.equal(userDeployments.includes("legacy-global"), false);
  assert.equal(userDeployments.includes("user-one-deploy"), true);
  assert.deepEqual(
    (
      await deploymentManager.list({
        workspaceId: adminWorkspace.id,
        workspaceDirName: adminRuntimeConfig.workspaceDirName
      })
    ).map((deployment) => deployment.slug),
    ["admin-deploy"]
  );
  await assert.rejects(
    () => deploymentManager.publish({ path: root, slug: "outside-projects", port: 3000, workspaceId: userWorkspace.id }),
    /Deployment path must be inside/
  );

  console.log("workspace catalog smoke ok");
} finally {
  if (process.env.AGENTMOM_KEEP_SMOKE !== "1") {
    rmSync(root, { recursive: true, force: true });
  }
}
