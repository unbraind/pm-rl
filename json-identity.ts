/** Dependency-free canonical identities shared with the sealed proposer process. */
import { createHash } from "node:crypto";
/** JSON values accepted by the existing content-addressing contract. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };
/**
 * Serialize JSON with recursively byte-ordered object keys.
 *
 * A content identity must be independent of property insertion order. Arrays
 * remain ordered because task and reward sequences can be semantically ordered.
 */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/** SHA-256 identity of a JSON value's canonical encoding. */
export function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

