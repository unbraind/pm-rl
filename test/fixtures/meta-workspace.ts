/** Synthetic histories in real Git snapshots and an ordinary SDK tracker for controller acceptance. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { buildTrackerDataset } from "../../dataset.ts";
import { INITIAL_RECIPE, recipeArtifact } from "../../recipe.ts";
import type { MetaConfig } from "../../meta.ts";
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
export const metaSpec = { permitted_promotions: 100, resource_budget: { training_steps: 100, wall_ms: 3_000_000, storage_bytes: 409_600, compute_units: 3_000_000, tokens: 0 },
  meta_budget: { training_samples: 1_000_000, proposal_calls: 100, recipe_promotions: 100 } };
export const metaConfig: MetaConfig = { initial_recipe: recipeArtifact({ ...INITIAL_RECIPE.knobs, learning_rate: 1, steps: 1, batch: 128, temperature: 0.5 }), seed: 42,
  meta_generations: 2, candidates: 2, timeout_ms: 300_000, criterion: { confidence: 0.95, minSamples: 2, effectThreshold: 0.001 }, maximum_gap: 0.5,
  evaluation_samples: 40_000, adapter: { kind: "process-bandit", allowance: { training_steps: 1, wall_ms: 30_000, storage_bytes: 4096, compute_units: 30_000, tokens: 0 } } };

/** Run real Git commands against the supplied disposable repository. */
export function git(root: string, args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

/** The executable boundary supplies synthetic GitHub metadata; all Git reads use real committed history files. */
export function trackerSources() {
  const root = mkdtempSync(join(tmpdir(), "rl-meta-fixture-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='api'){ console.log(a[1].split('/').at(-1)); } else { const repo=a[2]; console.log(JSON.stringify({visibility:process.env.RL_FIXTURE_VISIBILITY||'PUBLIC',licenseInfo:process.env.RL_FIXTURE_NO_LICENSE?null:{key:'mit'},nameWithOwner:repo})); }\n`);
  chmodSync(gh, 0o755);
  const fixture = JSON.parse(readFileSync(new URL("./tracker-histories.json", import.meta.url), "utf8")) as { prefix: string[]; terminal: string }[];
  const directories: string[] = [];
  for (const name of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
    const project = join(root, `pm-${name}`); const history = join(project, ".agents/pm/history"); mkdirSync(history, { recursive: true });
    git(project, ["init", "-q"]); git(project, ["remote", "add", "origin", `https://github.com/public-fixture/pm-${name}.git`]);
    for (let index = 0; index < 32; index += 1) {
      const example = fixture[index % fixture.length];
      writeFileSync(join(history, `item-${index}.jsonl`), [...example.prefix, example.terminal].map((status, event) => JSON.stringify({ ts: new Date(1_700_000_000_000 + event * (index + 1) * 10_000).toISOString(), author: "fixture", op: event === 0 ? "create" : "update", patch: [{ path: "/metadata/status", value: status }, ...(event === 0 ? [{ path: "/metadata/title", value: index % 2 === 0 ? "short urgent fix" : "long planned feature" }, { path: "/metadata/description", value: "Synthetic first description" }, { path: "/metadata/type", value: "Task" }] : [])] })).join("\n"));
    }
    git(project, ["add", ".agents/pm/history"]);
    git(project, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Synthetic tracker snapshot"]);
    directories.push(join(project, ".agents/pm"));
  }
  return { root, bin, gh, directories };
}

/** Scope a synthetic external metadata executable to a single sequential test process. */
export async function withTrackerSources<T>(operation: (source: ReturnType<typeof trackerSources>) => Promise<T>): Promise<T> {
  const source = trackerSources(); const original = process.env.PATH;
  process.env.PATH = `${source.bin}:${original}`;
  try { return await operation(source); } finally { process.env.PATH = original; }
}

/** Build the synthetic sealed dataset and initialize a real tracker without consulting injected PM_PATH. */
export async function metaWorkspace() {
  return withTrackerSources(async (source) => {
    const dataset = join(source.root, "dataset"); const manifest = buildTrackerDataset(source.directories, dataset);
    const project = join(source.root, "controller"); mkdirSync(project);
    const { path: pmRoot } = await init("rl", { defaults: true, agentGuidance: "skip", author: "meta-test" }, { cwd: project, pmRoot: join(project, ".agents/pm") });
    const client = new PmClient({ pmRoot, cwd: project, author: "meta-test", noExtensions: true });
    const approval = await client.create({ id: "approval", type: "Decision", title: "Bounded synthetic recipe allowance", body: `\`\`\`json\n${JSON.stringify(metaSpec)}\n\`\`\`` });
    return { ...source, project, dataset, manifest, client, approval: approval.item.id, coordinates: { pmRoot, author: "meta-test" } };
  });
}
