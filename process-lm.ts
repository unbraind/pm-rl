/** Training-only LM payload and model-specific validation for the shared process contract. */
import type { JsonValue } from "./index.ts";
import type { LoopStepConfig } from "./loop.ts";
import { lmConfigurationJson, jsonLmAdapter, parseLmAdapter, lmCheckpoint, restoreLmBase, restoreLmTraining, serializeLmCheckpoint, type LmFitConfig, type LmLoopConfig, type LmCheckpoint, type LmObservation, type LmTraining } from "./lm.ts";
import { processDigest, verifiedProcessPolicy, type ProcessJob, type TrainerPolicy, type ProcessInput, type ProcessCompletion } from "./process.ts";
import { expectedFail } from "./refuse.ts";

/** Serializable numerical inputs; excludes held-out examples and tracker access. */
export interface LmProcessPayload {
  /** Frozen tensors are JSON arrays, restored without pretraining. */
  readonly config: Omit<LmFitConfig, "base"> & { readonly frozen_base: JsonValue };
  /** Source adapter tensors, bound by the input checkpoint digest. */
  readonly source_adapter: JsonValue;
  /** Real collected completions and rewards. */
  readonly observations: readonly LmObservation[];
  /** One-based generation and derived fit configuration. */
  readonly generation: number;
  /** Derived learning rate and evaluation sample identity; contains no examples. */
  readonly step: LoopStepConfig;
  /** Declared kernel memory ceiling. */
  readonly memory_bytes: number;
}

/** Construct one content-bound request containing only the inputs needed for fitting. */
export function lmProcessInput(config: LmLoopConfig, step: LoopStepConfig, generation: number, source: LmCheckpoint, observations: readonly LmObservation[], programmeId: string): ProcessInput<{ readonly digest: string }> {
  const adapter = config.process;
  if (adapter?.kind !== "compose-lm") expectedFail("LM process input requires its declared Compose adapter.", "process_invalid_adapter");
  const serialized = lmConfigurationJson(config) as Record<string, JsonValue>;
  return {
    identity: { programme_id: programmeId, programme: config.digest, generation, source: source.digest,
      environment: processDigest({ name: config.environmentName, version: config.environmentVersion }), reward: "pm-rl/lm/1" },
    source: { digest: source.digest }, training: [], observations: [],
    training_config: { learning_rate: step.learningRate, steps: config.fitSteps },
    lineage: { training: config.trainingDigest, held_out: config.evaluationDigest, collection: processDigest(observations) },
    lm: { config: { shape: config.shape, baseDigest: config.baseDigest, frozen_base: serialized["frozen_base"], alphabet: config.alphabet,
      training: config.training, trainingDigest: config.trainingDigest, fitSteps: config.fitSteps, klWeight: config.klWeight, clipNorm: config.clipNorm, limits: config.limits },
    source_adapter: jsonLmAdapter(source.adapter), observations, generation, step, memory_bytes: adapter.memory_bytes },
  };
}

/** Restore exact frozen and source tensors without fitting or accessing held-out data. */
export function restoreLmProcessInput(input: ProcessInput<{ readonly digest: string }>): { config: LmFitConfig; source: LmCheckpoint; payload: LmProcessPayload } {
  const payload = input.lm!;
  const config = { ...payload.config, base: restoreLmBase(payload.config.frozen_base, payload.config.shape) };
  const source = lmCheckpoint(parseLmAdapter(payload.source_adapter, config.shape, "LM source"), config);
  if (source.digest !== input.source.digest) expectedFail("LM source checkpoint drifted.", "process_checkpoint_invalid");
  return { config, source, payload };
}

/** Restore staged numerical evidence and bind its canonical checkpoint and measured limits. */
export function processLmTraining(input: ProcessInput<{ readonly digest: string }>, completion: ProcessCompletion<{ readonly digest: string }>): LmTraining {
  const { config, source, payload } = restoreLmProcessInput(input);
  const training = restoreLmTraining(completion.training!, config, payload.generation, source, payload.observations);
  if (training.wallMs < 0 || training.wallMs > completion.usage.wall_ms) expectedFail("LM fit wall use is inconsistent with measured process wall.", "process_receipt_invalid");
  return training;
}

/** Verify durable external evidence against the controller's fit or evaluated candidate without retraining. */
export function verifyLmProcessJob(job: ProcessJob<TrainerPolicy> | null, root: string, input: ProcessInput<{ readonly digest: string }>, expected: { readonly digest: string; readonly training?: JsonValue }): void {
  if (job === null || verifiedProcessPolicy(job, root, input) === null) expectedFail("LM candidate has no external trainer receipt.", "process_receipt_required");
  if (job.completion!.policy.digest !== expected.digest || (expected.training !== undefined && processDigest(expected.training) !== processDigest(job.completion!.training))) {
    expectedFail("LM candidate differs from its external trainer receipt.", "process_job_drift");
  }
}

/** Validate LM bytes, tensor identities, fit evidence, memory and actual optimized target tokens. */
export function validateLmProcessCheckpoint(content: Buffer, completion: ProcessCompletion<{ readonly digest: string }>, input: ProcessInput<{ readonly digest: string }>): void {
  const training = processLmTraining(input, completion);
  const payload = input.lm!;
  const serialized = serializeLmCheckpoint(training.candidate, payload.config);
  if (content.toString("utf8") !== serialized.text || completion.policy.digest !== training.candidate.digest
    || content.length > payload.config.limits.maxCheckpointBytes) expectedFail("LM checkpoint bytes or tensors are invalid.", "process_checkpoint_invalid");
  const memory = completion.peak_memory_bytes;
  if (!Number.isSafeInteger(memory) || Number(memory) < 1 || Number(memory) > payload.memory_bytes
    || completion.usage.tokens !== lmFitTokens(payload)) expectedFail("LM memory or token use exceeds its declaration.", "process_limit_exceeded");
}

/** Count the real collected target tokens optimized across the declared gradient steps. */
export function lmFitTokens(payload: LmProcessPayload): number {
  return payload.observations.reduce((total, observation) => total + observation.tokens.length, 0) * payload.config.fitSteps;
}
