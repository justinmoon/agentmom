import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { PiBridge } from "../src/pi-bridge.js";
import { PreviewManager } from "../src/previews.js";
import {
  createSkill,
  deleteSkill,
  listSkillFiles,
  readSkillFile,
  resolveSkillPath,
  skillRoots,
  writeSkillFile
} from "../src/skills.js";

const root = mkdtempSync(join(tmpdir(), "agentmom-skills-"));

process.env.AGENTMOM_WORKSPACE = join(root, "workspace");
process.env.AGENTMOM_WORKSPACE_ROOT = join(root, "workspace-root");
process.env.AGENTMOM_STATE_DIR = join(root, "state");
process.env.AGENTMOM_EXECUTOR = "local";

const config = loadConfig();
let bridge: PiBridge | undefined;

try {
  bridge = new PiBridge(config, new PreviewManager(config));
  await bridge.init();

  assert.deepEqual(bridge.listSkills(), []);
  assert.deepEqual((await bridge.snapshot()).skills, []);

  // Create a workspace-global skill; names are slugified.
  const skillFile = createSkill(config, "Deploy Checklist");
  assert.equal(skillFile, join(skillRoots(config).workspace, "deploy-checklist", "SKILL.md"));
  assert.equal(existsSync(skillFile), true);
  assert.throws(() => createSkill(config, "deploy checklist"), /already exists/);
  assert.throws(() => createSkill(config, "!!!"), /name is required/);

  let state = await bridge.refreshSkills();
  assert.equal(state.skills.length, 1);
  assert.equal(state.skills[0].name, "deploy-checklist");
  assert.equal(state.skills[0].source, "workspace");

  // Files within a skill: SKILL.md first, supporting files editable.
  const baseDir = state.skills[0].baseDir;
  writeSkillFile(config, join(baseDir, "scripts", "check.sh"), "#!/bin/sh\necho ok\n");
  const files = listSkillFiles(config, baseDir);
  assert.deepEqual(
    files.map((file) => file.path),
    [join(baseDir, "SKILL.md"), join(baseDir, "scripts", "check.sh")]
  );
  assert.match(readSkillFile(config, skillFile).content, /name: deploy-checklist/);

  // Project-local skills (what the agent writes from inside the sandbox) are picked up.
  const projectSkillDir = join(skillRoots(config).project, "git-hygiene");
  mkdirSync(projectSkillDir, { recursive: true });
  writeFileSync(
    join(projectSkillDir, "SKILL.md"),
    "---\nname: git-hygiene\ndescription: Keep commits tidy.\n---\n\nRules.\n"
  );
  state = await bridge.refreshSkills();
  assert.deepEqual(
    state.skills.map((skill) => [skill.name, skill.source]).sort(),
    [
      ["deploy-checklist", "workspace"],
      ["git-hygiene", "project"]
    ]
  );

  // The ~/.pi/agent/skills convention (with HOME = the mounted workspace) is also loaded.
  const agentConventionDir = join(skillRoots(config).projectAgent, "convention-check");
  mkdirSync(agentConventionDir, { recursive: true });
  writeFileSync(
    join(agentConventionDir, "SKILL.md"),
    "---\nname: convention-check\ndescription: Written via the documented pi global path.\n---\n\nBody.\n"
  );
  state = await bridge.refreshSkills();
  assert.equal(
    state.skills.some((skill) => skill.name === "convention-check" && skill.source === "project"),
    true
  );
  assert.match(readSkillFile(config, join(agentConventionDir, "SKILL.md")).content, /convention-check/);
  assert.throws(() => deleteSkill(config, skillRoots(config).projectAgent), /skill root/);
  deleteSkill(config, agentConventionDir);

  // Path jail: reads and writes outside the skill roots are rejected.
  assert.throws(() => readSkillFile(config, "/etc/passwd"), /outside the skill directories/);
  assert.throws(
    () => resolveSkillPath(config, join(baseDir, "..", "..", "..", "..", "escape.txt")),
    /outside the skill directories/
  );
  assert.throws(() => deleteSkill(config, skillRoots(config).workspace), /skill root/);

  deleteSkill(config, baseDir);
  state = await bridge.refreshSkills();
  assert.deepEqual(
    state.skills.map((skill) => skill.name),
    ["git-hygiene"]
  );

  console.log("skills smoke ok");
} finally {
  bridge?.dispose();
  if (process.env.AGENTMOM_KEEP_SMOKE !== "1") {
    rmSync(root, { recursive: true, force: true });
  }
}
