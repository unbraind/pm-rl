# JSON producer and reader agreement

The complete serialized record must fit its consumer before publication. Limits
on individual strings or array lengths do not establish a bound on their product,
UTF-8 bytes, JSON escaping, indentation, wrappers, or framing newlines.

`tracker-record.ts` owns the shared byte/depth predicate used by
`parseBoundedJson`, `assertJsonEncoding` and `encodeBoundedJson`. The general
reader accepts at most **16,777,216 UTF-8 bytes** and **64 nested containers**.
Discovery envelopes retain their existing **1,048,576-byte** ceiling. Producers
use the appropriate smaller ceiling and preserve their previous JSON ordering
and whitespace. Hash-only canonicalization is unchanged, and existing readers'
limits and legacy serialization are unchanged.

New writes refuse with typed `json_record_limit` and a reduce/split remedy.
Unserializable artifact values and invalid byte budgets refuse
`json_record_invalid` before opening a file. Budgets must be positive integers
no greater than the general reader ceiling; nonfinite options cannot disable a guard.
Neither refusal includes payload content. No migration, deletion or rewrite of
existing tracker/history records is performed.

## Whole-package audit

| Producer / consumer family | Enforcement |
| --- | --- |
| Evaluation plans | Validate the actual `{plan, incumbent_version}` reservation during normalization, before SDK access, and use the same encoder at immutable creation. Member/cohort ordering and comparison identity remain unchanged. |
| Evaluation observations | Pure evaluation and recording encode the same `{comparison, observations}` envelope before returning a verdict or publishing evidence. |
| Shadow manifests and receipts | Preflight the canonical deployment before consent/budget work or evaluation-plan reservation; all sealed manifests, observations and comparisons use the shared encoding guard. |
| Environments, benchmarks, runs, evaluations, episodes, outcomes, generations and sweeps | Every produced JSON fence uses the bounded encoder. Readers decode the fence payload, so the surrounding Markdown does not alter its JSON budget. |
| Loop steps, process jobs and meta receipts | Use the discovery reader's 1 MiB limit on creation, completion, compensation and retry encodings. Process transitions preflight target and compensation before artifact/transaction writes. |
| Trainer input and artifacts | Preflight process input before reservation and process launch; artifact encodings are checked before exclusive file creation. Completion receipts use their existing 65,536-byte ceiling (4,096 bytes for prefix completion). |
| Dataset and improver files | Pre-encode every split and manifest before publishing that batch. Public-source verification artifacts remain independently validated evidence. |
| Corpus programme and controller lock framing | Include the trailing newline in the file's 16 MiB budget. |
| LM checkpoints | Check the actual canonical serialized artifact against the general decoder bound. Model/resource limits remain independent. |
| Policy cards | Existing 64 KiB canonical-byte checks and fixed projection schema already fit both readers; rejected-generation fences also use the shared encoder. |
| Checkpoint blobs and ledgers | Existing 1 MiB byte/reference checks and fixed-shape schemas already fit the general decoder. Preserve their existing `checkpoint_artifact_invalid` refusals. |
| Metric segments | Existing canonical uncompressed segment bounds and splitting remain authoritative before compression and publication. |
| Hashes, equality encodings, human annotations and remote request bodies | Not persisted JSON envelopes consumed by these readers; do not impose a new limit on historical identity calculation or silently change their representation. |

The SDK, CLI and file sinks share these encoders. Default TOON and JSON command
outputs remain compact summaries; they cannot bypass registration admission.
The checks require no Git repository or Git executable.

## Adversarial evidence

The structural maximum (10,000 members with 64-character IDs and 32 cohorts)
encodes a **22,371,651-byte** reservation in the regression fixture. A second
fixture has a **16,777,122-byte** CLI input but a **16,777,218-byte** reservation:
only its wrapper pushes it two bytes above the reader limit. SDK normalization,
registration, pure evaluation and the CLI refuse these inputs before tracker
mutation.

Tests also cover readable plans whose evidence envelope overflows, expanded
shadow tables, exact inclusive byte/depth boundaries, Unicode and escaped
control characters, legacy records, real native competing writes, and 500 seeded
encoding variants. Accepted samples are read back through the SDK and the same
JSON reader. Refused artifact encodings create no file. A syntax-tree guard
rejects raw JSON encoders in persistent SDK-body and file-write sinks.

Packed acceptance exercises the wrapper-only overflow through both TOON and JSON
on npm global, Bun global, npx, forced-Bun bunx and project-local hosts in non-git
trackers, checking unchanged SDK state and content-free refusal output.
