/**
 * @module pm-rl/refuse
 *
 * Shared typed-refusal plumbing for pm-rl's pure contract modules.
 *
 * Every refusal in this package carries a stable machine-readable code on an
 * expected CLI error, because the code is what a recursive loop branches on;
 * prose is for operators. This module holds the one implementation of that
 * contract and the small validation shapes several modules share, so the
 * fail-closed discipline is written once instead of drifting per file.
 */

import { createPmCliExpectedError, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

/**
 * Throw an expected command error with stable machine context.
 *
 * @param message - Human-readable explanation, including any remediation, since
 *   a thrown error's separate remediation field is replaced by a generic host line.
 * @param code - Machine-readable reason, stable across message wording.
 * @param exitCode - Process exit the host should report; usage by default.
 * @throws Always: this never returns.
 */
export function expectedFail(message: string, code: string, exitCode: number = EXIT_CODE.USAGE): never {
  throw createPmCliExpectedError(message, { exitCode, context: { code } });
}

/**
 * Narrow an already-parsed value to one JSON object record.
 *
 * @param value - The parsed JSON value.
 * @param source - Human-readable label naming the document, used in errors.
 * @param code - Refusal code when the value is not one object.
 * @param exitCode - Process exit the host should report.
 * @returns The narrowed record.
 * @throws When the value is null, an array, or not an object.
 */
export function asJsonObject(value: unknown, source: string, code: string = "invalid_json_object", exitCode: number = EXIT_CODE.USAGE): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    expectedFail(`${source} must contain one JSON object.`, code, exitCode);
  }
  return value as Record<string, unknown>;
}

/**
 * Parse JSON text and narrow it to one JSON object record.
 *
 * @param text - The raw JSON text.
 * @param source - Human-readable label naming the document, used in errors.
 * @param invalidJsonCode - Refusal code when the text is not valid JSON.
 * @param exitCode - Process exit the host should report for both refusals.
 * @returns The parsed, narrowed record.
 * @throws When the text is not valid JSON or is not one object.
 */
export function parseJsonRecord(text: string, source: string, invalidJsonCode: string, exitCode: number = EXIT_CODE.USAGE): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    expectedFail(`${source} is not valid JSON.`, invalidJsonCode, exitCode);
  }
  return asJsonObject(parsed, source, "invalid_json_object", exitCode);
}

/**
 * Require a non-empty string field and return it trimmed.
 *
 * The fields read through this helper are identities compared by strict
 * equality elsewhere, so surrounding whitespace is normalized here rather than
 * left to break a comparison downstream.
 *
 * @param record - The parsed JSON object to read from.
 * @param key - Field name to read.
 * @param source - Human-readable label naming the document, used in errors.
 * @param codePrefix - Prefix for the refusal code; the key is appended.
 * @param exitCode - Process exit the host should report.
 * @returns The trimmed value.
 * @throws When the field is absent, not a string, or blank.
 */
export function requiredTrimmedString(record: Readonly<Record<string, unknown>>, key: string, source: string, codePrefix: string, exitCode: number = EXIT_CODE.USAGE): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    expectedFail(`${source} requires a non-empty string ${key}.`, `${codePrefix}${key}`, exitCode);
  }
  return value.trim();
}

/** Read a finite scalar from persisted checkpoint evidence. */
export function storedCheckpointNumber(record: Readonly<Record<string, unknown>>, key: string, source: string, code: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) expectedFail(`${source} requires a finite number ${key}; the persisted checkpoint is invalid.`, code);
  return value;
}

/** Read a content-addressed identity from persisted checkpoint evidence. */
export function storedCheckpointDigest(record: Readonly<Record<string, unknown>>, key: string, source: string, code: string): string {
  const value = record[key];
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) expectedFail(`${source} requires a content-addressed digest ${key}; the persisted checkpoint is invalid.`, code);
  return value;
}

/** Refuse every field that disagrees with deterministic artifact replay. */
export function verifyReplayFields(expected: ReadonlyArray<readonly [string, unknown, unknown]>, generation: number): void {
  const differences = expected.filter(([, storedValue, replayedValue]) => storedValue !== replayedValue);
  if (differences.length > 0) {
    const rendered = differences.map(([field, storedValue, replayedValue]) => `${field}: persisted ${String(storedValue)} != replayed ${String(replayedValue)}`).join("; ");
    expectedFail(`Loop generation ${generation} does not replay against its persisted training configuration (${rendered}).`, "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
}

/** Compare the score and checkpoint fields common to trainer receipts. */
export function verifyTrainerReceipt(stored: { sourceCheckpoint: string; candidateCheckpoint: string; trainingScore: number; evaluationScore: number; incumbentHeldOutMean: number; candidateHeldOutMean: number }, receipt: { source: { digest: string }; candidate: { digest: string }; trainingScore: number; evaluationScore: number; incumbentHeldOutMean: number; candidateHeldOutMean: number }, generation: number): void {
  verifyReplayFields([
    ["source_checkpoint", stored.sourceCheckpoint, receipt.source.digest], ["candidate_checkpoint", stored.candidateCheckpoint, receipt.candidate.digest],
    ["training_score", stored.trainingScore, receipt.trainingScore], ["evaluation_score", stored.evaluationScore, receipt.evaluationScore],
    ["incumbent_held_out_mean", stored.incumbentHeldOutMean, receipt.incumbentHeldOutMean], ["candidate_held_out_mean", stored.candidateHeldOutMean, receipt.candidateHeldOutMean],
  ], generation);
}

/** Verify the shared optimizer and evidence bounds of a persisted trainer generation. */
export function verifyTrainerConfiguration(stored: { generation: number; learningRate: number; evaluationSamples: number; fitSteps: number; samples: number }, step: { learningRate: number; evaluationSamples: number }, config: { fitSteps: number; samplesPerGeneration: number }): void {
  verifyReplayFields([
    ["learning_rate", stored.learningRate, step.learningRate],
    ["evaluation_samples", stored.evaluationSamples, step.evaluationSamples],
    ["fit_steps", stored.fitSteps, config.fitSteps],
    ["samples", stored.samples, config.samplesPerGeneration],
  ], stored.generation);
}
