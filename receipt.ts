/**
 * @module pm-rl/receipt
 *
 * Determinism receipts, and re-deriving them on demand.
 *
 * A Run records a receipt at start: seed policy, library versions, device, and
 * the environment version it trained under. `pm rl run verify` re-derives the
 * receipt from what the caller can still produce and reports the difference, so
 * an unreproducible run is detectable the moment it is claimed rather than
 * months later when someone tries to build on it.
 *
 * The functions in this module are pure: they validate and compare without
 * touching a pm tracker. The command handlers in {@link ./index.ts} resolve the
 * run item and call them.
 */

import { EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

import { expectedFail } from "./refuse.ts";

/**
 * The exact fields a determinism receipt carries.
 *
 * A receipt with extra fields would let untracked state claim provenance
 * weight, so the parser refuses anything outside this set and the set is
 * exported so tests can pin it.
 */
export const RECEIPT_FIELDS = ["seed_policy", "library_versions", "device", "environment_version"] as const;

/** One field name of a determinism receipt. */
export type ReceiptField = (typeof RECEIPT_FIELDS)[number];

/** A run's recorded determinism provenance, stored in the run body at start. */
export interface ReceiptSpec {
  /** How seeds derive from the run's base seed, e.g. `derived-from-seed-7`. */
  readonly seed_policy: string;
  /** Library name to exact version for every dependency that could affect results. */
  readonly library_versions: Readonly<Record<string, string>>;
  /** The compute device training ran on, e.g. `cuda:0`. */
  readonly device: string;
  /** The environment version the run trained under; must match the run's recorded environment. */
  readonly environment_version: string;
}

/** One named difference between the recorded receipt and the re-derived one. */
export interface ReceiptDifference {
  /** The differing field, or `library_versions "<name>"` for one library. */
  readonly field: string;
  /** The recorded value rendered for the report. */
  readonly recorded: string;
  /** The re-derived value rendered for the report, or `absent`. */
  readonly now: string;
}

/**
 * Parse and validate a determinism receipt.
 *
 * All four provenance fields are required and non-empty: a receipt that omits,
 * say, the device is not a weaker receipt, it is no receipt — a run that cannot
 * state what it ran on cannot be re-derived at all. Library versions must be an
 * object mapping non-empty names to non-empty version strings, and unknown
 * top-level keys are refused so untracked state cannot ride along as provenance.
 *
 * @param text - The JSON text of the receipt.
 * @param source - Human-readable label naming the source being parsed.
 * @returns The validated receipt.
 * @throws When the text is not one JSON object, a required field is absent or
 *   blank, a library version is not a string, or an unknown field is present.
 */
export function parseReceipt(text: string, source = "Determinism receipt"): ReceiptSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    expectedFail(`${source} is not valid JSON.`, "invalid_receipt_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    expectedFail(`${source} must contain one JSON object.`, "invalid_json_object");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RECEIPT_FIELDS.includes(key as ReceiptField)) {
      expectedFail(`${source} carries unknown receipt field "${key}"; a receipt is exactly ${RECEIPT_FIELDS.join(", ")}.`, "invalid_receipt_field");
    }
  }
  const stringField = (key: ReceiptField): string => {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      expectedFail(`${source} requires a non-empty string ${key}.`, `invalid_receipt_${key}`);
    }
    return value.trim();
  };
  const libraryVersionsRaw = record["library_versions"];
  if (libraryVersionsRaw === null || typeof libraryVersionsRaw !== "object" || Array.isArray(libraryVersionsRaw)) {
    expectedFail(`${source} requires library_versions as an object of library name to version.`, "invalid_receipt_library_versions");
  }
  const libraryVersions: Record<string, string> = {};
  for (const [name, version] of Object.entries(libraryVersionsRaw as Record<string, unknown>)) {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      expectedFail(`${source} requires a non-empty library name for every library version.`, "invalid_receipt_library_versions");
    }
    if (typeof version !== "string" || version.trim().length === 0) {
      expectedFail(`${source} requires a string version for library "${name}".`, "invalid_receipt_library_versions");
    }
    // Two raw keys that normalize to the same name would silently overwrite the
    // first version while verification sees only the survivor; refuse instead.
    if (Object.hasOwn(libraryVersions, normalizedName)) {
      expectedFail(`${source} names library "${normalizedName}" more than once after normalization; record one version per library.`, "duplicate_receipt_library");
    }
    libraryVersions[normalizedName] = version.trim();
  }
  return {
    seed_policy: stringField("seed_policy"),
    library_versions: libraryVersions,
    device: stringField("device"),
    environment_version: stringField("environment_version"),
  };
}

/**
 * Re-derive a recorded receipt against a fresh one and name every difference.
 *
 * Scalar fields are compared by exact value; library versions are compared per
 * library so a single upgraded dependency is named on its own. An absent or
 * added library is a difference, not something to skip — either side of the
 * ledger being incomplete is exactly what makes a run unreproducible.
 *
 * @param recorded - The receipt stored on the run at start.
 * @param rederived - The receipt the caller can still produce today.
 * @returns Every difference, ordered by field name for stable reporting.
 */
export function compareReceipts(recorded: ReceiptSpec, rederived: ReceiptSpec): ReceiptDifference[] {
  const differences: ReceiptDifference[] = [];
  for (const field of ["device", "environment_version", "seed_policy"] as const) {
    if (recorded[field] !== rederived[field]) {
      differences.push({ field, recorded: `"${recorded[field]}"`, now: `"${rederived[field]}"` });
    }
  }
  const libraries = [...new Set([...Object.keys(recorded.library_versions), ...Object.keys(rederived.library_versions)])].sort();
  for (const library of libraries) {
    const recordedVersion = recorded.library_versions[library];
    const nowVersion = rederived.library_versions[library];
    if (recordedVersion !== nowVersion) {
      differences.push({
        field: `library_versions "${library}"`,
        recorded: recordedVersion === undefined ? "absent" : `"${recordedVersion}"`,
        now: nowVersion === undefined ? "absent" : `"${nowVersion}"`,
      });
    }
  }
  return differences;
}

/**
 * Render receipt differences as stable, diffable text.
 *
 * @param differences - Differences as produced by {@link compareReceipts}.
 * @returns One `field: recorded X, now Y` line per difference, or the empty
 *   string when there are none.
 */
export function renderReceiptDifferences(differences: readonly ReceiptDifference[]): string {
  return differences.map((difference) => `${difference.field}: recorded ${difference.recorded}, now ${difference.now}`).join("; ");
}
