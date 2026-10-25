/** Deterministic item-paired bootstrap gates, separate from repeated policy-action rollouts. */

/** A percentile interval over resampled held-out items. */
export interface ItemInterval { readonly mean: number; readonly lower: number; readonly upper: number }
/** Baselines and paired effects counted once per held-out item. */
export interface ItemEvidence {
  readonly method: "paired-item-percentile-bootstrap/1" | "paired-stratified-item-bootstrap/1";
  readonly samples: number;
  readonly replicates: number;
  readonly confidence: number;
  readonly reward: ItemInterval;
  readonly incumbent: ItemInterval;
  readonly constant_zero: ItemInterval;
  readonly constant_one: ItemInterval;
  readonly heuristic?: ItemInterval;
  readonly class_samples?: readonly [number, number];
  readonly accepted: boolean;
  readonly reason: string | null;
}

/** Use a fixed evaluator stream, with identical resampling indices for each paired difference. */
export function itemBootstrap(values: readonly number[], confidence: number, labels?: readonly boolean[]): ItemInterval {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value)) || !Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) throw new RangeError("item_bootstrap_input");
  const replicates = 8192;
  const groups = labels === undefined ? [values] : [false, true].map((label) => values.filter((_, index) => labels[index] === label));
  if (labels !== undefined && (labels.length !== values.length || groups.some((group) => group.length === 0))) throw new RangeError("item_bootstrap_classes");
  const means = new Float64Array(replicates);
  let state = 0x51f15e;
  for (let sample = 0; sample < replicates; sample += 1) {
    let sum = 0;
    for (const group of groups) {
      let subtotal = 0;
      for (let index = 0; index < group.length; index += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        subtotal += group[Math.floor(state / 0x1_0000_0000 * group.length)];
      }
      sum += subtotal / group.length;
    }
    means[sample] = sum / groups.length;
  }
  means.sort();
  const tail = (1 - confidence) / 2;
  return { mean: groups.reduce((sum, group) => sum + group.reduce((total, value) => total + value, 0) / group.length, 0) / groups.length,
    lower: means[Math.floor(tail * replicates)], upper: means[Math.ceil((1 - tail) * replicates) - 1] };
}

/** Require positive effects over incumbent and both constant policies at Bonferroni-adjusted confidence. */
export function pairedItemEvidence(candidate: readonly number[], incumbent: readonly number[], rewards: readonly (readonly [number, number])[], confidence: number, minSamples: number, minimumImprovement: number, balanced?: { readonly labels: readonly boolean[]; readonly heuristic: readonly number[] }): ItemEvidence {
  if (candidate.length !== incumbent.length || rewards.length !== candidate.length) throw new RangeError("item_pairing");
  if (balanced !== undefined && balanced.heuristic.length !== candidate.length) throw new RangeError("item_pairing");
  const adjusted = 1 - (1 - confidence) / (balanced === undefined ? 3 : 4);
  const labels = balanced?.labels;
  const previous = itemBootstrap(candidate.map((value, index) => value - incumbent[index]), adjusted, labels);
  const zero = itemBootstrap(candidate.map((value, index) => value - rewards[index][0]), adjusted, labels);
  const one = itemBootstrap(candidate.map((value, index) => value - rewards[index][1]), adjusted, labels);
  const heuristic = balanced === undefined ? undefined : itemBootstrap(candidate.map((value, index) => value - balanced.heuristic[index]), adjusted, labels);
  const classSamples = labels === undefined ? undefined : [labels.filter((label) => !label).length, labels.filter(Boolean).length] as const;
  const reason = candidate.length < minSamples || (classSamples !== undefined && Math.min(...classSamples) < minSamples) ? "item_insufficient_samples"
    : previous.lower <= minimumImprovement ? "item_incumbent_not_beaten"
      : Math.min(zero.lower, one.lower) <= minimumImprovement ? "item_constant_not_beaten"
        : heuristic !== undefined && heuristic.lower <= minimumImprovement ? "item_heuristic_not_beaten" : null;
  return { method: balanced === undefined ? "paired-item-percentile-bootstrap/1" : "paired-stratified-item-bootstrap/1", samples: candidate.length, replicates: 8192, confidence,
    reward: itemBootstrap(candidate, confidence, labels), incumbent: previous, constant_zero: zero, constant_one: one,
    ...(heuristic === undefined ? {} : { heuristic, class_samples: classSamples }),
    accepted: reason === null, reason };
}
