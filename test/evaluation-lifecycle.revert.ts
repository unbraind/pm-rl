/** Behavioral revert proofs in a disposable source copy; the reviewed checkout is never mutated. */
import assert from "node:assert/strict";
import { proveRevert, type ProofResult } from "./fixtures/causal-proof.ts";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { refuseChangedReceipt } from "./fixtures/revert-receipt.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** One observed behavioral failure and its passing restoration. */
interface RevertProof { function: string; test: string; reverted: ProofResult; restored: ProofResult }
const repository = resolve(".");
// A git checkout tracks the receipt, so never overwrite uncommitted edits; disposable source copies have no tracked receipt.
if (existsSync(join(repository, ".git"))) refuseChangedReceipt(repository, "docs/evaluation-lifecycle-revert.json");
const root = mkdtempSync(join(tmpdir(), "rl-causal-revert-"));
try {
  for (const file of readdirSync(repository)) if (file.endsWith(".ts") || file === "package.json") cpSync(join(repository, file), join(root, file));
  for (const directory of ["test", "scripts", "examples"]) cpSync(join(repository, directory), join(root, directory), { recursive: true });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  const cases = [
    { code: "ERR_ASSERTION", file: "evaluation-lifecycle.ts", expected: /Missing expected rejection/, name: "registerGenerationSnapshot sealed birth", pattern: "causal candidate retries", before: '["id", "type", "affected_version", "fixed_version", "component", "environment", "created_at"]', after: '["id", "type", "affected_version", "component", "environment", "created_at"]' },
    { code: "eval_plan_late", file: "evaluation-plan.ts", expected: /^Evaluation plan refused \(eval_plan_late\)/, name: "validateEvaluationOrder", pattern: "permit equal clocks", before: '  if (plan?.ordering === "causal/1") return validateCausalEvaluationOrder(client, plan, artifacts, prospective);', after: "  void plan; // Revert causal dispatch to the original timestamp validator." },
    { code: "ERR_ASSERTION", file: "evaluation-lifecycle.ts", expected: /Missing expected rejection/, name: "validateCausalEvaluationOrder", pattern: "every cross-stage inversion", before: '    if (entry.witness.comparison !== comparison || entry.witness.stage !== entry.stage || JSON.stringify(entry.witness.predecessors) !== JSON.stringify(references(entries, entry.stage, digests))) refuse("eval_plan_late", entry.id);', after: "    void entry; void comparison; // Revert the causal precedence checks." },
    { code: "ERR_TEST_FAILURE", file: "evaluation-lifecycle.ts", expected: /already exists|already_exists|identity_collision|item_exists/, name: "createCausalEvaluationArtifact", pattern: "shared across OS processes", before: '  if (existing !== null) {', after: '  if (false && existing !== null) { // Revert replay adoption to unconditional native create.' },
    { code: "ERR_ASSERTION", file: "evaluation-lifecycle.ts", expected: /Missing expected rejection/, name: "verifyCausalEvaluationRetry", pattern: "configuration-hash drift", before: '["id", "type", "affected_version", "fixed_version", "component", "environment", "created_at"]', after: '["id", "type", "affected_version", "component", "environment", "created_at"]' },
    { code: "ERR_ASSERTION", file: "evaluation-plan.ts", expected: /Missing expected exception/, name: "parseEvaluationPlan", pattern: "causal schema refuses", before: '  if (orderingKeys.length > 0 && (p.ordering !== "causal/1" || !sequential)) refuse("eval_plan_invalid");', after: '  void orderingKeys; // Revert protocol admission checks.' },
    { code: "eval_plan_evidence", file: "evaluation-lifecycle.ts", expected: /^Evaluation plan refused \(eval_plan_evidence\)/, name: "createCausalEvaluationArtifact", pattern: "CLI approval", before: '  return createVerifiedItem(client, { ...options, note: [...(options.note ?? []), `${PREFIX}${encodeBoundedJson(witness)}`] });', after: '  return createVerifiedItem(client, options); // Revert atomic witness publication.' },
    { code: "ERR_ASSERTION", file: "evaluation-lifecycle.ts", expected: /Every predecessor birth must be hashed once per validation/, name: "validateCausalEvaluationOrder", pattern: "hashes each birth", before: 'references(entries, entry.stage, digests)', after: 'references(entries, entry.stage)' },
    { code: "ERR_ASSERTION", file: "test/fixtures/causal-proof.ts", testFile: "test/evaluation-lifecycle-proof.test.ts", expected: /Missing expected exception/, name: "validateProofRun failure admission", pattern: "proof rejects worker timeouts", before: "    assert.doesNotMatch(error, /^(?:Worker [^\\n]*? timed out|SyntaxError|ERR_MODULE_NOT_FOUND)/, \"Runner infrastructure noise is not behavioral evidence\");", after: '    void error; // Revert infrastructure-failure exclusion.' },
    { code: "ERR_ASSERTION", file: "test/fixtures/causal-proof.ts", testFile: "test/evaluation-lifecycle-proof.test.ts", expected: /Expected values to be strictly equal/, name: "validateProofRun measured counts", pattern: "proof records measured counts", before: 'const result: ProofResult = { pass: count("pass"), fail: count("fail") };', after: 'const result: ProofResult = { pass: expectedFailure === undefined ? 1 : 0, fail: expectedFailure === undefined ? 0 : 1 };' },
    { code: "ERR_ASSERTION", file: "evaluation-lifecycle.ts", expected: /Every native birth must be read once per causal operation/, name: "createCausalEvaluationArtifact validated birth reuse", pattern: "causal operations read", before: '  const { entries, digests } = await validatedEntries(client, plan, predecessors);', after: '  await validateCausalEvaluationOrder(client, plan, predecessors);\n  const { entries, digests } = await validatedEntries(client, plan, predecessors);' },
    { code: "ERR_ASSERTION", file: "test/fixtures/causal-proof.ts", testFile: "test/evaluation-lifecycle-proof.test.ts", expected: /Missing expected exception/, name: "validateProofRun diagnostic matching", pattern: "proof records measured counts", before: 'const matched = expectedFailure.exec(error)?.[0];', after: 'const matched = expectedFailure.source;' },
    { code: "ERR_ASSERTION", file: "evaluation-lifecycle.ts", expected: /Every native birth must be read once per causal operation/, name: "verifyCausalEvaluationRetry validated birth reuse", pattern: "causal operations read", before: '  const birth = entries.find(entry => entry.id === options.id) ?? await witnessedBirth(client, options.id);', after: '  const birth = await witnessedBirth(client, options.id);' },
    { code: "ERR_ASSERTION", file: "test/fixtures/causal-proof.ts", testFile: "test/evaluation-lifecycle-proof.test.ts", expected: /Refused proof must restore the implementation/, name: "proveRevert restoration on refusal", pattern: "every proof producer", before: '} finally { writeFileSync(join(root, sourceFile), fixed); }', after: '} finally { /* Revert restoration after refused proof. */ }' },
    { code: "ERR_ASSERTION", file: "evaluation-lifecycle.ts", expected: /Missing expected rejection/, name: "validatedEntries live sealed state", pattern: "live collection drift", before: '    await verifySealedBirth(client, entry);', after: '    void entry; // Revert live predecessor identity validation.' },
    { code: "ERR_ASSERTION", file: "evaluation-plan.ts", expected: /Missing expected rejection/, name: "validateEvaluationIdentities canonical slots", pattern: "canonical identity collisions", before: '  if (new Set(identities).size !== identities.length) refuse("eval_plan_invalid");', after: '  void identities; // Revert canonical identity admission at write boundaries.' },
    { code: "ERR_ASSERTION", file: "test/evaluation-lifecycle.revert.ts", testFile: "test/evaluation-lifecycle-proof.test.ts", expected: /Selected receipts must contain only freshly measured results/, name: "selected receipt evidence isolation", pattern: "selected revert receipts", before: '  const results: RevertProof[] = ' + '[]; // Selected receipts contain only evidence measured by this run.', after: '  const results: RevertProof[] = selected.length === 0 ? [] : (JSON.parse(readFileSync("docs/evaluation-lifecycle-revert.json", "utf8")) as { tests: RevertProof[] }).tests;' },
  ];
  for (const pattern of [
    ...["decision", "reason", "nested field", "added field", "removed field", "removed verdict", "null verdict"].map(field => `causal birth verdict rejects SDK ${field} tamper`),
    "causal birth verdict rejects checkpoint publication after refuse to promote tamper",
    ...["SDK", "CLI"].map(path => `causal birth verdict rejects CLI body tamper on ${path} replay`),
  ]) cases.push({ code: "ERR_ASSERTION", file: "evaluation-lifecycle.ts", testFile: "test/evaluation-lifecycle-verdict.test.ts", expected: /Missing expected rejection/, name: "verifySealedBirth birth verdict", pattern,
    before: '  if (birth.item.type === "Generation") await verifyStoredEvaluation(client, birth.item, sealed.evaluation, current.evaluation);', after: "" });
  for (const pattern of [
    ...["SDK promote", "CLI promote", "SDK removal"].flatMap(tamper => ["validation", "SDK replay", "CLI replay", "append"].map(consumer => `causal write-once verdict rejects ${tamper} through ${consumer}`)),
    "causal write-once verdict rejects a changed post-birth reason",
    "causal write-once verdict rejects a historical tamper after the current value is restored",
    "causal write-once verdict rejects a changed post-birth verdict on native retry verification",
  ]) cases.push({ code: "ERR_ASSERTION", file: "evaluation-lifecycle.ts", testFile: "test/evaluation-lifecycle-verdict.test.ts", expected: /Missing expected rejection/, name: "verifySealedBirth first native verdict", pattern,
    before: '  if (birth.item.type === "Generation") await verifyStoredEvaluation(client, birth.item, sealed.evaluation, current.evaluation);', after: "" });
  cases.push({ code: "ERR_ASSERTION", file: "test/evaluation-lifecycle.test.ts", testFile: "test/evaluation-lifecycle.test.ts", expected: /Clean worker exit must reject committed/, name: "worker early clean exit", pattern: "causal IPC rejects a clean worker exit between ready and committed",
    before: 'reject(new Error(`Worker ${step} exited before ${state} (code ${String(code)}): ${stderr}`));', after: 'if (code !== 0) reject(new Error(`Worker ${step} exited before ${state} (code ${String(code)}): ${stderr}`));' });
  const selected = process.argv.slice(2);
  assert.ok(selected.every(pattern => cases.some(entry => entry.pattern === pattern)), "Unknown proof selector");
  const results: RevertProof[] = []; // Selected receipts contain only evidence measured by this run.
  for (const entry of cases.filter(entry => selected.length === 0 || selected.includes(entry.pattern))) {
    const source = readFileSync(join(repository, entry.file), "utf8");
    // A self-revert selector also contains its needle as data; mutate the implementation after it.
    const offset = source.lastIndexOf(entry.before);
    assert.ok(offset >= 0);
    const mutant = source.slice(0, offset) + entry.after + source.slice(offset + entry.before.length);
    const { reverted, restored } = proveRevert(root, entry.file, source, mutant, entry.testFile ?? "test/evaluation-lifecycle.test.ts", entry.pattern, entry.expected, entry.code);
    const previous = results.findIndex(result => result.test === entry.pattern && result.function === entry.name);
    if (previous !== -1) results.splice(previous, 1);
    results.push({ function: entry.name, test: entry.pattern, reverted, restored });
    process.stdout.write(`${entry.name}: behavioural failure on revert; restoration passes\n`);
  }
  writeFileSync("docs/evaluation-lifecycle-revert.json", JSON.stringify({ format: "pm-rl/evaluation-lifecycle-revert/1", isolated_copy: true, complete: selected.length === 0, selection: selected, tests: results }, null, 2) + "\n");
} finally { rmSync(root, { recursive: true, force: true }); }
