// Metric events: the one shape the whole package is built around.
//
// A training run emits a monotonically growing series of measurements, and where
// that series is stored decides whether two agents can write it concurrently. It
// goes into the tracker's repeatable `notes` collection, which the shipped merge
// driver unions — verified against a real git merge rather than assumed: one item,
// two branches off a common base, two events appended on each side, and all four
// present afterwards with zero conflicts.
//
// It does *not* go into an item's body. A body is a scalar field, so two writers
// conflict on every write, and a conflicted body is unparseable — one concurrent
// log would take the whole item with it.
//
// A note holds text, so an event is canonically encoded on the way in and decoded
// on the way out. Canonical means one logical event has exactly one encoding: keys
// in a fixed order, no insignificant whitespace, one representation per number.
// Without that, re-encoding an unchanged event would present as a change, and the
// merge driver would see two members where there is one.

/** Optional labels attached to one measurement, ordered canonically on encode. */
export type EventTags = Readonly<Record<string, string>>;

/** One measurement from a training run. */
export interface MetricEvent {
  /**
   * Which step of the run produced the measurement.
   *
   * Non-negative and integral. A run's steps are its own clock, and a fractional
   * or negative step cannot be ordered against the rest of the series.
   */
  readonly step: number;
  /** What was measured, e.g. `episode_return`. Never empty. */
  readonly metric: string;
  /** The measured value. Finite: neither NaN nor an infinity is a measurement. */
  readonly value: number;
  /** Milliseconds of wall clock since the run started, when the trainer reports it. */
  readonly wallClockMs?: number;
  /** Labels distinguishing measurements that share a metric name, e.g. an arm or a seed. */
  readonly tags?: EventTags;
}

/** Why an event or a stream line was rejected. */
export class MetricEventError extends Error {
  /** Machine-readable reason, stable across message wording. */
  readonly code: string;

