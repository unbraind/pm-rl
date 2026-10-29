/** Exercise the same captured tarball through supported global, ephemeral and local host installations. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import type { JsonValue } from "../index.ts";
import type { TrainingInfluenceRequest } from "../training-influence.ts";

const [archiveInput, output] = process.argv.slice(2);
const scratch = mkdtempSync(join(tmpdir(), "rl-influence-packed-"));
// Literal shell syntax must remain part of the filename in all five installed-consumer routes.
const archive = join(scratch, "artifact $(touch injected); literal.tgz"); copyFileSync(resolve(archiveInput), archive);
const clean: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", PM_AUTHOR: "influence-packed" };
for (const key of Object.keys(clean)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH/i.test(key) && key !== "PM_AUTHOR") delete clean[key];
delete clean.PM_PATH; delete clean.NODE_V8_COVERAGE; delete clean.NPM_MEDIA_SERVER;
/** Execute a trusted install or host command without exposing inherited credentials or full process output. */
function execute(command: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}): string {
  return execFileSync(command, args, { shell: false, cwd, env: { ...clean, ...extra }, encoding: "utf8", timeout: 180_000, maxBuffer: 8_388_608 });
}
const bun = execute("sh", ["-c", "command -v bun"], scratch).trim();
const npx = execute("sh", ["-c", "command -v npx"], scratch).trim();
const npm = execute("sh", ["-c", "command -v npm"], scratch).trim();
const entries = execute("tar", ["-tzf", archive], scratch).split("\n");
for (const expected of ["package/dist/training-influence.js", "package/dist/training-influence.d.ts", "package/docs/training-influence.md", "package/examples/training-influence.json"]) assert.ok(entries.includes(expected), expected);
const input = JSON.parse(readFileSync(new URL("../examples/training-influence.json", import.meta.url), "utf8")) as TrainingInfluenceRequest;
const results: Record<string, JsonValue>[] = [];
for (const mode of ["npm-global", "bun-global", "npx", "bunx", "project-local"]) {
  const root = join(scratch, mode); mkdirSync(root); const prefix = join(root, "installation");
  let launcher: string; let prefixArgs: string[] = []; let extra: NodeJS.ProcessEnv = {};
  if (mode === "npm-global") {
    execute(npm, ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "@unbrained/pm-cli@2026.10.28"], root);
    launcher = join(prefix, "bin", "pm");
  } else if (mode === "bun-global") {
    extra = { BUN_INSTALL: prefix };
    execute(bun, ["install", "--global", "--no-progress", "@unbrained/pm-cli@2026.10.28"], root, extra);
    launcher = join(prefix, "bin", "pm");
  } else if (mode === "project-local") {
    execute(npm, ["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", "@unbrained/pm-cli@2026.10.28"], root);
    launcher = join(root, "node_modules", ".bin", "pm");
  } else if (mode === "npx") { launcher = npx; prefixArgs = ["--yes", "--package=@unbrained/pm-cli@2026.10.28", "pm"]; }
  else { launcher = bun; prefixArgs = ["x", "--package", "@unbrained/pm-cli@2026.10.28", "pm"]; }
  const project = mode === "npm-global" ? "training" : mode === "bun-global" ? "training-influence" : "rl";
  const tracker = await init(project, { defaults: true, author: "influence-packed", agentGuidance: "skip" }, { cwd: root });
  extra = { ...extra, PM_PATH: tracker.path, GIT_CEILING_DIRECTORIES: dirname(root) };
  /** All routes exercise the exact extension tarball, with the host supplied by the selected installation mode. */
  const command = (args: string[]): string => execute(launcher, [...prefixArgs, ...args], root, extra);
  assert.match(command(["--version"]), /2026\.10\.28/);
  const installation = JSON.parse(command(["package", "install", archive, "--project", "--json"])) as { details: { install_plan?: { copy: { destination_directory: string } } } };
  const bin = join(root, "no-git-bin"); mkdirSync(bin);
  for (const [name, target] of [["node", process.execPath], ["getconf", "/usr/bin/getconf"], ["sh", "/bin/sh"], ["bun", bun]]) symlinkSync(target, join(bin, name));
  extra.PATH = bin;
  const file = join(root, "input.json"); writeFileSync(file, JSON.stringify(input));
  const run = JSON.parse(command(["rl", "influence", "run", "--file", file, "--json"])) as { details: { id: string; digest: string; created: boolean; comparisons: unknown[] } };
  assert.equal(run.details.created, true); assert.equal(run.details.comparisons.length, 2);
  const retry = JSON.parse(command(["rl", "influence", "run", "--file", file, "--json"])) as { details: { created: boolean } }; assert.equal(retry.details.created, false);
  const json = command(["rl", "influence", "show", run.details.id, "--json"]); const toon = command(["rl", "influence", "show", run.details.id]);
  assert.equal((JSON.parse(json) as { details: { digest: string } }).details.digest, run.details.digest); assert.match(toon, /association/);
  const next = join(root, "proposal.json"); const evidenced = join(root, "evidenced.json");
  writeFileSync(next, JSON.stringify({ environment: { name: "Packed sensitivity", version: "1" }, training: input.training, evaluation: input.held_out, seed: 42, initial_weight: 0, samples_per_generation: 32, fit_steps: 2, max_generations: 1, budget: 32, learning_rate: 0.5, minimum_improvement: 0.01, maximum_gap: 1, evaluation_samples: 100, confidence: 0.95, min_samples: 2 }));
  command(["rl", "influence", "propose", run.details.id, "--file", next, "--output", evidenced, "--json"]);
  assert.ok((JSON.parse(readFileSync(evidenced, "utf8")) as Record<string, unknown>).influence_evidence);
  writeFileSync(file, JSON.stringify({ ...input, budget: { fits: 1, samples: 32, updates: 2 } }));
  const partial = JSON.parse(command(["rl", "influence", "run", "--file", file, "--json"])) as { details: { complete: boolean; ranking: unknown; omitted: unknown[] } };
  assert.equal(partial.details.complete, false); assert.equal(partial.details.ranking, null); assert.equal(partial.details.omitted.length, 2);
  const environmentFile = join(root, "sweep-environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name: "Packed sweep", version: "1", task_suite: ["goal"], reward_specification: { goal: 1 } }));
  const environment = JSON.parse(command(["rl", "env", "register", "--file", environmentFile, "--json"])) as { id: string };
  const spaceFile = join(root, "sweep-space.json");
  writeFileSync(spaceFile, JSON.stringify({ search_space: { rate: [0.1, 0.2] }, selection_rule: "none" }));
  const sweep = JSON.parse(command(["rl", "sweep", "plan", "packed-sweep", "--file", spaceFile, "--environment", environment.id, "--algorithm", "bandit", "--json"])) as { id: string; details: { arms: string[] } };
  assert.equal(sweep.details.arms.length, 2);
  const sweepJson = command(["rl", "sweep", "status", sweep.id, "--json"]);
  const sweepToon = command(["rl", "sweep", "status", sweep.id]);
  assert.equal((JSON.parse(sweepJson) as { id: string }).id, sweep.id);
  for (const arm of sweep.details.arms) assert.ok(sweepJson.includes(arm) && sweepToon.includes(arm));
  const processConfig = join(root, "process-config.json");
  const processProgramme = JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
  writeFileSync(processConfig, JSON.stringify({ ...processProgramme, max_generations: 1, samples_per_generation: 32, budget: 32 }));
  // The host's install receipt locates the package; SDK imports resolve normally
  // from that installed package, without consulting argv or executable symlinks.
  let installedRoot = installation.details.install_plan?.copy.destination_directory;
  if (installedRoot === undefined) {
    const managed = JSON.parse(command(["package", "manage", "--json"])) as { roots: { selected: string }; details: { extensions: { name: string; directory: string }[] } };
    const own = managed.details.extensions.find((entry) => entry.name === "pm-rl"); assert.ok(own);
    installedRoot = resolve(managed.roots.selected, own.directory);
  }
  const probe = join(installedRoot, `publication-probe-${randomUUID()}.ts`);
  const probeSource = readFileSync(new URL("./fixtures/process-publication-probe.ts", import.meta.url), "utf8").replaceAll('"../../', '"./dist/').replaceAll('.ts";', '.js";');
  writeFileSync(probe, probeSource, { flag: "wx" });
  try {
    const runtime = mode === "bun-global" || mode === "bunx" ? bun : process.execPath;
    const checked = JSON.parse(execute(runtime, [probe, root, tracker.path, processConfig], root, extra)) as { publication_refusals: number; peer_state_retained: boolean; staging_recoveries: number; resumed_budget_retained: boolean; materialization_refusals: number };
    assert.equal(checked.publication_refusals, 2); assert.equal(checked.peer_state_retained, true);
    assert.equal(checked.staging_recoveries, 2); assert.equal(checked.resumed_budget_retained, true); assert.equal(checked.materialization_refusals, 1);
  } finally { unlinkSync(probe); }
  const client = new PmClient({ cwd: root, pmRoot: tracker.path, noExtensions: true });
  const projectPrefix = String((await client.config("project", "get", "id_prefix")).nested_setting!.value);
  const processAllowance = { training_steps: 1, wall_ms: 5000, storage_bytes: 65536, compute_units: 1000, tokens: 4 };
  const processApproval = await client.create({ id: "packed-process-approval", type: "Decision", title: "One recursive packed fit", body: "```json\n" + JSON.stringify({ permitted_promotions: 1, resource_budget: processAllowance }) + "\n```" });
  writeFileSync(processConfig, JSON.stringify({ ...processProgramme, max_generations: 1, samples_per_generation: 32, budget: 32, adapter: { kind: "process-bandit", allowance: processAllowance } }));
  command(["rl", "loop", "run", "packed-process", "--file", processConfig, "--approval", processApproval.item.id, "--json"]);
  const processStatus = command(["rl", "loop", "status", "packed-process", "--json"]);
  const processToon = command(["rl", "loop", "status", "packed-process"]);
  assert.ok(processStatus.includes("process-")); assert.ok(processToon.includes("process-"));
  command(["rl", "loop", "resume", "packed-process", "--approval", processApproval.item.id, "--json"]);

  const stored = (await client.get(run.details.id, { full: true })).item;
  assert.ok(String(stored.body).includes('"checkpoint"')); assert.equal(stored.parent, undefined);
  await client.update(run.details.id, { type: "Task" });
  for (const format of [[], ["--json"]]) for (const args of [["run", "--file", file], ["show", run.details.id], ["propose", run.details.id, "--file", next, "--output", join(root, "foreign-proposal.json")]]) {
    // Restore the original input before retrying the foreign report identity.
    writeFileSync(file, JSON.stringify(input));
    assert.throws(() => command(["rl", "influence", ...args, ...format]), (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error && "stderr" in error);
      const diagnostic = String(error.stdout) + String(error.stderr);
      assert.match(diagnostic, /fresh report/);
      if (format.length) assert.match(diagnostic, /influence_foreign/);
      return true;
    });
  }
  assert.equal((await client.get(run.details.id, { full: true })).item.type, "Task");
  assert.equal(existsSync(join(root, "foreign-proposal.json")), false);
  assert.equal(existsSync(join(root, "injected")), false);
  results.push({ project_prefix: projectPrefix, foreign_refusals: 6, shell_metacharacter_path: true, mode, host: "2026.10.28", sweep_arms: 2, sweep_json_toon: true, publication_refusals: 2, staging_recoveries: 2, resumed_budget_retained: true, materialization_refusals: 1, process_loop_json_toon: true, process_loop_resume: true, comparisons: run.details.comparisons.length, json_bytes: Buffer.byteLength(json), toon_bytes: Buffer.byteLength(toon), retry_created: false, partial_omitted: partial.details.omitted.length, no_git: true, proposal_feedback: true });
  process.stdout.write(`${mode}: passed\n`);
}
const bytes = readFileSync(archive);
writeFileSync(output, JSON.stringify({ format: "pm-rl/training-influence-packed/1", artifact: { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, inspected_contents: true }, modes: results }, null, 2) + "\n");
