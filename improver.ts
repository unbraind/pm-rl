/** Content-addressed proposal policies learn bounded search preferences from their own development ledger. */
import assert from "node:assert/strict";
import { hashJson, type JsonValue } from "./index.ts";
import { validatePrefixKnobs, type PrefixKnobs } from "./prefix.ts";

/** A selectable feature family and optimizer setting; evaluation rules are deliberately absent. */
export interface LearnerConfig {
  readonly features: "all" | "events" | "words" | "timing";
  readonly learning_rate: number;
  readonly prefix: PrefixKnobs;
}
/** A bounded proposal distribution with immutable arms, explicit priors and attributable ancestry. */
export interface ImproverPolicy {
  readonly format: "pm-rl/improver/1";
  readonly version: number;
  readonly parent: string | null;
  readonly strategy: "posterior-mixture";
  readonly exploration: number;
  readonly arms: readonly { readonly config: LearnerConfig; readonly success: number; readonly failure: number; readonly gain: number }[];
  readonly ledger: string;
  readonly digest: string;
}
/** Only completed development proposals can update search; meta-task results never enter this contract. */
export interface ProposalOutcome {
  readonly id: string;
  readonly role: "development";
  readonly policy: string;
  readonly config: LearnerConfig;
  readonly promoted: boolean;
  readonly gain: number;
}

/** Canonical addressing also validates every runtime domain before proposal sampling or artifact adoption. */
export function improverArtifact(record: Omit<ImproverPolicy, "digest">): ImproverPolicy {
  assert.equal(record.format, "pm-rl/improver/1", "improver_format");
  assert.ok(Number.isSafeInteger(record.version) && record.version >= 1 && (record.version === 1 ? record.parent === null : /^sha256:[a-f0-9]{64}$/.test(record.parent!)), "improver_ancestry");
  assert.ok(record.strategy === "posterior-mixture" && Number.isFinite(record.exploration) && record.exploration >= 0.1 && record.exploration <= 1, "improver_strategy");
  assert.ok(record.arms.length >= 2 && record.arms.length <= 16 && /^[a-f0-9]{64}$/.test(record.ledger), "improver_bounds");
  for (const arm of record.arms) {
    assert.deepEqual(Object.keys(arm).sort(), ["config", "success", "failure", "gain"].sort(), "improver_arm_fields");
    assert.deepEqual(Object.keys(arm.config).sort(), ["features", "learning_rate", "prefix"].sort(), "improver_config_fields");
    validatePrefixKnobs(arm.config.prefix);
    assert.ok(["all", "events", "words", "timing"].includes(arm.config.features) && Number.isFinite(arm.config.learning_rate) && arm.config.learning_rate >= 0.01 && arm.config.learning_rate <= 1, "improver_config");
    assert.ok([arm.success, arm.failure].every((value) => Number.isFinite(value) && value >= 1) && Number.isFinite(arm.gain) && arm.gain >= 0, "improver_prior");
  }
  assert.equal(new Set(record.arms.map((arm) => hashJson(arm.config as unknown as JsonValue))).size, record.arms.length, "improver_duplicate_arm");
  return { ...record, digest: `sha256:${hashJson(record as unknown as JsonValue)}` };
}

/** Supplied digests and unknown fields cannot alter the typed policy envelope silently. */
export function parseImprover(value: ImproverPolicy): ImproverPolicy {
  const { digest, ...record } = value;
  const policy = improverArtifact(record);
  assert.equal(digest, policy.digest, "improver_identity");
  assert.deepEqual(Object.keys(value).sort(), ["format", "version", "parent", "strategy", "exploration", "arms", "ledger", "digest"].sort(), "improver_fields");
  return policy;
}

