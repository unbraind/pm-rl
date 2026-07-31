// Metric events, encoding, and the properties the rest of the package rests on.
//
// Two of these matter more than the others. The round-trip test is what lets the
// merge driver treat two encodings of one event as one note rather than two. The
// malformed-line test is what stops a run being recorded as complete while missing
// measurements nobody can enumerate afterwards.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertMetricEvent,
  decodeEvent,
  encodeEvent,
  MetricEventError,
  type MetricEvent,
  parseNdjsonStream,
  readSeries,
} from "../series.ts";

/** A valid event, so each test varies only the field it is about. */
const EVENT: MetricEvent = { step: 100, metric: "episode_return", value: 12.5 };

test("an event round-trips through the encoding unchanged", () => {
  for (const event of [
    EVENT,
    { ...EVENT, wallClockMs: 4_200 },
    { ...EVENT, tags: { arm: "b", seed: "7" } },
    { ...EVENT, wallClockMs: 0, tags: { arm: "a" } },
    { step: 0, metric: "loss", value: -0.5 },
  ] satisfies MetricEvent[]) {
    assert.deepEqual(decodeEvent(encodeEvent(event)), event, `${JSON.stringify(event)} must round-trip`);
  }
});

test("the encoding is canonical, so one logical event has exactly one text", () => {
  // This is what lets the merge driver union notes by content: two encodings of one
  // event would merge as two events, and the run would report a measurement twice.
  const built = encodeEvent({ step: 1, metric: "loss", value: 2, tags: { zeta: "z", alpha: "a" } });
  const rebuilt = encodeEvent({ tags: { alpha: "a", zeta: "z" }, value: 2, metric: "loss", step: 1 });
  assert.equal(built, rebuilt);
  // Absent optional fields are absent from the text rather than present as null, so
  // adding a field later does not rewrite every existing note.
  assert.equal(encodeEvent(EVENT), 'pm-rl/1 {"step":100,"metric":"episode_return","value":12.5}');
  // An empty tag map encodes as no tags at all, for the same reason.
  assert.equal(encodeEvent({ ...EVENT, tags: {} }), encodeEvent(EVENT));
});

test("an event that cannot be ordered or compared is refused before it is stored", () => {
  const cases: Array<[MetricEvent, string]> = [
    [{ ...EVENT, step: -1 }, "invalid_step"],
    [{ ...EVENT, step: 1.5 }, "invalid_step"],
    [{ ...EVENT, step: Number.NaN }, "invalid_step"],
    [{ ...EVENT, metric: "" }, "invalid_metric"],
    [{ ...EVENT, value: Number.NaN }, "invalid_value"],
    [{ ...EVENT, value: Number.POSITIVE_INFINITY }, "invalid_value"],
    [{ ...EVENT, wallClockMs: -1 }, "invalid_wall_clock"],
    [{ ...EVENT, wallClockMs: Number.NaN }, "invalid_wall_clock"],
    [{ ...EVENT, tags: { "": "x" } }, "invalid_tag"],
    [{ ...EVENT, tags: { arm: 7 as unknown as string } }, "invalid_tag"],
  ];
  for (const [event, code] of cases) {
    assert.throws(
      () => assertMetricEvent(event),
      (error: unknown) => error instanceof MetricEventError && error.code === code,
      `${JSON.stringify(event)} must be refused as ${code}`,
    );
    // Encoding validates too, so an invalid event cannot reach storage by that route.
    assert.throws(() => encodeEvent(event), MetricEventError);
  }
});

test("a diverged run is told to record its last finite value rather than log NaN", () => {
  // The remediation is folded into the message because a thrown error's separate
  // remediation field is replaced by a generic host line.
  assert.throws(
    () => encodeEvent({ ...EVENT, value: Number.NaN }),
    (error: unknown) => error instanceof MetricEventError && /last finite value/.test(error.message),
  );
});

test("a note that is not an event is not an error, but one claiming to be is", () => {
  // A person can comment on a run item. Treating their sentence as corrupt telemetry
  // would make the series unreadable.
  assert.equal(decodeEvent("Looks like the reward spec is wrong here."), null);
  assert.equal(decodeEvent(""), null);
  assert.equal(decodeEvent("pm-rl/2 {}"), null, "a different envelope version is not this one's business");

  for (const [text, expected] of [
    ["pm-rl/1 not json at all", /not JSON/],
    ["pm-rl/1 [1,2]", /must be a JSON object/],
    ["pm-rl/1 null", /must be a JSON object/],
    ['pm-rl/1 {"step":1}', /numeric step, a string metric and a numeric value/],
    ['pm-rl/1 {"step":"1","metric":"m","value":1}', /numeric step/],
    ['pm-rl/1 {"step":-1,"metric":"m","value":1}', /non-negative integer/],
  ] as Array<[string, RegExp]>) {
    assert.throws(
      () => decodeEvent(text),
      (error: unknown) => error instanceof MetricEventError && expected.test(error.message),
      `${text} must be refused by ${expected}`,
    );
  }
});

