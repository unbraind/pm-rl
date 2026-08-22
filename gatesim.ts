/**
 * @module pm-rl/gatesim
 *
 * The fleet's own mandatory gates as the first sim-to-RL environment.
 *
 * An agent proposes a diff to a pm package, and the package's mandatory gates
 * decide whether it passed. This module holds the pure contracts for that loop:
 * the gate-environment specification (which pins the repository commit, the gate
 * command set and the verdict extraction), the recorded episode (whose
 * content-addressed candidate-tree identity names exactly what was judged), and
 * the paired-cohort sim-to-real gap (sandbox gate-pass rate against real merge
 * rate over candidates present on both sides).
 *
 * pm-rl runs no gate command. The caller executes the gates outside pm-rl and
 * records the per-gate results; replay re-derives the verdict from fresh results
 * over the same resolved artifact, so an episode whose verdict no longer
 * reproduces is caught at replay time rather than trusted forever.
 *
 * The functions in this module are pure: they validate, compute, and render.
 * The command handlers in {@link ./index.ts} resolve tracker items and call them.
 */

import { createPmCliExpectedError, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

import type { JsonValue } from "./index.ts";

/** One mandatory gate: its stable name and the command whose exit decides it. */
export interface GateDefinition {
  /** Stable gate name used by recorded results to address this gate. */
  readonly name: string;
  /** The command a sandbox run executes; pinned so the environment names what was judged. */
  readonly command: string;
}

/** Verdict extraction rule: pass only when every declared gate exits zero. */
export type VerdictRule = "all_exit_zero";

/** A gate-simulator environment stored as a content-addressed Environment item. */
export interface GateEnvironmentSpec {
  /** Human-readable environment family name. */
  readonly name: string;
  /** Version being registered; changed gates or commands require a new version. */
  readonly version: string;
  /** Repository the gates run against, e.g. `unbraind/pm-rl`. */
  readonly repository: string;
  /** Base commit the environment pins; identifies the base tree the action diffs against. */
  readonly commit: string;
  /** The mandatory gate set, in authored order; identities are the names. */
  readonly gates: readonly GateDefinition[];
  /** How raw gate results become a verdict; pinned at registration. */
  readonly verdict_extraction: { readonly rule: VerdictRule };
}

/** One recorded gate outcome addressed by the environment's declared gate name. */
export interface GateResultEntry {
  /** Declared gate name this result belongs to. */
  readonly name: string;
  /** The gate command's process exit code. */
  readonly exit_code: number;
}

/** Every parsed gate result for one episode, ready for verdict extraction. */
export type GateResults = readonly GateResultEntry[];

/** Extracted episode verdict under the environment's pinned rule. */
export type EpisodeVerdict = "pass" | "fail";

/**
 * One recorded sandbox episode, stored as a JSON fence in a GateEpisode body.
 *
 * `candidate_tree` or `patch_hash` names the exact artifact that was judged — a
 * git tree id, or the content hash of the patch producing it — because the base
 * commit alone identifies only the tree the action started from.
 */
export interface EpisodeSpec {
  /** Content-addressed Environment item id the episode ran under. */
  readonly environment_id: string;
  /** Content identity of that environment's specification at episode time. */
  readonly environment_spec_hash: string;
  /** Repository the gates ran against, copied from the environment. */
  readonly repository: string;
  /** Base commit the episode's action diffed against. */
  readonly base_commit: string;
  /** Git tree id of the judged candidate tree, or null when only a patch was recorded. */
  readonly candidate_tree: string | null;
  /** SHA-256 of the judged patch text, or null when only a tree id was recorded. */
  readonly patch_hash: string | null;
  /** Per-gate results the verdict was extracted from, sorted by gate name. */
  readonly gate_results: GateResults;
  /** The extracted verdict at record time. */
  readonly verdict: EpisodeVerdict;
  /** Stable link to the pull request this episode corresponds to. */
  readonly pull_request: string;
}

/** One real-side pull-request result, stored as a JSON fence in a MergeOutcome body. */
export interface OutcomeSpec {
  /** Stable link matching the linked episode's `pull_request` exactly. */
  readonly pull_request: string;
  /** Whether the pull request actually merged. */
  readonly merged: boolean;
}

/** One paired-cohort measurement with every denominator stated. */
export interface PairedCohortReport {
  /** Distinct pull requests present on both sides; the real side's denominator. */
  readonly pull_requests: number;
  /** Episodes whose pull request is paired; the sandbox side's denominator. */
  readonly episodes: number;
  /** Paired episodes whose extracted verdict was pass. */
  readonly sandbox_passes: number;
  /** `sandbox_passes / episodes`, or null when nothing is paired. */
  readonly sandbox_pass_rate: number | null;
  /** Paired pull requests that actually merged. */
  readonly merged_pull_requests: number;
  /** `merged_pull_requests / pull_requests`, or null when nothing is paired. */
  readonly merge_rate: number | null;
  /** Sandbox pass rate minus real merge rate, or null when either rate is undefined. */
  readonly gap: number | null;
}

/** A complete sim-to-real report: one paired cohort plus both unpaired sides. */
export interface SimRealGapReport {
  /** The paired cohort with denominators stated. */
  readonly paired: PairedCohortReport;
  /** Episodes whose pull request has no recorded outcome; coverage, not rate. */
  readonly unpaired_episodes: ReadonlyArray<{ id: string; pull_request: string }>;
  /** Outcomes whose pull request has no recorded episode; coverage, not rate. */
  readonly unpaired_outcomes: ReadonlyArray<{ id: string; pull_request: string }>;
}

/** Throw an expected command error with stable machine context. */
function gatesimFail(message: string, code: string, exitCode: number = EXIT_CODE.USAGE): never {
  throw createPmCliExpectedError(message, { exitCode, context: { code } });
}

/** Narrow a parsed value to a JSON object record. */
function asObject(value: unknown, source: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    gatesimFail(`${source} must contain one JSON object.`, "invalid_json_object");
  }
  return value as Record<string, unknown>;
}

