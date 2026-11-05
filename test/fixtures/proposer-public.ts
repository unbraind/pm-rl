/** Read a copied public tracker through the SDK; write execution evidence only in a separate scratch tracker. */
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { initialProposer, mutateProposer, type ProposalInvocation } from "../../proposer-program.ts";
import { executeProposer, PROPOSER_ALLOWANCE } from "../../proposer-evolution.ts";
import { listProcessJobs } from "../../process.ts";

/** Fingerprint all copied files, including relationship ledgers and append-only histories. */
function snapshot(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => { for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) { const path = join(directory, entry.name); if (entry.isDirectory()) visit(path); else { hash.update(path.slice(root.length)); hash.update(readFileSync(path)); } } };
  visit(root); return hash.digest("hex");
}
const [source, output, evidence] = process.argv.slice(2);
const before = snapshot(source); const sourceClient = new PmClient({ cwd: dirname(dirname(source)), pmRoot: source, noExtensions: true, author: "public-validation" });
const items = (await sourceClient.listAllComplete({ includeBody: true })).items; const schema = await sourceClient.schemaList();
const roles = new Map([...schema.statuses.builtin, ...schema.statuses.custom].map((status) => [status.id, status.roles]));
const counts = Array.from({ length: 8 }, (_, arm) => ({ arm, wins: 0, trials: 0 })); let terminal = 0;
for (const item of items) { const arm = parseInt(createHash("sha256").update(item.id).digest("hex").slice(0,8),16) % 8; const done = roles.get(item.status)?.includes("terminal") === true; counts[arm].trials++; counts[arm].wins += Number(done); terminal += Number(done); }
const initialized = await init("validation", { defaults: true, agentGuidance: "skip", author: "public-validation" }, { cwd: output, pmRoot: join(output, ".agents/pm") });
const coordinates = { pmRoot: initialized.path, author: "public-validation" }; const client = new PmClient({ ...coordinates, cwd: output, noExtensions: true });
const approval = await client.create({ id: "approval", type: "Decision", title: "Bounded public proposer validation", unset: ["parent", "sprint", "release", "assignee", "goal", "objective", "reviewer", "blocked_by"], dep: [], inheritFocus: false, body: '```json\n'+JSON.stringify({ permitted_promotions: 0, resource_budget: Object.fromEntries(Object.entries(PROPOSER_ALLOWANCE).map(([key,value]) => [key,value*4])) })+'\n```' });
const initial = initialProposer(); const input: ProposalInvocation = { program: initial, role: "development", counts, seed: 42, count: 2 };
const candidate = mutateProposer(input); const start = performance.now();
const baseline = await executeProposer(client, coordinates, approval.item.id, "public-baseline", input);
const proposed = await executeProposer(client, coordinates, approval.item.id, "public-candidate", { ...input, program: candidate });
const replay = await executeProposer(client, coordinates, approval.item.id, "public-candidate", { ...input, program: candidate });
const jobs = await listProcessJobs(client); const after = snapshot(source);
if (after !== before || replay.digest !== proposed.digest || jobs.length !== 2) throw new Error("public validation drift");
const result = { format: "pm-rl/proposer-public-validation/1", items: items.length, terminal_items: terminal, source_unchanged: before === after, source_digest: before, non_git: true, baseline: baseline.instructions, candidate: proposed.instructions, behavior_changed: baseline.digest !== proposed.digest, process_jobs: jobs.length, replay_new_jobs: 0, optimizer_updates: 0, inference_tokens: 0, elapsed_ms: Math.ceil(performance.now()-start), measured_compute_ms: jobs.reduce((sum,job)=>sum+job.charge.compute_units,0), measured_wall_ms: jobs.reduce((sum,job)=>sum+job.charge.wall_ms,0), measured_storage_bytes: jobs.reduce((sum,job)=>sum+job.charge.storage_bytes,0), promotions: 0, limitation: "Development-count execution and replay validation; no held-out quality claim." };
writeFileSync(evidence,JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result));
