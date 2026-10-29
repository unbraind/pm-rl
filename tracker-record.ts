/** Bounded decoding for untrusted JSON and package-owned tracker records. */
import { createPmCliExpectedError, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

/** Maximum UTF-8 payload accepted by the package JSON reader. */
export const MAX_JSON_BYTES = 16_777_216;
/** Discovery readers deliberately impose a smaller bound on tracker envelopes. */
export const MAX_TRACKER_RECORD_BYTES = 1_048_576;
/** Stable producer refusals consumed by SDK callers and CLI agents. */
export type JsonEncodingRefusal = "json_record_limit" | "json_record_invalid";

/** Content-free explanation of a tracker record omitted from discovery. */
export interface SkippedTrackerRecord { readonly id: string; readonly reason: "foreign_type" | "foreign_identity" | "foreign_tag" | "foreign_format" | "oversized" | "too_deep" | "invalid_json" | "invalid_shape" }
const skipped = new WeakMap<object, Map<string, SkippedTrackerRecord>>();
/** Inspect omissions accumulated by SDK entry points without copying foreign bodies. */
export function skippedTrackerRecords(client: object): readonly SkippedTrackerRecord[] { return [...(skipped.get(client)?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id)); }
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
/** One byte/depth contract serves readers and producers, including narrower discovery envelopes. */
function encodingProblem(text: string, maximumBytes: number): "oversized" | "too_deep" | null {
  if (Buffer.byteLength(text) > maximumBytes) return "oversized";
  return depthSafe(text) ? null : "too_deep";
}
/** Refuse an unreadable complete encoding before opening a file, reserving state or changing a target. */
export function assertJsonEncoding(text: string, maximumBytes = MAX_JSON_BYTES): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_JSON_BYTES) invalidJson();
  const reason = encodingProblem(text, maximumBytes);
  if (reason !== null) throw createPmCliExpectedError(`JSON record refused (json_record_limit): exceeds its reader limit of ${maximumBytes} UTF-8 bytes or 64 levels. Reduce or split the payload before retrying; sealed evaluations require a new plan and fresh candidate.`, { exitCode: EXIT_CODE.USAGE, context: { code: "json_record_limit", reason } });
  return text;
}
/** Serialize exactly the bytes the matching reader can decode; preserve historical ordering and whitespace. */
export function encodeBoundedJson(value: unknown, maximumBytes = MAX_JSON_BYTES, space?: number): string {
  let text: string | undefined;
  try { text = JSON.stringify(value, null, space); } catch { invalidJson(); }
  if (text === undefined) invalidJson();
  return assertJsonEncoding(text, maximumBytes);
}
/** Serialization failures never expose caller content or leave an empty persistent file behind. */
function invalidJson(): never { throw createPmCliExpectedError("JSON record refused (json_record_invalid): unsupported value or encoding options. Supply a JSON value and an integer byte budget from 1 to 16777216 before retrying.", { exitCode: EXIT_CODE.USAGE, context: { code: "json_record_invalid" } }); }
/** Recognize the constructor's bounded format/id header without parsing a foreign body. */
export function hasTrackerIdentity(item: { readonly id?: string; readonly body?: unknown }, format: string, resolveId: (id: string) => string): boolean {
  const header = /^\s*\{\s*"format"\s*:\s*"([^"]+)"\s*,\s*"id"\s*:\s*"([^"]+)"/.exec(String(item.body).slice(0, 1024));
  if (header === null || header[1] !== format) return false;
  return item.id === resolveId(header[2]);
}

/** The single JSON parser boundary; callers retain their domain-specific refusal vocabulary. */
export function parseBoundedJson(text: string): unknown {
  if (encodingProblem(text, MAX_JSON_BYTES) !== null) throw new SyntaxError("JSON exceeds decoding bounds");
  return JSON.parse(text) as unknown;
}
/** Decode only the named package envelope; large Plan envelopes may use the existing 16 MiB parser bound. */
export function decodeTrackerRecord(client: object | null, item: { readonly id?: string; readonly type?: unknown; readonly tags?: unknown; readonly body?: unknown }, contract: { readonly type: string; readonly tag?: string; readonly legacy?: boolean; readonly namespace?: (id: string) => boolean; readonly format?: string; readonly maxBytes?: 16_777_216; readonly valid?: (value: Record<string, unknown>) => boolean }): Record<string, unknown> | null {
  /** Retain one bounded reason per identity, independent of repeated resume reads. */
  function omit(reason: SkippedTrackerRecord["reason"]): null {
    if (client !== null) { const records = skipped.get(client) ?? new Map<string, SkippedTrackerRecord>(); records.set(String(item.id), { id: String(item.id), reason }); skipped.set(client, records); }
    return null;
  }
  if (item.type !== contract.type) return omit("foreign_type");
  if (contract.namespace !== undefined && !contract.namespace(String(item.id))) return omit("foreign_identity");
  if (contract.tag !== undefined && (!Array.isArray(item.tags) || !item.tags.includes(contract.tag)) && contract.legacy !== true) return omit("foreign_tag");
  const text = String(item.body);
  if (Buffer.byteLength(text) > (contract.maxBytes ?? MAX_TRACKER_RECORD_BYTES)) return omit("oversized");
  if (contract.format !== undefined && !text.includes(JSON.stringify(contract.format))) return omit("foreign_format");
  if (!depthSafe(text)) return omit("too_deep");
  let value: unknown;
  try { value = parseBoundedJson(text); } catch { return omit("invalid_json"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return omit("invalid_shape");
  const record = value as Record<string, unknown>;
  if (contract.format !== undefined && record.format !== contract.format) return omit("foreign_format");
  try { if (contract.valid !== undefined && !contract.valid(record)) return omit("invalid_shape"); } catch { return omit("invalid_shape"); }
  if (client !== null) skipped.get(client)?.delete(String(item.id));
  return record;
}