/** Require a non-empty trimmed string field, refusing anything else. */
function requiredString(record: Record<string, unknown>, key: string, source: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    gatesimFail(`${source} requires a non-empty string ${key}.`, `invalid_gate_environment_${key}`);
  }
  return value.trim();
}

/**
 * Parse and validate a gate-environment specification.
 *
 * The specification pins everything a verdict depends on: which repository and
 * commit the gates ran against, which commands are mandatory, and how raw
 * results become a verdict. It is content-addressed like every other pm-rl
 * environment by the caller, so any later change to these fields registers as a
 * new version instead of silently re-judging candidates under different rules.
 *
 * @param text - The JSON text of the environment specification.
 * @param source - Human-readable label naming the source being parsed.
 * @returns The validated specification.
 * @throws When the text is not one JSON object, a pinned field is absent or
 *   blank, the commit is not a hex sha, the gate set is empty or has duplicate
 *   names, or the verdict rule is not the supported one.
 */
export function parseGateEnvironmentSpec(text: string, source: string): GateEnvironmentSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    gatesimFail(`${source} is not valid JSON.`, "invalid_gate_environment_json");
  }
  const record = asObject(parsed, source);
  const name = requiredString(record, "name", source);
  const version = requiredString(record, "version", source);
  const repository = requiredString(record, "repository", source);
  const commit = requiredString(record, "commit", source);
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    gatesimFail(`${source} commit must be a hex git commit sha, got "${commit}".`, "invalid_commit");
  }
  const gatesRaw = record["gates"];
  if (!Array.isArray(gatesRaw) || gatesRaw.length === 0) {
    gatesimFail(`${source} requires a gates array with at least one gate.`, "invalid_gates");
  }
  const seen = new Set<string>();
  const gates: GateDefinition[] = gatesRaw.map((entry) => {
    const gateRecord = asObject(entry, `${source} gate`);
    const gateName = requiredString(gateRecord, "name", `${source} gate`);
    const command = requiredString(gateRecord, "command", `${source} gate`);
    if (seen.has(gateName)) {
      gatesimFail(`${source} requires unique gate names; "${gateName}" appears twice.`, "duplicate_gate_name");
    }
    seen.add(gateName);
    return { name: gateName, command };
  });
  const extractionRaw = record["verdict_extraction"];
  if (extractionRaw === null || typeof extractionRaw !== "object" || Array.isArray(extractionRaw)) {
    gatesimFail(`${source} requires a verdict_extraction object.`, "invalid_verdict_extraction");
  }
  const rule = (extractionRaw as Record<string, unknown>)["rule"];
  if (rule !== "all_exit_zero") {
    gatesimFail(`${source} verdict_extraction must declare the rule "all_exit_zero"; "${String(rule)}" is not a supported extraction.`, "invalid_verdict_rule");
  }
  return { name, version, repository, commit, gates, verdict_extraction: { rule } };
}

