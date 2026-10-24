/** Bounded decoding for untrusted JSON and package-owned tracker records. */
import type { PmClient } from "@unbrained/pm-cli/sdk/core";

/** Content-free explanation of a tracker record omitted from discovery. */
export interface SkippedTrackerRecord { readonly id: string; readonly reason: "foreign_type" | "foreign_tag" | "foreign_format" | "oversized" | "too_deep" | "invalid_json" | "invalid_shape" }
const skipped = new WeakMap<PmClient, Map<string, SkippedTrackerRecord>>();
/** Inspect omissions accumulated by SDK entry points without copying foreign bodies. */
export function skippedTrackerRecords(client: PmClient): readonly SkippedTrackerRecord[] { return [...(skipped.get(client)?.values() ?? [])]; }
/** Bound nesting before parsing, ignoring brackets inside JSON strings. */
function depthSafe(text: string): boolean {
  let depth = 0; let quoted = false; let escaped = false;
  for (const char of text) {
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === "{" || char === "[")) { depth += 1; if (depth > 64) return false; }
    if (!quoted && (char === "}" || char === "]")) depth -= 1;
  }
  return true;
}
/** The single JSON parser boundary; callers retain their domain-specific refusal vocabulary. */
export function parseBoundedJson(text: string): unknown {
  if (Buffer.byteLength(text) > 16_777_216 || !depthSafe(text)) throw new SyntaxError("JSON exceeds decoding bounds");
  return JSON.parse(text) as unknown;
}
/** Decode only the named package envelope, recording safe omissions before any domain code runs. */
export function decodeTrackerRecord(client: PmClient | null, item: { readonly id?: string; readonly type?: unknown; readonly tags?: unknown; readonly body?: unknown }, contract: { readonly type: string; readonly tag?: string; readonly format?: string; readonly valid?: (value: Record<string, unknown>) => boolean }): Record<string, unknown> | null {
  /** Retain one bounded reason per identity, independent of repeated resume reads. */
  function omit(reason: SkippedTrackerRecord["reason"]): null {
    if (client !== null) { const records = skipped.get(client) ?? new Map<string, SkippedTrackerRecord>(); records.set(String(item.id), { id: String(item.id), reason }); skipped.set(client, records); }
    return null;
  }
  if (item.type !== contract.type) return omit("foreign_type");
  if (contract.tag !== undefined && (!Array.isArray(item.tags) || !item.tags.includes(contract.tag))) return omit("foreign_tag");
  const text = String(item.body);
  if (Buffer.byteLength(text) > 1_048_576) return omit("oversized");
  if (contract.format !== undefined && !text.includes(JSON.stringify(contract.format))) return omit("foreign_format");
  if (!depthSafe(text)) return omit("too_deep");
  let value: unknown;
  try { value = parseBoundedJson(text); } catch { return omit("invalid_json"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return omit("invalid_shape");
  const record = value as Record<string, unknown>;
  if (contract.format !== undefined && record.format !== contract.format) return omit("foreign_format");
  try { if (contract.valid !== undefined && !contract.valid(record)) return omit("invalid_shape"); } catch { return omit("invalid_shape"); }
  return record;
}