/** Fix the entire search space and uniform Beta priors before opening any held-out tracker. */
export function initialImprover(): ImproverPolicy {
  const features = ["all", "events", "words", "timing"] as const;
  return improverArtifact({ format: "pm-rl/improver/1", version: 1, parent: null, strategy: "posterior-mixture", exploration: 0.25,
    arms: features.flatMap((feature) => [0.05, 0.5].map((rate) => ({ config: { features: feature, learning_rate: rate,
      prefix: { hashing_width: 32, ngram_order: feature === "events" ? 3 : 1, regularisation: 0.001 } }, success: 1, failure: 1, gain: 0 }))), ledger: hashJson([]) });
}

/** Seeded posterior-weighted sampling without replacement has no dataset or evaluation capability. */
export function proposeLearners(policy: ImproverPolicy, seed: number, generation: number, task: string, count: number): LearnerConfig[] {
  parseImprover(policy);
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff && Number.isSafeInteger(generation) && generation > 0 && Number.isInteger(count) && count >= 1 && count <= policy.arms.length, "improver_proposals");
  const available = [...policy.arms];
  const selected: LearnerConfig[] = [];
  for (let index = 0; index < count; index += 1) {
    const weights = available.map((arm) => policy.exploration + (1 - policy.exploration) * (arm.success / (arm.success + arm.failure) + arm.gain / (arm.success + arm.failure)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    // Common random numbers couple matched policies without making their identities determine draws.
    let draw = Number.parseInt(hashJson({ seed, generation, task, index }).slice(0, 8), 16) / 0x100000000 * total;
    let chosen = 0;
    while (chosen < weights.length - 1 && draw >= weights[chosen]) { draw -= weights[chosen]; chosen += 1; }
    selected.push(available.splice(chosen, 1)[0].config);
  }
  return selected;
}

/** Add unique development outcomes to a declared baseline; the controller supplies its initial artifact for cumulative ledgers. */
export function updateImprover(policy: ImproverPolicy, ledger: readonly ProposalOutcome[], baseline: ImproverPolicy = policy): ImproverPolicy {
  parseImprover(policy);
  parseImprover(baseline);
  assert.deepEqual(policy.arms.map((arm) => arm.config), baseline.arms.map((arm) => arm.config), "improver_baseline_space");
  assert.equal(policy.exploration, baseline.exploration, "improver_baseline_strategy");
  assert.ok(ledger.length > 0 && new Set(ledger.map((entry) => entry.id)).size === ledger.length, "improver_ledger_ids");
  const keys = new Set(policy.arms.map((arm) => hashJson(arm.config as unknown as JsonValue)));
  for (const entry of ledger) assert.ok(entry.role === "development" && /^sha256:[a-f0-9]{64}$/.test(entry.policy) && keys.has(hashJson(entry.config as unknown as JsonValue)) && typeof entry.promoted === "boolean" && Number.isFinite(entry.gain) && Math.abs(entry.gain) <= 1 && (!entry.promoted || entry.gain > 0), "improver_ledger_entry");
  const ordered = [...ledger].sort((a, b) => a.id.localeCompare(b.id));
  const arms = policy.arms.map((arm, index) => {
    const outcomes = ordered.filter((entry) => hashJson(entry.config as unknown as JsonValue) === hashJson(arm.config as unknown as JsonValue));
    const prior = baseline.arms[index];
    return { config: arm.config, success: prior.success + outcomes.filter((entry) => entry.promoted).length,
      failure: prior.failure + outcomes.filter((entry) => !entry.promoted).length,
      gain: outcomes.reduce((sum, entry) => sum + (entry.promoted ? entry.gain : 0), prior.gain) };
  });
  return improverArtifact({ ...policyRecord(policy), version: policy.version + 1, parent: policy.digest, arms,
    ledger: hashJson({ baseline: baseline.digest, outcomes: ordered } as unknown as JsonValue) });
}

/** Strip only the digest when creating a successor; all immutable strategy and search-space fields survive. */
function policyRecord(policy: ImproverPolicy): Omit<ImproverPolicy, "digest"> {
  const { digest: _digest, ...record } = policy;
  return record;
}