/**
 * Parse raw gate results against a gate environment's declared gate set.
 *
 * Results are addressed by declared gate name: an undeclared name means the
 * caller ran something the environment never mandated, and a missing name means
 * a mandatory gate produced no result. Both leave the verdict undecidable and
 * are refused rather than defaulted, because defaulting either direction can
 * manufacture a pass.
 *
 * @param text - The JSON text of the results document.
 * @param source - Human-readable label naming the source being parsed.
 * @param spec - The gate environment whose declared gates the results answer to.
 * @returns The parsed results, sorted by gate name for canonical storage.
 * @throws When the text is not one JSON object with a gates array of named
 *   integer exit codes covering exactly the declared gate set.
 */
export function parseGateResults(text: string, source: string, spec: GateEnvironmentSpec): GateResults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    gatesimFail(`${source} is not valid JSON.`, "invalid_gate_results");
  }
  const record = asObject(parsed, source);
  const entriesRaw = record["gates"];
  if (!Array.isArray(entriesRaw)) {
    gatesimFail(`${source} requires a gates array.`, "invalid_gate_results");
  }
  const byName = new Map<string, number>();
  for (const entry of entriesRaw) {
    const entryRecord = asObject(entry, `${source} gate result`);
    const name = entryRecord["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      gatesimFail(`${source} gate result requires a non-empty string name.`, "invalid_gate_results");
    }
    if (byName.has(name)) {
      gatesimFail(`${source} reports gate "${name}" twice.`, "duplicate_gate_result");
    }
    if (!spec.gates.some((gate) => gate.name === name)) {
      gatesimFail(`${source} reports undeclared gate "${name}", which the environment ${spec.name} ${spec.version} never mandated.`, "unknown_gate_result", EXIT_CODE.CONFLICT);
    }
    const exitCode = entryRecord["exit_code"];
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
      gatesimFail(`${source} gate "${name}" requires an integer exit_code.`, "invalid_gate_results");
    }
    byName.set(name, exitCode);
  }
  for (const gate of spec.gates) {
    if (!byName.has(gate.name)) {
      gatesimFail(`${source} is missing a result for declared gate "${gate.name}".`, "missing_gate_result", EXIT_CODE.CONFLICT);
    }
  }
  return [...byName.entries()].map(([name, exit_code]) => ({ name, exit_code })).sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Extract an episode verdict under the environment's pinned rule.
 *
 * The fleet's mandatory gates all decide the reward, so the supported rule is
 * `all_exit_zero`: the verdict passes only when every declared gate exited zero.
 *
 * @param results - Complete results for every declared gate.
 * @returns `"pass"` when every gate exited zero, otherwise `"fail"`.
 */
export function deriveVerdict(results: GateResults): EpisodeVerdict {
  return results.every((entry) => entry.exit_code === 0) ? "pass" : "fail";
}

/** Credential-shaped patterns, each named for the refusal message. */
const CREDENTIAL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "a GitHub CLI token (ghp_/gho_/ghu_/ghs_/ghr_)", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/ },
  { name: "a GitHub fine-grained personal access token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "a URL carrying embedded userinfo credentials", pattern: /:\/\/[^\s/:@]+:[^\s/@]+@/ },
  { name: "a private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "an AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "an assigned secret literal", pattern: /\b(?:api[_-]?key|secret|password|passwd|token|authorization)\b\s*[:=]\s*["'][^"']{6,}["']/i },
];

/**
 * Refuse caller-supplied free text that captures repository credentials.
 *
 * Episodes are tracked programme data: they are committed, merged, and read by
 * every agent in the fleet, so no field of one may carry a token, an embedded
 * userinfo URL, a private key, or an assigned secret literal. The scan is a
 * refusal, not a redaction — pm-rl does not guess how much of a captured secret
 * is safe to keep.
 *
 * @param label - Human-readable name of the scanned field, for the refusal.
 * @param text - The field's full text.
 * @throws {credential_detected} Naming the field and the credential shape found,
 *   never the secret itself.
 */
