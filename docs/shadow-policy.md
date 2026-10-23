# Shadow policy observation

A shadow deployment observes the same consented input with an active policy and a candidate policy. It returns **only the active decision as `active_action`** for the caller to apply. The candidate has no executable code, tool interface, SDK client or mutation capability. The current interpreter is a bounded string-to-action lookup table: at most 10,000 entries per artifact and 1,024 characters per input or action. This supports finite routing and classification policies; model inference and arbitrary executable policies require a separate reviewed adapter.

`registerShadowDeployment`, `observeShadow` and `compareShadow` are typed SDK exports. Their CLI equivalents are `pm rl shadow register --file deployment.json`, `pm rl shadow observe <candidate> --file input.json` and `pm rl shadow compare <candidate>`. All use the host's normal compact TOON output or `--json`. An observation is constant-size; a comparison contains counts, charges and the existing bounded evaluation verdict, never the full cohort.

Before registration, create a Decision whose body is exactly:

```ts
JSON.stringify({
  format: "pm-rl/shadow-consent/1",
  deployment: hashJson(deployment),
})
```

Consent binds the exact `generation` and `incumbent` identities, preventing one allowance from funding multiple deployments. It approves the exact policy artifacts, `shadowInputDigest(input)` for every declared member, and separate `active_calls` and `candidate_calls` allowances. It is verified against its SDK creation history. Consent to one deployment cannot fund another artifact. Register a new consent and fresh candidate for changed policies or inputs. Minimize inputs before hashing: neither raw tracker titles nor bodies need be retained in observation receipts.

The registration JSON contains `deployment` and `plan`; see [the example](../examples/shadow-policy.json). Replace the example's incumbent provenance and input identity with actual SDK-derived hashes. The incumbent and candidate generations must declare `training_config.shadow_policy = hashJson(policy)`. Create the incumbent first, register the shadow deployment next, and create the candidate and collection runs afterwards. The existing generation registration automatically pins the reserved evaluation comparison in its provenance.

Each input file has this shape:

```json
{"id":"event-0","input":"event","rewards":{"hold":0,"accept":1}}
```

The active and candidate tables receive the same minimized input; neither sees the reward map. Rewards must be finite and within the plan's declared bounds. Only use paired observed outcomes for actions with valid known counterfactual rewards, such as routing/classification against a subsequently established label. If taking an action changes its outcome, this reward map is insufficient causal evidence; collect an appropriately designed experiment instead. This API does not infer unobserved action outcomes.

Every planned input reserves **two calls**, including failed candidate attempts. Each member has exactly one immutable observation identity; identical retries do not add budget or replace outcomes. Missing candidate entries record `candidate_missing_action`; missing candidate outcomes record `candidate_missing_outcome` while preserving the active action. An invalid active policy or unconsented input refuses before either decision is admitted. A storage, consent or malformed-input refusal is an observation failure, not a candidate-policy failure; callers retain responsibility for their established active execution path.

Manifest validation is shared by registration and every reload. It rechecks the exact generation pair, consent, cohort membership and both allowances against the frozen plan, then checks actual unique observation receipts from the SDK's certified inventory. Extra receipt slots are charged and refused rather than omitted from comparison counts. Failed candidate attempts still consume both arms' reserved slot; retries cannot create a second slot.

Receipt validation is also shared by the live observer, resumed observations, comparison and promotion. The consented input digest resolves through the pinned active policy's input table; both actions must match those policy artifacts. Rewards must be finite and within the plan bounds, and identical actions must have identical rewards. Disagreement and failure flags are recomputed. `outcome_digest` commits the selected, known arm outcomes only; unselected reward entries are not comparison evidence. Existing unverifiable or incompatible receipts are refused and require a fresh candidate/plan, never history repair.

A mismatch returns a typed conflict with `context.item_id` naming the receipt and `context.field` naming the invalid field, such as `candidate_reward`, `disagreement`, `inputs`, `budget.active_calls` or `charged.candidate_calls`. These locations are also present in the refusal message, without copying the rejected values. Promotion performs the same checks inside its existing writer transaction.

`compareShadow` requires the complete frozen cohort. Candidate failures are sealed as a comparison with no eligible outcome. Otherwise it delegates the paired observations to the existing predeclared evaluation module, retaining its fixed stopping rule, equal-weight correlation units, confidence bound and effect threshold. Disagreements alone are never evidence of improvement. Observations from one tracker should normally share one correlation unit; repeated items do not become independent projects.

The **existing** generation promotion transaction, also used by the recursive loop and inner meta training, verifies the shadow receipt inside its authoritative writer lock. A manually supplied offline evaluation result cannot bypass the receipt. No comparison command promotes anything. The existing contamination, score, approval and promotion-budget checks still apply. The online marker follows the lineage: a candidate with a `shadow_policy` binding, or with an online-bound parent, cannot use an unreserved or offline-only evaluation to escape the shadow requirement. This also blocks unobserved successors proposed by the existing recursive controller. Offline experiments whose lineage has never been bound online keep their existing evaluation contracts; selecting an offline recipe is not deployment authorization. Deploy an online successor by reserving its shadow plan and using the same generation promotion command, never a separate switching API.

Typed conflict refusals include `shadow_consent`, `shadow_budget`, `shadow_missing`, `shadow_incomplete`, `shadow_failed` and `shadow_drift`; `shadow_invalid` identifies unsupported input/configuration. Every refusal includes a remedy. Complete the declared observations for incomplete evidence; preserve the active policy and create a fresh consented candidate after drift or failure. A statistically refused comparison requires a fresh predeclared experiment, not another look at the same candidate.

All records use the pm SDK's certified complete reads, history snapshots, schema, content hashing and mutation locks. No Git subprocess is needed. Neither policy receives authority to mutate the tracker or execute an action. This is a controlled observation mechanism and a fail-closed deployment prerequisite, not evidence that a candidate improves real-world outcomes.

For an SDK caller, `hashJson` accepts `JsonValue`; hash the validated deployment as `deployment as unknown as JsonValue` when constructing the consent body. The JSON example deliberately has one independent unit and fewer units than `minSamples`: it demonstrates observation and a safe promotion refusal, not a powered improvement claim. Copy the exact unrounded `outcome.candidate_mean` into a promotion score; do not recompute or round it from aggregate counts.

Reproduce the public-data acceptance from the repository with:

```bash
npm run build
npm pack --pack-destination <scratch-directory>
node test/shadow.acceptance.ts <read-only-public-tracker-copy> <report.json> <public-commit> <package.tgz>
```

The runner certifies a complete SDK inventory, selects the first 20 sorted item IDs without outcome filtering, observes constant classifiers on real closed-status labels, and verifies every selected source file remains read-only and byte-identical. It installs the packed package and runs JSON/TOON commands with Git absent. The sole repository counts as one correlation unit, so its outcome comparison refuses promotion regardless of its empirical mean.
