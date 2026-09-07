/** Real numerical adapter tests: no trainer, reward, filesystem or PM mocks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runBanditProgramme, type BanditProgramme } from "../bandit.ts";
import { runBanditProgramme as runPublishedBanditProgramme } from "../dist/index.js";

/** Disjoint synthetic examples share a learnable objective and distinct identities. */
const programme: BanditProgramme = {
  training: [{ id: "train-positive", feature: 1, rewards: [0, 1] }, { id: "train-negative", feature: -1, rewards: [1, 0] }],
  evaluation: [{ id: "eval-positive", feature: 0.8, rewards: [0, 1] }, { id: "eval-negative", feature: -0.8, rewards: [1, 0] }],
  initialWeight: 0, seed: 42, generations: 3, samplesPerGeneration: 256,
  learningRate: 0.5, minimumImprovement: 0, maximumGap: 0.2,
};

test("real policy updates recur using the promoted checkpoint and replay exactly", () => {
  const result = runBanditProgramme(programme);
  assert.equal(result.generations.length, 3);
  assert.deepEqual(result, runBanditProgramme(programme));
  assert.equal(result.samplesConsumed, 768);
  assert.equal(result.stopReason, "generation_limit");
  for (const [index, generation] of result.generations.entries()) {
    assert.equal(generation.promoted, true);
    assert.ok(generation.candidate.weight > generation.source.weight);
    assert.notEqual(generation.candidate.digest, generation.source.digest);
    assert.equal(generation.source.digest, index === 0 ? result.initial.digest : result.generations[index - 1].candidate.digest);
    assert.ok(generation.evaluationScore > generation.baselineScore);
    assert.equal(generation.actionCounts[0] + generation.actionCounts[1], 256);
    assert.match(generation.collectionDigest, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(result.final.digest, result.generations[2].candidate.digest);
  assert.notEqual(result.trainingDigest, result.evaluationDigest);
});

test("evaluation rewards can reject the candidate but cannot change its gradient", () => {
  const result = runBanditProgramme({ ...programme, evaluation: [{ id: "opposite", feature: 1, rewards: [1, 0] }] });
  const normal = runBanditProgramme(programme);
  assert.equal(result.generations[0].candidate.digest, normal.generations[0].candidate.digest);
  assert.equal(result.generations.length, 1);
  assert.equal(result.generations[0].promoted, false);
  assert.equal(result.stopReason, "evaluation_rejected");
  assert.equal(result.final.digest, result.initial.digest);
  assert.equal(result.samplesConsumed, 256);
});

test("a widening proxy/evaluation gap stops recursion despite evaluation improvement", () => {
  const result = runBanditProgramme({ ...programme, maximumGap: 0 });
  assert.ok(result.generations[0].evaluationScore > result.generations[0].baselineScore);
  assert.equal(result.stopReason, "gap_rejected");
  assert.equal(result.final.digest, result.initial.digest);
});

test("minimum improvement and unchanged checkpoints stop further collection", () => {
  assert.equal(runBanditProgramme({ ...programme, minimumImprovement: 1 }).stopReason, "evaluation_rejected");
  const zero = runBanditProgramme({ ...programme, training: [{ id: "zero", feature: 0, rewards: [0, 0] }] });
  assert.equal(zero.stopReason, "unchanged_checkpoint");
  assert.equal(zero.generations.length, 1);
  assert.equal(zero.final.digest, zero.initial.digest);
});

test("seed affects actual sampled actions and collection digest", () => {
  const first = runBanditProgramme(programme).generations[0];
  const second = runBanditProgramme({ ...programme, seed: 43 }).generations[0];
  assert.notDeepEqual(first.actionCounts, second.actionCounts);
  assert.notEqual(first.collectionDigest, second.collectionDigest);
});

test("invalid bounds refuse before numerical work", () => {
  const invalid: Partial<BanditProgramme>[] = [
    { seed: -1 }, { seed: 2 ** 32 }, { seed: 0.5 },
    { generations: 0 }, { generations: 101 }, { generations: NaN },
    { samplesPerGeneration: 0 }, { samplesPerGeneration: 100001 }, { samplesPerGeneration: 0.5 },
    { generations: 100, samplesPerGeneration: 1001 },
    { initialWeight: Infinity }, { initialWeight: 21 }, { initialWeight: -21 },
    { learningRate: 0 }, { learningRate: 1.1 }, { learningRate: NaN },
    { minimumImprovement: -1 }, { minimumImprovement: Infinity },
    { maximumGap: -1 }, { maximumGap: NaN },
    { training: [] }, { evaluation: [] },
    { training: Array.from({ length: 10001 }, (_, n) => ({ id: `large-${n}`, feature: 1, rewards: [0, 1] as const })) },
  ];
  for (const change of invalid) assert.throws(() => runBanditProgramme({ ...programme, ...change }), /bandit_invalid/);
});

test("invalid examples and reused example identities cannot enter training", () => {
  for (const example of [
    { id: "", feature: 1, rewards: [0, 1] as const },
    { id: " ", feature: 1, rewards: [0, 1] as const },
    { id: "x", feature: NaN, rewards: [0, 1] as const },
    { id: "x", feature: 1.1, rewards: [0, 1] as const },
    { id: "x", feature: -1.1, rewards: [0, 1] as const },
    { id: "x", feature: 1, rewards: [-1, 1] as const },
    { id: "x", feature: 1, rewards: [0, 2] as const },
    { id: "x", feature: 1, rewards: [0, Infinity] as const },
  ]) assert.throws(() => runBanditProgramme({ ...programme, training: [example] }), /bandit_invalid/);
  assert.throws(() => runBanditProgramme({ ...programme, evaluation: programme.training }), /bandit_overlap/);
  assert.throws(() => runBanditProgramme({ ...programme, training: [programme.training[0], programme.training[0]] }), /bandit_overlap/);
});

test("one observed reward produces the hand-computable score-function gradient", () => {
  const one = runBanditProgramme({ ...programme, generations: 1, samplesPerGeneration: 1,
    training: [{ id: "one", feature: 1, rewards: [0, 1] }] }).generations[0];
  // Seed 42 samples action one. At weight zero, p=0.5 and gradient=1*(1-0.5)*1.
  assert.deepEqual(one.actionCounts, [0, 1]);
  assert.equal(one.candidate.weight, 0.25);
  assert.equal(one.baselineScore, 0.5);
  assert.ok(Math.abs(one.evaluationScore - 1 / (1 + Math.exp(-0.25 * 0.8))) < 1e-15);
  const unobserved = runBanditProgramme({ ...programme, generations: 1, samplesPerGeneration: 1,
    training: [{ id: "one", feature: 1, rewards: [1, 0] }] });
  assert.equal(unobserved.generations[0].candidate.weight, 0);
  assert.equal(unobserved.stopReason, "unchanged_checkpoint");
});

test("runtime tuple shape cannot yield a promoted nonfinite checkpoint", () => {
  const sparse: number[] = [];
  sparse[1] = 1;
  for (const rewards of [[], [0], [0, 1, 0], sparse]) {
    const runtimeRewards = rewards as unknown as readonly [number, number];
    assert.throws(() => runBanditProgramme({ ...programme,
      training: [{ id: "malformed-rewards", feature: 1, rewards: runtimeRewards }] }), /bandit_invalid/);
  }
});


test("the emitted public package entry point executes the documented programme", () => {
  const result = runPublishedBanditProgramme(programme);
  assert.deepEqual(result, runBanditProgramme(programme));
  assert.equal(result.samplesConsumed, 768);
  assert.equal(result.final.weight, 0.36331123588596426);
  assert.equal(result.generations[1].source.digest, result.generations[0].candidate.digest);
});