  /**
   * @param code - Machine-readable reason.
   * @param message - Human-readable explanation, including the remediation, since a
   *   thrown error's separate remediation field is replaced by a generic host line.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "MetricEventError";
    this.code = code;
  }
}

/** Marker distinguishing an encoded event from any other note text. */
const ENVELOPE = "pm-rl/1";

/**
 * Rejects an event that cannot be stored, ordered or compared.
 *
 * Validation happens before encoding rather than at read time on purpose: a
 * malformed event that reaches storage is indistinguishable from a deliberate one
 * afterwards, and the run it belongs to is the only context that could have
 * explained it.
 *
 * @param event - The candidate event.
 * @throws MetricEventError When a field is absent, of the wrong kind, or holds a
 *   value that cannot be ordered — a negative or fractional step, a non-finite
 *   value, an empty metric name, or a tag whose key or value is not a string.
 */
export function assertMetricEvent(event: MetricEvent): void {
  if (!Number.isInteger(event.step) || event.step < 0) {
    throw new MetricEventError(
      "invalid_step",
      `A step must be a non-negative integer; got ${String(event.step)}. Report the trainer's global step count.`,
    );
  }
  if (event.metric.length === 0) {
    throw new MetricEventError(
      "invalid_metric",
      "A metric name cannot be empty. Name what was measured, for example episode_return.",
    );
  }
  if (!Number.isFinite(event.value)) {
    throw new MetricEventError(
      "invalid_value",
      `A metric value must be finite; got ${String(event.value)}. `
      + "A diverged run should be recorded as finished with its last finite value rather than logged as NaN.",
    );
  }
  if (event.wallClockMs !== undefined && (!Number.isFinite(event.wallClockMs) || event.wallClockMs < 0)) {
    throw new MetricEventError(
      "invalid_wall_clock",
      `A wall-clock reading must be a non-negative finite number of milliseconds; got ${String(event.wallClockMs)}.`,
    );
  }
  for (const [key, value] of Object.entries(event.tags ?? {})) {
    if (key.length === 0) {
      throw new MetricEventError("invalid_tag", "A tag key cannot be empty.");
    }
    if (typeof value !== "string") {
      throw new MetricEventError(
        "invalid_tag",
        `Tag ${key} holds ${typeof value}; tags are strings, so a numeric label must be recorded as a metric instead.`,
      );
    }
  }
}

/**
 * Encodes an event as the exact text one note will hold.
 *
 * The encoding is canonical, which is a correctness requirement rather than
 * tidiness: the merge driver unions notes by their content, so two encodings of one
 * logical event would merge as two events. Keys are emitted in a fixed order and
 * tags are sorted, so the text is a function of the event alone and never of the
 * order the trainer happened to build the object in.
 *
 * @param event - The event to encode.
 * @returns Note text beginning with the envelope marker.
 * @throws MetricEventError When the event is not storable.
 */
export function encodeEvent(event: MetricEvent): string {
  assertMetricEvent(event);
  const body: Record<string, unknown> = { step: event.step, metric: event.metric, value: event.value };
  if (event.wallClockMs !== undefined) body.wall_clock_ms = event.wallClockMs;
  if (event.tags !== undefined) {
    const keys = Object.keys(event.tags).sort();
    if (keys.length > 0) {
      const tags: Record<string, string> = {};
      for (const key of keys) tags[key] = event.tags[key] as string;
      body.tags = tags;
    }
  }
  return `${ENVELOPE} ${JSON.stringify(body)}`;
}

/**
 * Decodes note text back into an event, or reports that it is not one.
 *
 * Returns null rather than throwing for text that is not an encoded event, because
 * a note that is not an event is an ordinary and expected thing: a person can
 * comment on a run item, and treating their sentence as corrupt telemetry would
 * make the series unreadable. Text that *claims* to be an event and is malformed
 * does throw — that is a producer bug, and silence would lose a measurement.
 *
 * @param text - One note's text.
 * @returns The event, or null when the text is not an encoded event at all.
 * @throws MetricEventError When the text carries the envelope marker but its payload
 *   is not a storable event.
 */
export function decodeEvent(text: string): MetricEvent | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(`${ENVELOPE} `)) return null;
  const payload = trimmed.slice(ENVELOPE.length + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new MetricEventError(
      "malformed_event",
      `An event envelope carried text that is not JSON: ${payload.slice(0, 80)}. The note was written by something other than pm-rl.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MetricEventError("malformed_event", "An event payload must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.step !== "number" || typeof record.metric !== "string" || typeof record.value !== "number") {
    throw new MetricEventError(
      "malformed_event",
      "An event payload must carry a numeric step, a string metric and a numeric value.",
    );
  }
  const event: MetricEvent = {
    step: record.step,
    metric: record.metric,
    value: record.value,
    ...(record.wall_clock_ms === undefined ? {} : { wallClockMs: record.wall_clock_ms as number }),
    ...(record.tags === undefined ? {} : { tags: record.tags as EventTags }),
  };
  assertMetricEvent(event);
  return event;
}

/**
 * Parses a trainer's newline-delimited JSON into events.
 *
 * NDJSON on stdin is the whole integration surface: any trainer in any language can
 * pipe into it with no client library, which is what keeps this package a tracker
 * rather than a framework.
 *
 * A malformed line fails the whole parse, naming the line number and the reason.
 * Skipping it would be worse than useless — the run would be recorded as complete
 * while missing measurements nobody can enumerate afterwards, and the gap would be
 * invisible in every later comparison.
 *
 * @param text - The stream's contents. Blank lines are ignored, so a trailing
 *   newline is not an error.
 * @returns The events, in the order they arrived.
 * @throws MetricEventError When a non-blank line is not a storable event, naming its
 *   one-based line number.
 */
export function parseNdjsonStream(text: string): MetricEvent[] {
  const events: MetricEvent[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new MetricEventError(
        "malformed_line",
        `Line ${index + 1} is not valid JSON: ${line.slice(0, 80)}. Each line must be one JSON object with step, metric and value.`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MetricEventError(
        "malformed_line",
        `Line ${index + 1} is not a JSON object. Each line must be one object with step, metric and value.`,
      );
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.step !== "number" || typeof record.metric !== "string" || typeof record.value !== "number") {
      throw new MetricEventError(
        "malformed_line",
        `Line ${index + 1} is missing a numeric step, a string metric or a numeric value.`,
      );
    }
    const candidate: MetricEvent = {
      step: record.step,
      metric: record.metric,
      value: record.value,
      ...(record.wall_clock_ms === undefined ? {} : { wallClockMs: record.wall_clock_ms as number }),
      ...(record.tags === undefined ? {} : { tags: record.tags as EventTags }),
    };
    try {
      assertMetricEvent(candidate);
    } catch (error) {
      throw new MetricEventError(
        "malformed_line",
        `Line ${index + 1}: ${(error as MetricEventError).message}`,
      );
    }
    events.push(candidate);
  }
  return events;
}

/** A run's decoded series, with what could not be read reported rather than hidden. */
export interface SeriesReadResult {
  /** The events, ordered by step and then by the order the notes were stored. */
  readonly events: readonly MetricEvent[];
  /** Notes that were not encoded events — ordinary comments on the item. */
  readonly comments: number;
}

/**
 * Decodes a run's notes into its series.
 *
 * Ordering is by step, with ties broken by storage order. Two agents appending
 * concurrently produce interleaved notes, so storage order alone is not the run's
 * order; step is. Ties keep arrival order so the result is a function of the input
 * rather than of a sort's stability.
 *
 * The count of non-event notes is returned rather than discarded, because "this run
 * has 400 events" and "this run has 400 events and 12 notes I could not read" are
 * different statements and a caller may need the second one.
 *
 * @param notes - The note texts, in storage order.
 * @returns The ordered events and the number of notes that were not events.
 * @throws MetricEventError When a note claims to be an event and is malformed.
 */
export function readSeries(notes: readonly string[]): SeriesReadResult {
  const decoded: Array<{ event: MetricEvent; arrival: number }> = [];
  let comments = 0;
  for (const text of notes) {
    const event = decodeEvent(text);
    if (event === null) {
      comments += 1;
      continue;
    }
    decoded.push({ event, arrival: decoded.length });
  }
  decoded.sort((left, right) => (
    left.event.step === right.event.step ? left.arrival - right.arrival : left.event.step - right.event.step
  ));
  return { events: decoded.map((entry) => entry.event), comments };
}