export function assertNoCredentials(label: string, text: string): void {
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      gatesimFail(
        `${label} appears to capture ${name}; episodes must never capture repository credentials. Remove the secret and record the link or diff without it.`,
        "credential_detected",
        EXIT_CODE.CONFLICT,
      );
    }
  }
}

/**
 * Parse one stored episode specification from its JSON fence.
 *
 * Both artifact halves are nullable at parse time: a hand-authored body may
 * carry neither, and replay refuses that condition explicitly rather than the
 * parser inventing an identity. Gate results are validated structurally here
 * but are not checked against a declared gate set — the parser has none — so
 * replay re-validates them against the resolved environment.
 *
 * @param text - The JSON text inside the episode's specification fence.
 * @param source - Human-readable label naming the source being parsed.
 * @returns The validated episode specification.
 * @throws When a required provenance field is absent, a nullable field holds a
 *   non-string, gate results are malformed, or the verdict is not pass/fail.
 */
export function parseEpisodeSpec(text: string, source: string): EpisodeSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    gatesimFail(`${source} is not valid JSON.`, "invalid_episode_json", EXIT_CODE.CONFLICT);
  }
  const record = asObject(parsed, source);
  const environmentId = requiredString(record, "environment_id", source);
  const environmentSpecHash = requiredString(record, "environment_spec_hash", source);
  const repository = requiredString(record, "repository", source);
  const baseCommit = requiredString(record, "base_commit", source);
  const optionalIdentity = (key: string): string | null => {
    const value = record[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || value.trim().length === 0) {
      gatesimFail(`${source} requires ${key} to be a non-empty identity or null.`, "invalid_episode_identity", EXIT_CODE.CONFLICT);
    }
    return value.trim();
  };
  const resultsRaw = record["gate_results"];
  if (!Array.isArray(resultsRaw)) {
    gatesimFail(`${source} requires a gate_results array.`, "invalid_episode_results", EXIT_CODE.CONFLICT);
  }
  const gateResults: GateResultEntry[] = resultsRaw.map((entry) => {
    const entryRecord = asObject(entry, `${source} gate result`);
    const name = entryRecord["name"];
    const exitCode = entryRecord["exit_code"];
    if (typeof name !== "string" || name.trim().length === 0 || typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
      gatesimFail(`${source} gate results must be named integer exit codes.`, "invalid_episode_results", EXIT_CODE.CONFLICT);
    }
    return { name: name.trim(), exit_code: exitCode };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const verdict = record["verdict"];
  if (verdict !== "pass" && verdict !== "fail") {
    gatesimFail(`${source} requires a verdict of "pass" or "fail".`, "invalid_episode_verdict", EXIT_CODE.CONFLICT);
  }
  return {
    environment_id: environmentId,
    environment_spec_hash: environmentSpecHash,
    repository,
    base_commit: baseCommit,
    candidate_tree: optionalIdentity("candidate_tree"),
    patch_hash: optionalIdentity("patch_hash"),
    gate_results: gateResults,
    verdict,
    pull_request: requiredString(record, "pull_request", source),
  };
}

/**
 * Parse one stored merge-outcome specification from its JSON fence.
 *
 * @param text - The JSON text inside the outcome's specification fence.
 * @param source - Human-readable label naming the source being parsed.
 * @returns The validated outcome specification.
 * @throws When the pull request link is absent or blank, or merged is absent.
 */
export function parseOutcomeSpec(text: string, source: string): OutcomeSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    gatesimFail(`${source} is not valid JSON.`, "invalid_outcome_json", EXIT_CODE.CONFLICT);
  }
  const record = asObject(parsed, source);
  const merged = record["merged"];
  if (typeof merged !== "boolean") {
    gatesimFail(`${source} requires a boolean merged.`, "invalid_outcome_merged", EXIT_CODE.CONFLICT);
  }
  return { pull_request: requiredString(record, "pull_request", source), merged };
}

/**
 * Compute the sim-to-real gap over the paired cohort.
 *
 * Pairing is by exact pull-request link after trimming. The sandbox side counts
 * EPISODES (a retried PR legitimately contributes each attempt) while the real
 * side counts DISTINCT pull requests, so both denominators are stated rather
 * than one hidden rate. Candidates present on only one side are returned as
 * coverage lists and never enter either denominator — folding them in would let
 * a population difference masquerade as a capability gap.
 *
 * @param episodes - Every recorded episode with its item id.
 * @param outcomes - Every recorded outcome with its item id.
 * @returns The paired-cohort report and both unpaired coverage lists.
 */
