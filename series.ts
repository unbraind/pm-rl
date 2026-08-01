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
// A note holds text. Legacy `pm-rl/1` notes contain one canonical event; current
// `pm-rl/2` notes contain a deflate-raw segment of canonical NDJSON.
// Segments cap their uncompressed payload, so sustained logging adds a bounded
// number of bounded notes rather than one history member per measurement.

import { deflateRawSync, inflateRawSync } from "node:zlib";

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
const EVENT_ENVELOPE = "pm-rl/1";

/** Marker distinguishing a compressed event segment from every other note. */
const SEGMENT_ENVELOPE = "pm-rl/2";

/** Maximum canonical NDJSON bytes represented by one merge-safe history note. */
export const MAX_SEGMENT_UNCOMPRESSED_BYTES = 48 * 1024;

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
  return `${EVENT_ENVELOPE} ${JSON.stringify(body)}`;
}

/**
 * Split measurements into canonical, bounded history segments.
 *
 * The byte limit is applied to the canonical NDJSON before compression. This
 * caps decompression memory and makes the storage contract independent of how
 * compressible a particular trainer's metric names and tags happen to be.
 *
 * @param events - Validated measurements in trainer arrival order.
 * @returns Non-empty segments whose canonical payloads fit the byte limit.
 * @throws MetricEventError When one event alone exceeds the segment bound.
 */
export function segmentEvents(events: readonly MetricEvent[]): readonly (readonly MetricEvent[])[] {
  const segments: MetricEvent[][] = [];
  let segment: MetricEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const encoded = encodeEvent(event).slice(EVENT_ENVELOPE.length + 1);
    const eventBytes = Buffer.byteLength(encoded);
    if (eventBytes > MAX_SEGMENT_UNCOMPRESSED_BYTES) {
      throw new MetricEventError(
        "event_too_large",
        `One canonical metric event occupies ${eventBytes} bytes; the maximum is ${MAX_SEGMENT_UNCOMPRESSED_BYTES}. Shorten metric names or tags.`,
      );
    }
    const separatorBytes = segment.length === 0 ? 0 : 1;
    if (bytes + separatorBytes + eventBytes > MAX_SEGMENT_UNCOMPRESSED_BYTES) {
      segments.push(segment);
      segment = [];
      bytes = 0;
    }
    segment.push(event);
    bytes += (segment.length === 1 ? 0 : 1) + eventBytes;
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

/**
 * Encode one non-empty, already bounded segment as a canonical note.
 *
 * @param events - Measurements in trainer arrival order.
 * @returns A `pm-rl/2` note with a canonical payload, suitable for repeatable-note merging.
 * @throws MetricEventError When the segment is empty or exceeds the byte bound.
 */
export function encodeEventSegment(events: readonly MetricEvent[]): string {
  if (events.length === 0) {
    throw new MetricEventError("empty_segment", "A metric segment must contain at least one event.");
  }
  const segments = segmentEvents(events);
  if (segments.length !== 1 || segments[0]!.length !== events.length) {
    throw new MetricEventError(
      "segment_too_large",
      `A metric segment exceeds the ${MAX_SEGMENT_UNCOMPRESSED_BYTES}-byte canonical payload limit. Split it with segmentEvents first.`,
    );
  }
  const payload = events.map((event) => encodeEvent(event).slice(EVENT_ENVELOPE.length + 1)).join("\n");
  return `${SEGMENT_ENVELOPE} ${deflateRawSync(payload, { level: 9 }).toString("base64url")}`;
}

/**
 * Decode one compressed segment, or report that a note uses another format.
 *
 * The inflate operation enforces the same byte ceiling as the writer, preventing
 * an externally written note from turning a small payload into unbounded memory.
 * Rebuilding the canonical NDJSON must reproduce the decoded payload byte-for-byte,
 * which rejects malformed or non-canonical producers without depending on one
 * zlib version choosing the same valid compressed representation as another.
 *
 * @param text - One note's text.
 * @returns Segment events in arrival order, or null for a non-segment note.
 * @throws MetricEventError When a `pm-rl/2` note is corrupt or non-canonical.
 */
export function decodeEventSegment(text: string): readonly MetricEvent[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(`${SEGMENT_ENVELOPE} `)) return null;
  try {
    const payload = inflateRawSync(
      Buffer.from(trimmed.slice(SEGMENT_ENVELOPE.length + 1), "base64url"),
      { maxOutputLength: MAX_SEGMENT_UNCOMPRESSED_BYTES },
    ).toString("utf8");
    const events = parseNdjsonStream(payload);
    const canonicalPayload = events.map((event) => encodeEvent(event).slice(EVENT_ENVELOPE.length + 1)).join("\n");
    if (events.length === 0 || canonicalPayload !== payload) {
      throw new MetricEventError("noncanonical_segment", "A metric segment is empty or not canonically encoded.");
    }
    return events;
  } catch (error) {
    if (error instanceof MetricEventError) throw error;
    throw new MetricEventError(
      "malformed_segment",
      `A compressed metric segment could not be decoded within the ${MAX_SEGMENT_UNCOMPRESSED_BYTES}-byte bound.`,
    );
  }
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
  if (!trimmed.startsWith(`${EVENT_ENVELOPE} `)) return null;
  const payload = trimmed.slice(EVENT_ENVELOPE.length + 1);
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
    const segment = decodeEventSegment(text);
    if (segment !== null) {
      for (const event of segment) decoded.push({ event, arrival: decoded.length });
      continue;
    }
    const event = decodeEvent(text);
    if (event !== null) decoded.push({ event, arrival: decoded.length });
    else comments += 1;
  }
  decoded.sort((left, right) => (
    left.event.step === right.event.step ? left.arrival - right.arrival : left.event.step - right.event.step
  ));
  return { events: decoded.map((entry) => entry.event), comments };
}
