/** Sealed, dependency-free proposal interpreter: no paths, code, evaluation rows or IO capabilities. */
import { hashJson, type JsonValue } from "./json-identity.ts";

/** Stable refusal for the single program and wire schema; only producer-authored guidance belongs in diagnostics. */
export class ProposerRefusal extends Error {
  /** Machine-readable refusal shared by SDK and CLI. */
  readonly code = "proposer_invalid";
  /** A fresh valid declaration is required before any reservation or effect. */
  readonly remedy: string;
  /** Construct a refusal from static producer-authored correction guidance. */
  constructor(remedy = "Supply a sealed bounded proposer program and development-only counts; retain prior evidence.") { super(`proposer_invalid: ${remedy}`); this.remedy = remedy; }
}
/** Arithmetic on development counts only; fifteen nodes and depth four cap interpretation. */
export type ProposalExpression = { readonly op: "rate" } | { readonly op: "novelty" } | { readonly op: "zero" } | { readonly op: "add" | "multiply"; readonly left: ProposalExpression; readonly right: ProposalExpression };
/** Four typed capabilities change the algorithm, feature construction and curriculum without host code. */
export interface ProposalCode {
  readonly score: ProposalExpression;
  readonly select: "cycle" | "rank";
  readonly feature: "inherit" | "events" | "words" | "timing";
  readonly order: 1 | 2 | 3;
  readonly curriculum: "seeded" | "reverse" | "balanced";
}
/** A content-addressed executable artifact with explicit immutable ancestry. */
export interface ProposerProgram { readonly format: "pm-rl/proposer-program/1"; readonly generation: number; readonly parent: string | null; readonly code: ProposalCode; readonly digest: string }
/** Counts belong exclusively to completed development fits; all eight recipe arms are explicit. */
export interface ProposalCounts { readonly arm: number; readonly wins: number; readonly trials: number }
/** The complete worker capability: no dataset coordinates, tracker handles or evaluation outcomes. */
export interface ProposalInvocation { readonly program: ProposerProgram; readonly role: "development"; readonly counts: readonly ProposalCounts[]; readonly seed: number; readonly count: number }
/** A small recipe instruction, interpreted by the existing learner and recipe APIs. */
export interface ProposalInstruction { readonly arm: number; readonly feature: ProposalCode["feature"]; readonly order: 1 | 2 | 3; readonly curriculum: ProposalCode["curriculum"] }
/** Content identity binds emitted instructions; metadata is excluded from behavioral identity. */
export interface ProposalExecution { readonly digest: string; readonly instructions: readonly ProposalInstruction[] }

