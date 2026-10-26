/** Shared identifier and filesystem boundaries for package-owned state. */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { commitWorkspaceTransaction, type CommitWorkspaceTransactionOptions, looksLikeGenericKeyValueEntry, parseCsvKv } from "@unbrained/pm-cli/sdk";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { acquireLock as sdkAcquireLock, createPmCliExpectedError, EXIT_CODE, getHistoryPath } from "@unbrained/pm-cli/sdk/runtime";

/** Refuse unsafe state inputs without exposing their contents in diagnostics. */
function refused(code: "rl_identifier_invalid" | "rl_state_path_invalid"): never {
  const required = code === "rl_identifier_invalid"
    ? "Use a nonempty single identifier of at most 200 UTF-8 bytes, with letters, numbers, marks, dots, underscores or hyphens; no whitespace, encoding, separators or dot segments. Resolve pm item aliases through the SDK."
    : "Use a state root and descendants with no symbolic links; restore ordinary directories before retrying.";
  throw createPmCliExpectedError(`State boundary refused. ${required}`, { exitCode: EXIT_CODE.USAGE, context: { code, required } });
}
/** Validate one identity without trimming, decoding, substituting or truncating it. Native pm references also obey the SDK history-id contract. */
export function identifier(value: unknown, kind: "item" | "component" | "context" = "item"): string {
  const digestContext = kind === "context" && typeof value === "string" && /^(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?sha256:[a-f0-9]{64}$/.test(value);
  if (typeof value !== "string" || Buffer.byteLength(value) > (kind === "component" ? 255 : 200) || (!digestContext && !/^(?:#?[\p{L}\p{N}_-]|\.(?=[\p{L}\p{N}_-]))[\p{L}\p{N}\p{M}_.-]*$/u.test(value))) refused("rl_identifier_invalid");
  if (kind === "item") getHistoryPath(".", value);
  return value;
}
/** Join validated components beneath an explicit state root, rejecting symlinked roots, ancestors and leaves, including dangling links. */
export function statePath(root: string, ...components: string[]): string {
  components.forEach((part) => identifier(part, "component"));
  const base = resolve(root); const target = resolve(base, ...components);
  assertStatePathRoot(base, target);
  let cursor = target;
  for (;;) {
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) refused("rl_state_path_invalid");
    if (stat !== undefined && realpathSync(cursor) !== cursor) refused("rl_state_path_invalid");
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return target;
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
  for (const field of ["id", "parent", "blockedBy"]) {
    const reference = (value as Record<string, unknown>)[field];
    if (reference !== undefined && reference !== null) identifier(reference);
  }
  const dependencies = (value as Record<string, unknown>).dep;
  if (dependencies !== undefined) {
    if (!Array.isArray(dependencies) || dependencies.length > 10_000) refused("rl_identifier_invalid");
    for (const dependency of Array.from(dependencies)) {
      if (typeof dependency !== "string") refused("rl_identifier_invalid");
      identifier(looksLikeGenericKeyValueEntry(dependency) ? parseCsvKv(dependency, "--dep").id : dependency);
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
      if (typeof property === "string" && itemMethods.has(property)) identifier(args[0]);
      if (property === "create" || property === "update") sdkReferences(args[property === "create" ? 0 : 1]);
      return Reflect.apply(method, target, args);
    };
  } });
  guarded.set(client, proxy); guarded.set(proxy, proxy); return proxy;
}
/** Use the native token-owned SDK lease only after confining its lock and cleanup-gate paths; release revalidates confinement. */
export async function acquireStateLock(...args: Parameters<typeof sdkAcquireLock>): ReturnType<typeof sdkAcquireLock> {
  const [root, id] = args; identifier(id);
  const lock = statePath(root, "locks", `${id}.lock`);
  statePath(root, "locks", `${id}.lock.stale-cleanup`, "owner.json");
  const release = await sdkAcquireLock(...args);
  /** Native release reads its token under the SDK cleanup lease and cannot remove a successor. */
  return async () => { checkedStateFile(lock); statePath(root, "locks", `${id}.lock.stale-cleanup`, "owner.json"); await release(); };
}

/** Constrain the native journal and writer lease without adding process-tool requirements to SDK-only operations. */
export function commitStateTransaction(options: CommitWorkspaceTransactionOptions): ReturnType<typeof commitWorkspaceTransaction> {
  identifier(options.transactionId); options.steps.forEach((step) => identifier(step.id));
  statePath(options.pmRoot, "transactions", "sdk", `${options.transactionId}.json`);
  statePath(options.pmRoot, "locks", "sdk-workspace-transaction.lock");
  statePath(options.pmRoot, "locks", "sdk-workspace-transaction.lock.stale-cleanup", "owner.json");
  return commitWorkspaceTransaction(options);
}