export function buildSimRealGap(
  episodes: ReadonlyArray<{ id: string; spec: EpisodeSpec }>,
  outcomes: ReadonlyArray<{ id: string; spec: OutcomeSpec }>,
): SimRealGapReport {
  const outcomeByPr = new Map<string, { ids: string[]; merged: boolean }>();
  for (const { id, spec } of outcomes) {
    const existing = outcomeByPr.get(spec.pull_request);
    if (existing === undefined) {
      outcomeByPr.set(spec.pull_request, { ids: [id], merged: spec.merged });
      continue;
    }
    if (existing.merged !== spec.merged) {
      gatesimFail(
        `Outcomes ${existing.ids.join(", ")} and ${id} disagree about whether ${spec.pull_request} merged, so the real merge rate is undecidable. Record which outcome reflects reality and remove the other.`,
        "outcome_conflict",
        EXIT_CODE.CONFLICT,
      );
    }
    existing.ids.push(id);
  }
  const pairedEpisodes = episodes.filter((episode) => outcomeByPr.has(episode.spec.pull_request));
  const pairedPrs = new Set(pairedEpisodes.map((episode) => episode.spec.pull_request));
  const sandboxPasses = pairedEpisodes.filter((episode) => episode.spec.verdict === "pass").length;
  const mergedPrs = [...pairedPrs].filter((pr) => outcomeByPr.get(pr)!.merged).length;
  const sandboxPassRate = pairedEpisodes.length === 0 ? null : sandboxPasses / pairedEpisodes.length;
  const mergeRate = pairedPrs.size === 0 ? null : mergedPrs / pairedPrs.size;
  return {
    paired: {
      pull_requests: pairedPrs.size,
      episodes: pairedEpisodes.length,
      sandbox_passes: sandboxPasses,
      sandbox_pass_rate: sandboxPassRate,
      merged_pull_requests: mergedPrs,
      merge_rate: mergeRate,
      gap: sandboxPassRate === null || mergeRate === null ? null : sandboxPassRate - mergeRate,
    },
    unpaired_episodes: episodes
      .filter((episode) => !outcomeByPr.has(episode.spec.pull_request))
      .map((episode) => ({ id: episode.id, pull_request: episode.spec.pull_request })),
    unpaired_outcomes: outcomes
      .filter((outcome) => !pairedPrs.has(outcome.spec.pull_request))
      .map((outcome) => ({ id: outcome.id, pull_request: outcome.spec.pull_request })),
  };
}

/**
 * Render a sim-to-real report as stable, diffable text.
 *
 * Every rate prints with its denominator, and both unpaired sides print as
 * coverage counts, so the report can be read without the JSON view beside it.
 *
 * @param report - The computed report.
 * @returns The rendered report text.
 */
export function renderSimRealGap(report: SimRealGapReport): string {
  const lines: string[] = ["sim-to-real gap over the paired cohort"];
  const { paired } = report;
  lines.push(paired.sandbox_pass_rate === null
    ? `sandbox gate-pass rate: n/a (0/${paired.episodes} episodes paired)`
    : `sandbox gate-pass rate: ${paired.sandbox_passes}/${paired.episodes} episodes paired -> ${paired.sandbox_pass_rate.toFixed(4)}`);
  lines.push(paired.merge_rate === null
    ? `real merge rate: n/a (0/${paired.pull_requests} pull requests paired)`
    : `real merge rate: ${paired.merged_pull_requests}/${paired.pull_requests} pull requests paired -> ${paired.merge_rate.toFixed(4)}`);
  lines.push(paired.gap === null
    ? "sim-to-real gap: undefined (no paired cohort)"
    : `sim-to-real gap: ${paired.sandbox_pass_rate!.toFixed(4)} - ${paired.merge_rate!.toFixed(4)} = ${paired.gap.toFixed(4)}`);
  lines.push(`unpaired episodes (coverage, excluded from the rate): ${report.unpaired_episodes.length}`);
  lines.push(`unpaired outcomes (coverage, excluded from the rate): ${report.unpaired_outcomes.length}`);
  return lines.join("\n");
}