/** Refuse invalid values before serialization can erase sparse arrays, infinities or extra fields. */
function requireValue(condition: boolean): asserts condition { if (!condition) throw new ProposerRefusal(); }
/** The sole strict object boundary, also used by every producer and worker decoder. */
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  requireValue(Object.keys(record).sort().join("|") === [...keys].sort().join("|"));
  return record;
}
/** Bound a safe integral domain without coercion. */
function integer(value: unknown, minimum: number, maximum: number): number { requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum); return value; }
/** Restrict a capability to the declared literal grammar. */
function choice<T extends string>(value: unknown, allowed: readonly T[]): T { requireValue(typeof value === "string" && allowed.includes(value as T)); return value as T; }
/** Parse an expression once, bounding all recursion before any interpreter operation. */
function expression(value: unknown, depth: number): ProposalExpression {
  requireValue(depth <= 4);
  const op = (value as { op?: unknown } | null)?.op;
  if (op === "add" || op === "multiply") {
    const row = fields(value, ["op", "left", "right"]);
    return { op, left: expression(row.left, depth + 1), right: expression(row.right, depth + 1) };
  }
  return { op: choice(fields(value, ["op"]).op, ["rate", "novelty", "zero"]) };
}
/** Normalize the executable grammar through the same parser used for emitted artifacts. */
export function parseProposalCode(value: unknown): ProposalCode {
  const row = fields(value, ["score", "select", "feature", "order", "curriculum"]);
  return { score: expression(row.score, 1), select: choice(row.select, ["cycle", "rank"]), feature: choice(row.feature, ["inherit", "events", "words", "timing"]),
    order: integer(row.order, 1, 3) as 1 | 2 | 3, curriculum: choice(row.curriculum, ["seeded", "reverse", "balanced"]) };
}
/** Address only canonical schema output, making JSON key order and CRLF irrelevant. */
export function proposerArtifact(code: ProposalCode, generation = 1, parent: string | null = null): ProposerProgram {
  integer(generation, 1, 100);
  requireValue(generation === 1 ? parent === null : typeof parent === "string" && /^sha256:[a-f0-9]{64}$/.test(parent));
  const record = { format: "pm-rl/proposer-program/1" as const, generation, parent, code: parseProposalCode(code) };
  return { ...record, digest: `sha256:${hashJson(record as unknown as JsonValue)}` };
}
/** Reject altered identities and undeclared fields, including evaluation capabilities and metadata. */
export function parseProposerProgram(value: unknown): ProposerProgram {
  const row = fields(value, ["format", "generation", "parent", "code", "digest"]);
  requireValue(row.format === "pm-rl/proposer-program/1");
  const artifact = proposerArtifact(row.code as ProposalCode, integer(row.generation, 1, 100), row.parent as string | null);
  requireValue(row.digest === artifact.digest); return artifact;
}
/** The initial executable enumerates recipes, without ranking by development outcomes. */
export function initialProposer(): ProposerProgram { return proposerArtifact({ score: { op: "zero" }, select: "cycle", feature: "inherit", order: 1, curriculum: "seeded" }); }
/** One strict schema for both in-process validation and the isolated worker's stdin. */
export function parseProposalInvocation(value: unknown): ProposalInvocation {
  const row = fields(value, ["program", "role", "counts", "seed", "count"]);
  requireValue(row.role === "development" && Array.isArray(row.counts) && row.counts.length === 8);
  const counts = Array.from(row.counts as unknown[], (value, arm) => {
    const count = fields(value, ["arm", "wins", "trials"]);
    requireValue(count.arm === arm);
    const trials = integer(count.trials, 0, 1_000_000);
    return { arm, wins: integer(count.wins, 0, trials), trials };
  });
  return { program: parseProposerProgram(row.program), role: "development", counts, seed: integer(row.seed, 0, 0xffff_ffff), count: integer(row.count, 1, 8) };
}
/** Exact rational scores keep count-derived decisions independent of floating point rounding. */
function score(node: ProposalExpression, count: ProposalCounts): readonly [bigint, bigint] {
  if (node.op === "zero") return [0n, 1n];
  if (node.op === "rate") return [BigInt(count.wins), BigInt(Math.max(1, count.trials))];
  if (node.op === "novelty") return [1n, BigInt(count.trials + 1)];
  const [a, b] = score(node.left, count); const [c, d] = score(node.right, count);
  return [node.op === "add" ? a * d + c * b : a * c, b * d];
}
/** Interpret the fixed-depth AST with no IO; at most eight scores and eight proposals are emitted. */
export function executeProposal(value: unknown): ProposalExecution {
  const { program, counts, seed, count } = parseProposalInvocation(value);
  const ordered = counts.map((row, index) => ({ row, tie: (index + 8 - seed % 8) % 8, score: score(program.code.score, row) }));
  ordered.sort((a, b) => {
    const delta = a.score[0] * b.score[1] - b.score[0] * a.score[1];
    return program.code.select === "cycle" || delta === 0n ? a.tie - b.tie : delta > 0n ? -1 : 1;
  });
  const { feature, order, curriculum } = program.code;
  const instructions = ordered.slice(0, count).map(({ row }) => ({ arm: row.arm, feature, order, curriculum }));
  return { instructions, digest: `sha256:${hashJson(instructions as unknown as JsonValue)}` };
}
/** Verify every emitted field by deterministic replay of the very same bounded interpreter. */
export function verifyProposalExecution(value: unknown, invocation: ProposalInvocation): ProposalExecution {
  const row = fields(value, ["digest", "instructions"]); const expected = executeProposal(invocation);
  requireValue(Array.isArray(row.instructions) && row.instructions.length === invocation.count);
  const instructions = Array.from(row.instructions as unknown[], parseProposalInstruction);
  requireValue(row.digest === expected.digest && hashJson(instructions as unknown as JsonValue) === hashJson(expected.instructions as unknown as JsonValue)); return expected;
}
/** Apply the emitted-instruction schema to public callers and process output alike. */
export function parseProposalInstruction(value: unknown): ProposalInstruction {
  const row = fields(value, ["arm", "feature", "order", "curriculum"]);
  return { arm: integer(row.arm, 0, 7), feature: choice(row.feature, ["inherit", "events", "words", "timing"]), order: integer(row.order, 1, 3) as 1 | 2 | 3, curriculum: choice(row.curriculum, ["seeded", "reverse", "balanced"]) };
}
/** Mutate executable structure from development success counts, never outer evaluation feedback. */
export function mutateProposer(value: ProposalInvocation): ProposerProgram {
  const input = parseProposalInvocation(value); const { program, counts } = input;
  requireValue(counts.some((row) => row.trials > 0));
  const explored = counts.every((row) => row.trials > 0);
  const expression: ProposalExpression = explored ? { op: "rate" } : { op: "add", left: { op: "rate" }, right: { op: "novelty" } };
  const best = executeProposal({ ...input, program: proposerArtifact({ ...program.code, select: "rank", score: expression }) }).instructions[0].arm;
  const feature = (["inherit", "events", "words", "timing"] as const)[Math.floor(best / 2)];
  return proposerArtifact({ score: expression, select: "rank", feature, order: feature === "events" ? 3 : 1, curriculum: explored ? "balanced" : "reverse" }, program.generation + 1, program.digest);
}
