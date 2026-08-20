/**
 * @module pm-rl/leaderboard
 *
 * Pure benchmark and leaderboard contracts. Tracker reads, graph validation,
 * and typed refusals stay in the command adapter; deterministic ranking and
 * rendering live here so they can be tested without weakening the real SDK
 * acceptance tests.
 */

import { Buffer } from "node:buffer";

import type { JsonValue } from "./index.ts";

/** Score direction declared by one immutable benchmark version. */
export type BenchmarkDirection = "maximize" | "minimize";

/** Immutable benchmark suite stored in a content-addressed Benchmark item. */
export interface BenchmarkSpec {
  /** Human-readable benchmark family. */
  readonly name: string;
  /** Version whose task and scoring behavior is immutable. */
  readonly version: string;
  /** Tasks evaluated by this benchmark version. */
  readonly task_suite: JsonValue;
  /** Exact scoring procedure or declarative scoring contract. */
  readonly scoring_function: JsonValue;
  /** Exact rule used to decide whether an evaluation passed. */
  readonly pass_criteria: JsonValue;
  /** Whether larger or smaller scores rank first. */
  readonly direction: BenchmarkDirection;
  /** Environment versions known to overlap this suite's evaluation data. */
  readonly contaminated_environments: string[];
  /** Additional authored benchmark metadata retained in its content identity. */
  readonly [key: string]: JsonValue;
}

/** Immutable evidence stored in one EvalResult item. */
export interface EvalResultSpec {
  /** Content identity of the policy/model artifact evaluated. */
  readonly checkpoint: string;
  /** Finite scalar emitted by the benchmark's scoring function. */
  readonly score: number;
  /** Verdict produced by applying the benchmark's pass criteria. */
  readonly passed: boolean;
  /** Run whose training provenance produced the checkpoint. */
  readonly run_id: string;
  /** Exact benchmark version that produced the verdict. */
  readonly benchmark_id: string;
  /** Exact environment version under which the source run trained. */
  readonly environment_id: string;
  /** Content identity of the complete source environment specification. */
  readonly environment_spec_hash: string;
  /** Content identity of only the source environment's reward specification. */
  readonly reward_spec_hash: string;
}

/** One fully traced row before ranking. */
export interface LeaderboardCandidate extends EvalResultSpec {
  /** EvalResult item whose graph and immutable body supplied this row. */
  readonly eval_id: string;
}

/** One stable leaderboard row with a one-based position. */
export interface LeaderboardRow extends LeaderboardCandidate {
  /** Deterministic one-based position after direction-aware ordering. */
  readonly rank: number;
}

/**
 * Rank comparable evaluation rows using score direction and byte-order ids.
 *
 * IDs are the deterministic tie-breaker because score equality alone does not
 * define a total order. Byte order is locale independent, so two agents produce
 * the same ranks regardless of host language settings.
 */
export function rankLeaderboard(direction: BenchmarkDirection, candidates: readonly LeaderboardCandidate[]): LeaderboardRow[] {
  return [...candidates]
    .sort((left, right) => {
      const scoreOrder = direction === "maximize" ? right.score - left.score : left.score - right.score;
      return scoreOrder === 0 ? Buffer.compare(Buffer.from(left.eval_id), Buffer.from(right.eval_id)) : scoreOrder;
    })
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/** Render a compact table that retains every provenance field needed to audit a rank. */
export function renderLeaderboard(benchmarkId: string, benchmark: BenchmarkSpec, rows: readonly LeaderboardRow[]): string {
  const lines = [
    `${benchmark.name} ${benchmark.version} (${benchmarkId}, ${benchmark.direction}) — ${rows.length} result(s)`,
    "rank | score | pass | checkpoint | eval | run | environment | environment spec | reward spec",
  ];
  for (const row of rows) {
    lines.push(`${row.rank} | ${row.score} | ${row.passed ? "yes" : "no"} | ${row.checkpoint} | ${row.eval_id} | ${row.run_id} | ${row.environment_id} | ${row.environment_spec_hash} | ${row.reward_spec_hash}`);
  }
  return lines.join("\n");
}
