/** Shared identifier and filesystem boundaries for package-owned state. */
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { commitWorkspaceTransaction, type CommitWorkspaceTransactionOptions, looksLikeGenericKeyValueEntry, parseCsvKv } from "@unbrained/pm-cli/sdk";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { acquireLock as sdkAcquireLock, acquireLockLease as sdkAcquireLockLease, createPmCliExpectedError, EXIT_CODE, getHistoryPath, normalizeRawItemId, normalizeItemId, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { decodeTrackerRecord } from "./tracker-record.ts";

/** Domain projection shared by SDK decision reads and explanation citations. @internal */
export const DECISION_INPUT_FIELDS = "id,type,body,affected_version,component,environment,notes,created_at,tags";

/** Stored schemas retain their previous language; only new declarations opt into tighter rules. */
export type ValidationMode = "read" | "write";
/** Apply new identity rules only to a write, preserving the released parser's trimming on reads. @internal */
export function schemaIdentity(value: string, kind: "item" | "artifact" | "context" | "cohort", mode: ValidationMode): string { return mode === "write" ? identifier(value, kind) : value.trim(); }
/** Refuse only the specific unsafe SDK/path operation, identifying its legacy value. @internal */
export function operationIdentifier(value: unknown, kind: "item" | "component" | "digest" = "item", mode: ValidationMode = "read"): string {
  try {
    if (kind !== "item") return identifier(value, kind);
    const native = identifier(mode === "read" && typeof value === "string" ? normalizeRawItemId(value) : value, "component"); // Existing SDK filenames may exceed the new-write 200-byte limit.
    getHistoryPath(".", native);
    return normalizeRawItemId(native);
  }
  catch {
    const named = typeof value === "string" ? value.length <= 1024 ? value : `${value.slice(0, 1024)}…` : `<${value === null ? "null" : typeof value}>`;
    const required = "Use a safe SDK item reference, state component or content digest for this operation; inspect or export the stored record without changing its sealed data.";
    throw createPmCliExpectedError(`Cannot use legacy value ${JSON.stringify(named)} for this operation. ${required}`, { exitCode: EXIT_CODE.USAGE, context: { code: "rl_identifier_invalid", value: named, required } });
  }
}
/** Refuse unsafe state inputs without exposing their contents in diagnostics. */
function refused(code: "rl_identifier_invalid" | "rl_state_path_invalid"): never {
  const required = code === "rl_identifier_invalid"
    ? "Use a nonempty single identifier of at most 200 UTF-8 bytes, with letters, numbers, marks, dots, underscores or hyphens; no whitespace, encoding, separators or dot segments. Resolve pm item aliases through the SDK. Checkpoint digests require sha256: followed by 64 lowercase hex digits."
    : "Use a nonempty NUL-free state root of at most 4096 UTF-8 bytes and descendants with no symbolic links; restore ordinary directories before retrying.";
  throw createPmCliExpectedError(`State boundary refused. ${required}`, { exitCode: EXIT_CODE.USAGE, context: { code, required } });
}
/** Validate one identity without trimming, decoding, substituting or truncating it. Native pm references also obey the SDK history-id contract. */
export function identifier(value: unknown, kind: "item" | "component" | "context" | "artifact" | "digest" | "cohort" = "item"): string {
  if (kind === "digest") {
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) refused("rl_identifier_invalid");
    return value;
  }
  const digestContext = typeof value === "string" && ((kind === "context" && /^(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?sha256:[a-f0-9]{64}$/.test(value)) || (kind === "artifact" && /^sha256:(?:[\p{L}\p{N}_-]|\.(?=[\p{L}\p{N}_-]))[\p{L}\p{N}\p{M}_.-]*$/u.test(value)));
  if (typeof value !== "string" || Buffer.byteLength(value) > (kind === "component" ? 255 : 200) || (!digestContext && !/^(?:#?[\p{L}\p{N}_-]|\.(?=[\p{L}\p{N}_-]))[\p{L}\p{N}\p{M}_.-]*$/u.test(value))) refused("rl_identifier_invalid");
  if (kind === "item") getHistoryPath(".", value);
  return kind === "item" ? normalizeRawItemId(value) : value;
}
/** Resolve a stored native identity through the SDK, refusing unsafe operations with the original value. */
export function canonicalIdentifier(value: string): string { return operationIdentifier(value, "item", "write"); }
/** Resolve an item reference with the configured SDK prefix before deriving item keys or hashes. */
export function canonicalItemIdentifier(value: string, prefix: string): string { return operationIdentifier(normalizeItemId(operationIdentifier(value), identifier(prefix))); }
/** Project a canonical native id into the package's logical namespace using the SDK's own prefix. */
export function canonicalNamespaceIdentifier(value: string, prefix: string): string { return operationIdentifier(canonicalItemIdentifier(value, prefix).slice(normalizeItemId("", prefix).length)); }
/** Resolve a logical programme name through the SDK and retain its prefix-free package namespace. */
export async function canonicalProgrammeId(client: PmClient, value: string): Promise<string> {
  operationIdentifier(value, "item", "write");
  const config = await identifierClient(client).config("project", "get", "id_prefix");
  const prefix = identifier(config.nested_setting!.value);
  return canonicalNamespaceIdentifier(value, prefix);
}
/** Parse version-one step names using SDK equality for each identity, preserving the stored spelling. */
export function programmeStepName(key: string, prefix: string, expected: string, phase?: string): string | null {
  operationIdentifier(key);
  for (let at = key.indexOf("-step-"); at >= 0; at = key.indexOf("-step-", at + 1)) {
    const stored = key.slice(0, at);
    if (stored !== "" && canonicalItemIdentifier(stored, prefix) === canonicalItemIdentifier(expected, prefix) && (phase === undefined || operationIdentifier(key.slice(at + 6)) === operationIdentifier(phase))) return stored;
  }
  return null;
}
/** Recover a version-one logical namespace from SDK birth records; never project stored names anew. */
export async function preservedProgrammeId(client: PmClient, value: string): Promise<string> {
  operationIdentifier(value);
  const config = await identifierClient(client).config("project", "get", "id_prefix");
  const prefix = identifier(config.nested_setting!.value);
  /** Read immutable creation evidence, preserving the SDK's omission and operational refusals. */
  async function original(id: string) {
    const result = await identifierClient(client).get(id, { at: "1", full: true, outputBudget: "unbounded", outputLimit: "unbounded" }).catch((error: unknown) => {
      if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) return null;
      throw error;
    });
    if (result === null) return null;
    if (!("item" in result)) throw createPmCliExpectedError("Programme identity history was omitted; retry with a complete SDK read before resuming.", { exitCode: EXIT_CODE.CONFLICT, context: { code: "provenance_read_retryable" } });
    const row = decodeTrackerRecord(client, result.item, { type: "Decision", format: "pm-rl/loop-step/1", valid: row => typeof row.key === "string" && canonicalItemIdentifier(row.key, prefix) === result.item.id });
    return row === null ? null : row.key as string;
  }
  const coordinate = canonicalItemIdentifier(value, prefix);
  for (const suffix of ["-step-programme", "-g1-step-collect", "-g1-step-train"]) {
    const key = await original(`${coordinate}${suffix}`);
    if (key !== null && key.endsWith(suffix)) { const stored = key.slice(0, -suffix.length); operationIdentifier(stored); return stored; }
  }
  const namespace = canonicalItemIdentifier(`${coordinate}-step`, prefix);
  const items = (await identifierClient(client).listAllComplete({ includeBody: false })).items
    .filter(item => item.type === "Decision" && item.id.startsWith(`${namespace}-`)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  for (const item of items) {
    const key = await original(item.id); if (key === null) continue;
    const stored = programmeStepName(key, prefix, value);
    if (stored !== null) return stored;
  }
  operationIdentifier(value, "item", "write");
  return value;
}
/** Validate native references while preserving version-one logical names and digest inputs exactly. */
export async function programmeRequest<T extends { readonly id: string; readonly approval: string }>(client: PmClient, request: T): Promise<T> {
  operationIdentifier(request.id); operationIdentifier(request.approval);
  const config = await identifierClient(client).config("project", "get", "id_prefix");
  const prefix = identifier(config.nested_setting!.value);
  canonicalItemIdentifier(request.id, prefix); canonicalItemIdentifier(request.approval, prefix);
  return { ...request, id: await preservedProgrammeId(client, request.id) };
}
/** Join validated components beneath an explicit state root, rejecting symlinked roots, ancestors and leaves, including dangling links. */
export function statePath(root: string, ...components: (string | StoredStateComponent)[]): string {
  if (typeof root !== "string" || root.length === 0 || Buffer.byteLength(root) > 4096 || root.includes("\0")) refused("rl_state_path_invalid");
  const names = components.map((part) => {
    if (typeof part === "string") return operationIdentifier(part, "component");
    if (part === null || typeof part !== "object" || !storedComponents.has(part)) refused("rl_state_path_invalid");
    return part.value;
  });
  const base = resolve(root); const target = resolve(base, ...names);
  assertStatePathRoot(base, target);
  try {
    let cursor = target;
    for (;;) {
      const stat = lstatSync(cursor, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) refused("rl_state_path_invalid");
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  } catch { refused("rl_state_path_invalid"); }
  return target;
}
const STORED_COMPONENT = Symbol("SDK-certified version-one filename");
/** A legacy filename retains the spelling recorded in an already verified native record. @internal */
export interface StoredStateComponent { readonly value: string; readonly [STORED_COMPONENT]: true }
const storedComponents = new WeakSet<StoredStateComponent>();
/** Validate a stored SDK reference without renaming its existing state directory. @internal */
export function storedStateComponent(value: string): StoredStateComponent {
  operationIdentifier(value);
  if (Buffer.byteLength(value) > 255) operationIdentifier(value, "component");
  const part = Object.freeze({ value, [STORED_COMPONENT]: true as const }); storedComponents.add(part); return part;
}
/** Assert resolved lexical confinement independently of identifier shape. @internal */
export function assertStatePathRoot(root: string, target: string): void {
  const suffix = relative(root, target);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) refused("rl_state_path_invalid");
}
/** Recheck an already constructed leaf immediately before an effect or cleanup. */
export function checkedStateFile(file: string): string { return statePath(dirname(file), basename(file)); }

const guarded = new WeakMap<PmClient, PmClient>();
const itemMethods = new Set(["get", "update", "claim", "release", "close", "reopen", "delete", "deleteItem", "restore", "comments", "notes", "learnings", "files", "docs", "deps", "startTask", "pauseTask", "closeTask", "copy", "append"]);
/** Validate native SDK mutation/reference fields once on entry, leaving canonical resolution and semantics to the SDK. */
function sdkReferences(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const field of ["id", "parent", "blockedBy", "environment"]) {
    const reference = (value as Record<string, unknown>)[field];
    if (reference !== undefined && reference !== null) { if (field === "id" || typeof reference !== "string") identifier(reference); else operationIdentifier(reference, "item", "write"); }
  }
  const dependencies = (value as Record<string, unknown>).dep;
  if (dependencies !== undefined) {
    if (!Array.isArray(dependencies) || dependencies.length > 10_000) refused("rl_identifier_invalid");
    for (const dependency of Array.from(dependencies)) {
      if (typeof dependency !== "string") refused("rl_identifier_invalid");
      operationIdentifier(looksLikeGenericKeyValueEntry(dependency) ? parseCsvKv(dependency, "--dep").id : dependency, "item", "write");
    }
  }
}
/** Delegate to the real SDK after rejecting unsafe identifiers, including callers of the typed SDK surface. */
export function identifierClient(client: PmClient): PmClient {
  const existing = guarded.get(client); if (existing !== undefined) return existing;
  const proxy = new Proxy(client, { get(target, property) {
    const method: unknown = Reflect.get(target, property, target);
    if (typeof method !== "function") return method;
    /** Preserve the SDK receiver while guarding identifiers before any SDK action. */
    return (...args: unknown[]) => {
      if (typeof property === "string" && itemMethods.has(property)) { if (typeof args[0] === "string") operationIdentifier(args[0]); else identifier(args[0]); }
      if (property === "create" || property === "update") sdkReferences(args[property === "create" ? 0 : 1]);
      return Reflect.apply(method, target, args);
    };
  } });
  guarded.set(client, proxy); guarded.set(proxy, proxy); return proxy;
}
/** Use the native token-owned SDK lease only after confining its lock and cleanup-gate paths; release revalidates confinement. */
export async function acquireStateLock(...args: Parameters<typeof sdkAcquireLock>): ReturnType<typeof sdkAcquireLock> {
  const [root, rawId] = args; const id = canonicalIdentifier(rawId);
  const lock = statePath(root, "locks", `${id}.lock`);
  statePath(root, "locks", `${id}.lock.stale-cleanup`, "owner.json");
  const release = await sdkAcquireLock(root, id, ...args.slice(2) as [number, string, boolean?, boolean?, number?]);
  /** Native release reads its token under the SDK cleanup lease and cannot remove a successor. */
  return async () => { checkedStateFile(lock); statePath(root, "locks", `${id}.lock.stale-cleanup`, "owner.json"); await release(); };
}

/** Confine the SDK's fenceable lease and revalidate its paths at each ownership boundary. */
export async function acquireStateLease(...args: Parameters<typeof sdkAcquireLockLease>): ReturnType<typeof sdkAcquireLockLease> {
  const [root, rawId, ...policy] = args; const id = canonicalIdentifier(rawId);
  const lock = statePath(root, "locks", `${id}.lock`);
  statePath(root, "locks", `${id}.lock.stale-cleanup`, "owner.json");
  const lease = await sdkAcquireLockLease(root, id, ...policy);
  return {
    /** Enter the native ownership fence before executing a guarded SDK write. */
    async fence<T>(execute: () => Promise<T>): Promise<T> {
      checkedStateFile(lock);
      return lease.fence(async () => { checkedStateFile(lock); return execute(); });
    },
    /** Release only the SDK generation owned by this lease inside its confined root. */
    async release(): Promise<void> { checkedStateFile(lock); statePath(root, "locks", `${id}.lock.stale-cleanup`, "owner.json"); await lease.release(); },
  };
}

/** Constrain the native journal and writer lease without adding process-tool requirements to SDK-only operations. */
export function commitStateTransaction(options: CommitWorkspaceTransactionOptions): ReturnType<typeof commitWorkspaceTransaction> {
  operationIdentifier(options.transactionId, "component"); options.steps.forEach((step) => operationIdentifier(step.id, "component"));
  statePath(options.pmRoot, "transactions", "sdk", `${options.transactionId}.json`);
  statePath(options.pmRoot, "locks", "sdk-workspace-transaction.lock");
  statePath(options.pmRoot, "locks", "sdk-workspace-transaction.lock.stale-cleanup", "owner.json");
  return commitWorkspaceTransaction(options);
}