test("surrounding whitespace does not change whether a note decodes", () => {
  assert.deepEqual(decodeEvent(`  ${encodeEvent(EVENT)}\n`), EVENT);
});

test("an NDJSON stream parses in order, ignoring blank lines", () => {
  const stream = [
    '{"step":0,"metric":"loss","value":2.5}',
    "",
    '{"step":1,"metric":"loss","value":2.1,"wall_clock_ms":1200}',
    '{"step":1,"metric":"episode_return","value":9,"tags":{"arm":"a"}}',
    "",
  ].join("\n");
  const events = parseNdjsonStream(stream);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => `${event.step}:${event.metric}`), ["0:loss", "1:loss", "1:episode_return"]);
  assert.equal(events[1]!.wallClockMs, 1_200);
  assert.deepEqual(events[2]!.tags, { arm: "a" });
  // A trailing newline is not an error: every trainer emits one.
  assert.deepEqual(parseNdjsonStream(""), []);
  assert.deepEqual(parseNdjsonStream("\n\n"), []);
});

test("a malformed stream line fails the whole parse and names the line", () => {
  // Skipping the line would record the run as complete while missing measurements
  // nobody can enumerate afterwards, and the gap would be invisible in every later
  // comparison. The line number is what makes it fixable.
  const cases: Array<[string, RegExp]> = [
    ['{"step":0,"metric":"loss","value":1}\nnot json\n', /^Line 2 is not valid JSON/],
    ['{"step":0,"metric":"loss","value":1}\n[1,2]\n', /^Line 2 is not a JSON object/],
    ['{"step":0,"metric":"loss","value":1}\n{"step":1}\n', /^Line 2 is missing a numeric step/],
    ['{"step":0,"metric":"loss","value":1}\n{"step":-1,"metric":"m","value":1}\n', /^Line 2: A step must be/],
    ['{"step":0,"metric":"loss","value":1}\n\n\n{"step":1,"metric":"","value":1}', /^Line 4: A metric name/],
  ];
  for (const [stream, expected] of cases) {
    assert.throws(
      () => parseNdjsonStream(stream),
      (error: unknown) => error instanceof MetricEventError
        && error.code === "malformed_line"
        && expected.test(error.message),
      `${JSON.stringify(stream)} must be refused by ${expected}`,
    );
  }
});

test("a run's series orders by step, not by the order notes happened to arrive", () => {
  // Two agents appending concurrently produce interleaved notes after a merge, so
  // storage order is not the run's order. Step is.
  const notes = [
    encodeEvent({ step: 2, metric: "loss", value: 1 }),
    encodeEvent({ step: 0, metric: "loss", value: 3 }),
    encodeEvent({ step: 1, metric: "loss", value: 2 }),
  ];
  const { events, comments } = readSeries(notes);
  assert.deepEqual(events.map((event) => event.step), [0, 1, 2]);
  assert.equal(comments, 0);
});

test("two measurements at one step keep the order they were stored in", () => {
  // Ties break on arrival so the result is a function of the input rather than of a
  // sort implementation's stability.
  const notes = [
    encodeEvent({ step: 5, metric: "b", value: 1 }),
    encodeEvent({ step: 5, metric: "a", value: 2 }),
  ];
  assert.deepEqual(readSeries(notes).events.map((event) => event.metric), ["b", "a"]);
});

test("a series reports how many notes were not events instead of hiding them", () => {
  // "400 events" and "400 events and 12 notes I could not read" are different
  // statements, and a caller may need the second one.
  const notes = [
    "A human left this here.",
    encodeEvent(EVENT),
    "And this.",
  ];
  const result = readSeries(notes);
  assert.equal(result.events.length, 1);
  assert.equal(result.comments, 2);
});

test("a duplicate measurement survives, because two identical events are two events", () => {
  // The merge driver unions notes by content, so this is also the case where a
  // content-keyed dedupe would silently drop a real measurement.
  const note = encodeEvent(EVENT);
  const { events } = readSeries([note, note]);
  assert.equal(events.length, 2);
});
