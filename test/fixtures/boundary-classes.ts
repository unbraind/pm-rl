/** Matrix-specific commutation proof for the closed write set of six native peer transitions. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Only observations whose values the matrix's peer transitions cannot change may share a region. */
export interface BoundaryClass { readonly kind: string; readonly commutes: boolean; readonly epoch: number }
/** Observe native history/data and owned lock generations; directory touch times and derived query telemetry are not state. */
function generation(root: string): string {
  const parts: string[] = [];
  /** Walk only this disposable tracker without following links. */
  function visit(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (relative === "" && entry.name === "runtime") continue;
      const name = join(relative, entry.name), stat = lstatSync(join(root, name), { bigint: true, throwIfNoEntry: false });
      if (stat === undefined) continue;
      parts.push(stat.isDirectory() ? `${name}:${stat.ino}:${stat.mode}` : `${name}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
      if (stat.isDirectory()) visit(name);
    }
  }
  visit(""); return createHash("sha256").update(parts.join("\n")).digest("hex");
}
/** Conservative native item write set for each of this matrix's six real peer transitions. */
export function peerAffects(transition: string, candidate: string, id: string): boolean {
  if (transition === "budget") return id === "rl-approval";
  if (transition === "seal") return id === `${candidate}-evaluation-plan`;
  if (transition === "sdk-reject") return id === candidate;
  if (transition === "reject") return id === candidate || /^(?:rl-)?policy-card-/.test(id);
  if (transition === "stop" || transition === "record-look") return id.startsWith(`${candidate}-evaluation-plan-look-`);
  return true;
}

/** This is deliberately limited to the closed peer write set in sequentialSnapshotMatrix, not a generic SDK optimizer. */
export class BoundaryClasses {
  readonly entries: BoundaryClass[] = [];
  private stamp = "";
  private epoch = 0;
  private readonly root: string;
  private readonly initial: ReadonlySet<string>;
  private readonly transition: string;
  private readonly candidate: string;
  /** Birth reads qualify only for items actually present in the prepared native inventory. */
  constructor(root: string, initial: ReadonlySet<string>, transition: string, candidate: string) { this.root = root; this.initial = initial; this.transition = transition; this.candidate = candidate; }
  /** Classify the actual observation without relying on completion order of parallel native reads. */
  classify(method: string, side: "before" | "after", args: readonly unknown[]): Omit<BoundaryClass, "epoch"> {
    const id = method === "history" ? (args[1] as { id?: unknown })?.id : args[0];
    const options = args[1];
    const birth = method === "get" && typeof id === "string" && this.initial.has(id) && options !== null && typeof options === "object" && "at" in options && options.at === "1";
    const stable = (method === "get" || method === "history") && typeof id === "string" && id.startsWith("rl-") && !peerAffects(this.transition, this.candidate, id);
    const setting = method === "config" && args[0] === "project" && args[1] === "get" && args[2] === "id_prefix";
    const category = birth ? "existing-birth" : stable ? "untouched-source" : setting ? "project-setting" : "mutable";
    return { kind: `${method}:${side}:${category}`, commutes: birth || stable || setting };
  }
  /** Retain every mutable observation/write; certify only project settings, untouched sources and existing immutable births. */
  record(method: string, side: "before" | "after", args: readonly unknown[]): void {
    const stamp = generation(this.root);
    if (stamp !== this.stamp) { this.epoch += 1; this.stamp = stamp; }
    this.entries.push({ ...this.classify(method, side, args), epoch: this.epoch });
  }
}
/** A peer can move across pure local calculations and unchanged observations until the next mutable edge or lease change. */
export function representativeBoundaries(entries: readonly BoundaryClass[], candidate: number, seed = 0x1071647): number[] {
  const selected = new Set<number>([0, entries.length - 1, candidate].filter(index => index >= 0));
  let region: number[] = [];
  const kinds = new Map<string, number[]>();
  /** Choose one deterministic witness per commuting region; no mutable read or write is sampled. */
  function flush(): void {
    if (region.length === 0) return;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; selected.add(region[seed % region.length]); region = [];
  }
  entries.forEach((entry, index) => {
    const group = kinds.get(entry.kind) ?? []; group.push(index); kinds.set(entry.kind, group);
    if (index > 0 && entry.epoch !== entries[index - 1].epoch) flush();
    if (entry.commutes) region.push(index); else { flush(); selected.add(index); }
  });
  flush();
  for (const group of kinds.values()) { selected.add(group[0]); selected.add(group[group.length - 1]); }
  if (entries.some((entry, index) => !entry.commutes && !selected.has(index))) throw new Error("A mutable SDK edge was omitted");
  return [...selected].sort((a, b) => a - b);
}
