import { acquireStateLock, statePath, checkedStateFile, operationIdentifier } from "./state-boundary.ts";
import { parseBoundedJson } from "./tracker-record.ts";
/** Immutable checkpoint blobs and an append-only promotion/audit ledger, independent of Git. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";

import { expectedFail } from "./refuse.ts";
import { prefixCheckpoint, type PrefixCheckpoint } from "./prefix.ts";
import { parseImprover, type ImproverPolicy } from "./improver.ts";

/** Storage is separately bounded from the small staging protocol and optimizer budget. */
export const MAX_CHECKPOINT_BYTES = 1_048_576;
/** Portable reference; the blob digest addresses exact bytes, independently of the policy's semantic identity. */
export interface CheckpointArtifact {
  readonly format: "pm-rl/checkpoint-artifact/1";
  readonly kind: "prefix" | "improver";
  readonly digest: string;
  readonly policy: string;
  readonly bytes: number;
}
/** Every staged, evaluated or promoted policy remains an audit root until its ledger entry is explicitly retired. */
export interface CheckpointLedgerEntry {
  readonly format: "pm-rl/checkpoint-ledger/1";
  readonly key: string;
  readonly artifacts: readonly CheckpointArtifact[];
}

/** Address the exact bytes that will be atomically published. */
function digestBytes(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
/** Resolve only validated digest names within this tracker's durable artifact store. */
export function checkpointArtifactPath(root: string, digest: string): string {
  operationIdentifier(digest, "digest");
  return statePath(root, "artifacts", "pm-rl", "sha256", `${digest.slice(7)}.json`);
}
/** Reject malformed references before using sizes or names from persisted metadata. */
function validateReference(ref: CheckpointArtifact): void {
  if (ref === null || typeof ref !== "object" || ref.format !== "pm-rl/checkpoint-artifact/1" || !["prefix", "improver"].includes(ref.kind)
    || !/^sha256:[a-f0-9]{64}$/.test(ref.policy) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_CHECKPOINT_BYTES) {
    expectedFail("Invalid checkpoint artifact reference.", "checkpoint_artifact_invalid");
  }
}
/** Read only regular bounded files and normalize missing/corrupt storage into stable typed refusals. @internal */
export function readVerifiedFile(file: string, digest: string, bytes?: number): Buffer {
  let content: Buffer;
  try {
    const handle = openSync(checkedStateFile(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(handle);
      if (!stat.isFile() || stat.size > MAX_CHECKPOINT_BYTES || (bytes !== undefined && stat.size !== bytes)) throw new Error("invalid file");
      // One extra byte detects growth without allowing an unbounded allocation or read.
      const buffer = Buffer.alloc(stat.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const count = readSync(handle, buffer, total, buffer.length - total, null);
        if (count === 0) break;
        total += count;
      }
      if (total !== stat.size) throw new Error("file size changed");
      content = buffer.subarray(0, total);
    } finally { closeSync(handle); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") expectedFail("Checkpoint artifact is missing; restore it before resuming.", "checkpoint_artifact_missing");
    expectedFail("Checkpoint artifact is unreadable or corrupt.", "checkpoint_artifact_corrupt");
  }
  if (digestBytes(content) !== digest) expectedFail("Checkpoint artifact failed SHA-256 verification.", "checkpoint_artifact_corrupt");
  return content;
}
/** Verify every read, including replay; never return a fallback policy or request a new fit. */
export function readCheckpointArtifact(root: string, ref: CheckpointArtifact): unknown {
  validateReference(ref);
  const content = readVerifiedFile(checkpointArtifactPath(root, ref.digest), ref.digest, ref.bytes);
  const value = parseArtifactJson(content);
  if (value === null || typeof value !== "object" || (value as { digest?: unknown }).digest !== ref.policy) expectedFail("Checkpoint policy identity differs from its reference.", "checkpoint_artifact_corrupt");
  try {
    if (ref.kind === "prefix") {
      const policy = value as PrefixCheckpoint;
      if (prefixCheckpoint(policy.weights, policy.knobs).digest !== policy.digest) throw new Error("policy identity");
    } else parseImprover(value as ImproverPolicy);
  } catch { expectedFail("Checkpoint policy schema or identity is corrupt.", "checkpoint_artifact_corrupt"); }
  return value;
}
/** Normalize malformed blob or ledger JSON into the same fail-closed integrity error. */
function parseArtifactJson(content: Buffer): unknown {
  try { return parseBoundedJson(content.toString("utf8")); }
  catch { expectedFail("Checkpoint artifact or ledger is not JSON.", "checkpoint_artifact_corrupt"); }
}
/** Resolve a public audit coordinate without needing a staging path or a Git repository. */
export function inspectCheckpointArtifact(root: string, digest: string): { artifact: CheckpointArtifact; value: unknown } {
  checkpointArtifactPath(root, digest);
  const artifact = ledgerEntries(root, false).flatMap((entry) => entry.artifacts).find((ref) => ref.digest === digest);
  if (artifact === undefined) expectedFail("Checkpoint digest has no promotion ledger root.", "checkpoint_artifact_missing");
  return { artifact, value: readCheckpointArtifact(root, artifact) };
}
/** Refuse runtimes without directory-relative no-follow access before acquiring a storage lease. */
function requireArtifactDescriptors(): void {
  if (process.platform !== "linux") expectedFail("Checkpoint storage requires Linux descriptor-relative no-follow access.", "checkpoint_storage_unsupported");
}
/** Pin each directory with O_NOFOLLOW; procfs supplies directory-relative operations on Linux. */
function artifactDirectory<T>(root: string, parts: readonly string[], execute: (directory: string, handles: readonly number[], verify: () => void) => T): T {
  requireArtifactDescriptors();
  statePath(root, ...parts);
  const handles: number[] = [];
  try {
    handles.push(openSync(statePath(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const base = `/proc/self/fd/${handles[0]}`;
    // Prove procfs resolves the held inode before permitting any publication or cleanup.
    const held = fstatSync(handles[handles.length - 1]);
    const probe = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY);
    try { const actual = fstatSync(probe); if (actual.dev !== held.dev || actual.ino !== held.ino) expectedFail("Checkpoint descriptor identity could not be verified.", "checkpoint_storage_unsupported"); }
    finally { closeSync(probe); }
    for (const part of parts) {
      const parent = `/proc/self/fd/${handles[handles.length - 1]}`;
      // mkdir never follows its final component; the subsequent open refuses an existing link.
      try { mkdirSync(`${parent}/${part}`, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      handles.push(openSync(`${parent}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    const directory = `/proc/self/fd/${handles[handles.length - 1]}`;
    /** Recheck every held component's identity at use, including replacement by an ordinary directory. */
    function verify(): void {
      statePath(root, ...parts);
      for (let index = 0; index < handles.length; index++) {
        const current = lstatSync(index === 0 ? root : `/proc/self/fd/${handles[index - 1]}/${parts[index - 1]}`);
        const held = fstatSync(handles[index]);
        if (current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino) expectedFail("Checkpoint directory identity changed.", "rl_state_path_invalid");
      }
    }
    verify();
    const result = execute(directory, handles, verify);
    verify();
    return result;
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) expectedFail("Checkpoint directory changed or contains a link.", "rl_state_path_invalid");
    if ((error as NodeJS.ErrnoException).code === "ENOENT") expectedFail("Descriptor-relative checkpoint storage is unavailable.", "checkpoint_storage_unsupported");
    throw error;
  } finally { for (const handle of handles.reverse()) closeSync(handle); }
}
/** Fsync a private inode and publish without following any replaceable path component. */
function publishFile(root: string, kind: "sha256" | "ledger", digest: string, content: Buffer): void {
  artifactDirectory(root, ["artifacts", "pm-rl", kind], (directory, handles, verify) => {
    const target = `${directory}/${digest.slice(7)}.json`;
    const temporary = `${directory}/.pending-${randomUUID()}`;
    verify();
    const handle = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      verify(); writeFileSync(handle, content); fsyncSync(handle);
      verify();
      try { linkSync(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      readVerifiedFile(checkpointArtifactPathForKind(root, kind, digest), digest, content.length);
      verify();
      for (const directoryHandle of [...handles].reverse()) fsyncSync(directoryHandle);
    } finally { closeSync(handle); unlinkSync(temporary); }
  });
}
/** Resolve a retained digest in either immutable store without changing its public spelling. */
function checkpointArtifactPathForKind(root: string, kind: string, digest: string): string { return statePath(root, "artifacts", "pm-rl", kind, `${digest.slice(7)}.json`); }
/** Serialize short publication/GC critical sections using the SDK's token-owned tracker lock. */
async function withArtifactLock<T>(root: string, operation: () => T): Promise<T> {
  requireArtifactDescriptors();
  const release = await acquireStateLock(root, "rl-checkpoint-artifacts", 3600, "pm-rl", false, true, 30_000);
  try { return operation(); } finally { await release(); }
}
/** Replace checkpoint objects with portable references and publish their audit roots before exposing any reference. */
export async function encodeCheckpointArtifacts(root: string, key: string, value: unknown, beforePublish?: (encoded: unknown) => Promise<void>): Promise<unknown> {
  const blobs = new Map<string, { ref: CheckpointArtifact; content: Buffer }>();
  /** Walk only JSON values; complete checkpoint objects are the leaves of the persisted receipt. */
  const encode = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(encode);
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    if ((Array.isArray(record.weights) && record.knobs !== undefined && typeof record.digest === "string") || record.format === "pm-rl/improver/1") {
      try {
        if (record.format === "pm-rl/improver/1") parseImprover(record as unknown as ImproverPolicy);
        else {
          const policy = record as unknown as PrefixCheckpoint;
          if (prefixCheckpoint(policy.weights, policy.knobs).digest !== policy.digest) throw new Error("policy identity");
        }
      } catch { expectedFail("Checkpoint policy schema or identity is invalid; refusing to publish it.", "checkpoint_artifact_invalid"); }
      const content = Buffer.from(JSON.stringify(node));
      const ref: CheckpointArtifact = { format: "pm-rl/checkpoint-artifact/1", kind: record.format === "pm-rl/improver/1" ? "improver" : "prefix", digest: digestBytes(content), policy: String(record.digest), bytes: content.length };
      validateReference(ref);
      blobs.set(ref.digest, { ref, content }); return ref;
    }
    return Object.fromEntries(Object.entries(record).map(([name, child]) => [name, encode(child)]));
  };
  const encoded = encode(value);
  await beforePublish?.(encoded);
  if (blobs.size === 0) return encoded;
  const entry: CheckpointLedgerEntry = { format: "pm-rl/checkpoint-ledger/1", key, artifacts: [...blobs.values()].map(({ ref }) => ref) };
  const content = Buffer.from(JSON.stringify(entry));
  if (content.length > MAX_CHECKPOINT_BYTES) expectedFail("Checkpoint ledger batch exceeds its storage bound.", "checkpoint_artifact_invalid");
  await withArtifactLock(root, () => {
    for (const { ref, content } of blobs.values()) publishFile(root, "sha256", ref.digest, content);
    publishFile(root, "ledger", digestBytes(content), content);
  });
  return encoded;
}
/** Hydrate checkpoint leaves on every resume and audit read, without changing their surrounding receipt schema. */
export function decodeCheckpointArtifacts(root: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((node) => decodeCheckpointArtifacts(root, node));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.format === "pm-rl/checkpoint-artifact/1") return readCheckpointArtifact(root, record as unknown as CheckpointArtifact);
  return Object.fromEntries(Object.entries(record).map(([name, child]) => [name, decodeCheckpointArtifacts(root, child)]));
}
/** Verify ledger structure and references; certify blob contents only for a full integrity read. */
function ledgerEntries(root: string, certify: boolean): CheckpointLedgerEntry[] {
  const directory = statePath(root, "artifacts", "pm-rl", "ledger");
  let names: string[];
  try { names = readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter((name) => name.endsWith(".json")).sort().map((name) => {
    const content = readVerifiedFile(statePath(directory, name), `sha256:${name.slice(0, -5)}`);
    const entry = parseArtifactJson(content) as CheckpointLedgerEntry;
    if (entry === null || entry.format !== "pm-rl/checkpoint-ledger/1" || typeof entry.key !== "string" || !Array.isArray(entry.artifacts)) expectedFail("Checkpoint promotion ledger is corrupt.", "checkpoint_artifact_corrupt");
    for (const ref of entry.artifacts) {
      validateReference(ref);
      checkpointArtifactPath(root, ref.digest);
      if (certify) readCheckpointArtifact(root, ref);
    }
    return entry;
  });
}
/** Certify the entire promotion ledger before deciding that any blob is unreachable. */
export function readCheckpointLedger(root: string): CheckpointLedgerEntry[] { return ledgerEntries(root, true); }
/** Collect only unreachable digest-named blobs under the same lock used for publication and promotion roots. */
export async function collectCheckpointArtifacts(root: string): Promise<{ retained: number; removed: number }> {
  return withArtifactLock(root, () => {
    const reachable = new Set(readCheckpointLedger(root).flatMap((entry) => entry.artifacts.map((ref) => ref.digest)));
    return artifactDirectory(root, ["artifacts", "pm-rl", "sha256"], (directory, _handles, verify) => {
    const targets = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name) && !reachable.has(`sha256:${name.slice(0, -5)}`)).map(name => {
      const path = `${directory}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) expectedFail("Checkpoint cleanup refuses linked files.", "rl_state_path_invalid");
      if (!stat.isFile()) expectedFail("Artifact cleanup requires ordinary files; restore the invalid target before retrying.", "checkpoint_artifact_corrupt");
      return path;
    });
    for (const path of targets) { verify(); unlinkSync(path); }
    return { retained: reachable.size, removed: targets.length };
    });
  });
}
