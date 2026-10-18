/** Real Git snapshots prove visibility refusal, prefix isolation, provenance and repository-disjoint splits. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildTrackerDataset, readTrackerDataset, readTrackerSplit, TRACKER_SPLITS, trackerFeature, trackerHistoryExample, type TrackerDataset, type TrackerExample } from "../dataset.ts";
import { hashJson, type JsonValue } from "../index.ts";
import { git, withTrackerSources } from "./fixtures/meta-workspace.ts";

test("history extraction sees only the pre-terminal prefix, never future states or free text", () => {
  const lines = ["open", "in_progress", "closed", "blocked"].map((value) => JSON.stringify({ patch: [{ path: "/metadata/status", value }, { path: "/metadata/description", value: "private fixture text" }] })).join("\n");
  const example = trackerHistoryExample(lines, "public-fixture/pm-alpha", "c".repeat(40), "item")!;
  assert.deepEqual(example.prefix, ["open", "in_progress"]); assert.equal(example.label, "completed");
  assert.ok(!JSON.stringify(example).includes("private fixture text"));
  assert.equal(trackerHistoryExample('{"patch":[{"path":"/metadata/status","value":"closed"}]}', "repo", "commit", "item"), null);
  assert.equal(trackerHistoryExample('{}\n{"patch":[]}', "repo", "commit", "item"), null);
  assert.equal(trackerHistoryExample('{"patch":[{"op":"remove","path":"/metadata/status"}]}', "repo", "commit", "item"), null);
  assert.throws(() => trackerHistoryExample('{"patch":[{"path":"/metadata/status","value":"unknown"}]}', "repo", "commit", "item"), /unknown_status/);
  assert.ok(trackerFeature({ ...example, prefix: ["open", "blocked"] }) < 0);
  assert.ok(Math.abs(trackerFeature(example)) <= 0.5);
});

test("builder reads committed public MIT histories, records source commits and isolates repositories", async () => {
  await withTrackerSources(async ({ root, directories }) => {
    writeFileSync(join(directories[0], "history/item-0.jsonl"), "uncommitted garbage");
    writeFileSync(join(directories[0], "history/untracked.jsonl"), "untracked garbage");
    const directory = join(root, "dataset"); const manifest = buildTrackerDataset(directories, directory);
    assert.deepEqual(readTrackerDataset(directory), manifest);
    const rebuilt = buildTrackerDataset([...directories].reverse(), join(root, "other"));
    assert.deepEqual(rebuilt, manifest);
    const sets = new Map(TRACKER_SPLITS.map((split) => [split, new Set(readTrackerSplit(directory, manifest, split).map((example) => example.repo))]));
    for (const held of ["meta-validation", "final-test"] as const) {
      for (const repo of sets.get(held)!) assert.ok(!sets.get("train")!.has(repo) && !sets.get("inner-held-out")!.has(repo));
    }
    assert.equal(new Set([...sets.get("meta-validation")!].filter((repo) => sets.get("final-test")!.has(repo))).size, 0);
    for (const source of manifest.sources) assert.match(source.commit, /^[a-f0-9]{40}$/);
    assert.throws(() => buildTrackerDataset(directories, directory), /EEXIST/);
    assert.throws(() => buildTrackerDataset([directories[0], directories[0], directories[1]], join(root, "duplicate")), /duplicate_repo/);
  });
});

test("builder fails before reading histories from private, unlicensed, hosted or excluded sources", async () => {
  await withTrackerSources(async ({ root, directories }) => {
    for (const property of ["RL_FIXTURE_VISIBILITY", "RL_FIXTURE_NO_LICENSE"]) {
      process.env[property] = property === "RL_FIXTURE_VISIBILITY" ? "PRIVATE" : "1";
      try { assert.throws(() => buildTrackerDataset(directories, join(root, property)), /public_mit_required/); }
      finally { delete process.env[property]; }
    }
    for (const count of [0, 2, 65]) assert.throws(() => buildTrackerDataset(Array.from({ length: count }, () => directories[0]), join(root, `count-${count}`)), /dataset_bounds/);
    for (const seed of [-1, 1.1, 0x100000000]) assert.throws(() => buildTrackerDataset(directories, join(root, "seed"), seed), /dataset_bounds/);
    for (const name of ["pm-hosted-data", "pm-web", "pm-gpt"]) {
      const path = join(root, name, ".agents/pm"); mkdirSync(path, { recursive: true });
      assert.throws(() => buildTrackerDataset([path, directories[1], directories[2]], join(root, name + "-output")), /forbidden_source/);
    }
    assert.throws(() => buildTrackerDataset([dirname(directories[0]), directories[1], directories[2]], join(root, "bad-dir")), /tracker_directory/);
    const project = dirname(dirname(directories[0]));
    git(project, ["remote", "set-url", "origin", "https://example.test/repo"]);
    assert.throws(() => buildTrackerDataset(directories, join(root, "foreign")), /github_source/);
    for (const repo of ["pm-web", "pm-gpt", "pm-cli"]) {
      git(project, ["remote", "set-url", "origin", `git@github.com:public-fixture/${repo}.git`]);
      assert.throws(() => buildTrackerDataset(directories, join(root, repo + "-remote")), /excluded_repo/);
    }
  });
});

test("dataset readers refuse content drift, label leakage and forged repository assignments", async () => {
  await withTrackerSources(async ({ root, directories }) => {
    const directory = join(root, "dataset"); const manifest = buildTrackerDataset(directories, directory);
    const file = join(directory, "train.json"); const original = JSON.parse(readFileSync(file, "utf8")) as TrackerExample[];
    writeFileSync(file, "[]"); assert.throws(() => readTrackerSplit(directory, manifest, "train"), /split_identity/);
    for (const examples of [[], [original[0], original[0]], [{ ...original[0], repo: "foreign" }], [{ ...original[0], commit: "wrong" }],
      [{ ...original[0], label: "wrong" }], [{ ...original[0], prefix: [] }], [{ ...original[0], prefix: ["closed"] }]]) {
      writeFileSync(file, JSON.stringify(examples));
      const modified = { ...manifest, splits: { ...manifest.splits, train: { digest: hashJson(examples as unknown as JsonValue), count: examples.length } } };
      assert.throws(() => readTrackerSplit(directory, modified, "train"));
    }
    const otherRole = manifest.sources.find((source) => source.role === "final-test")!;
    const leaked = [{ ...original[0], repo: otherRole.repo, commit: otherRole.commit }];
    writeFileSync(file, JSON.stringify(leaked));
    assert.throws(() => readTrackerSplit(directory, { ...manifest, splits: { ...manifest.splits, train: { count: 1, digest: hashJson(leaked as unknown as JsonValue) } } }, "train"), /repo_leakage/);
    const manifestFile = join(directory, "dataset.json");
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, seed: 100 })); assert.throws(() => readTrackerDataset(directory), /manifest_identity/);
    for (const patch of [{ format: "wrong" }, { task: "wrong" }, { sources: [manifest.sources[0], manifest.sources[0]] }]) {
      const { digest: _digest, ...record } = { ...manifest, ...patch };
      writeFileSync(manifestFile, JSON.stringify({ ...record, digest: hashJson(record as unknown as JsonValue) }));
      assert.throws(() => readTrackerDataset(directory));
    }
    const missingLicense = { ...manifest, sources: manifest.sources.map((source) => ({ ...source, license: "bad" })) } as unknown as TrackerDataset;
    writeFileSync(file, JSON.stringify(original)); assert.throws(() => readTrackerSplit(directory, missingLicense, "train"), /repo_leakage/);
  });
});

test("source limits refuse empty histories and unreachable public commit identities", async () => {
  await withTrackerSources(async ({ root, gh, directories }) => {
    const project = dirname(dirname(directories[0]));
    writeFileSync(gh, `#!${process.execPath}\nconsole.log(process.argv[2]==='api'?'wrong':JSON.stringify({visibility:'PUBLIC',licenseInfo:{key:'mit'},nameWithOwner:process.argv[4]}));\n`); chmodSync(gh, 0o755);
    assert.throws(() => buildTrackerDataset(directories, join(root, "unreachable")), /public_commit_required/);
    git(project, ["remote", "set-url", "origin", "git@github.com:public-fixture/pm-alpha"]);
  });
});

test("empty public histories are recorded as omissions and inadequate prefix diversity refuses a split", async () => {
  await withTrackerSources(async ({ root, directories }) => {
    /** Commit a new tiny source once; existing append-only histories remain untouched. */
    const source = (name: string, terminal: boolean): string => {
      const project = join(root, `pm-${name}`); const directory = join(project, ".agents/pm/history"); mkdirSync(directory, { recursive: true });
      const states = terminal ? ["open", "closed"] : ["open"];
      writeFileSync(join(directory, "item.jsonl"), states.map((value) => JSON.stringify({ patch: [{ path: "/metadata/status", value }] })).join("\n"));
      writeFileSync(join(directory, "ignored.txt"), "not a history stream");
      git(project, ["init", "-q"]); git(project, ["remote", "add", "origin", `https://github.com/public-fixture/pm-${name}.git`]);
      git(project, ["add", ".agents/pm/history"]); git(project, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Synthetic bounded history"]);
      return join(project, ".agents/pm");
    };
    const empty = source("empty", false);
    const manifest = buildTrackerDataset([...directories, empty], join(root, "with-omission"));
    assert.equal(manifest.omitted_sources.length, 1); assert.equal(manifest.omitted_sources[0].repo, "public-fixture/pm-empty");
    assert.throws(() => buildTrackerDataset([empty, directories[0], directories[1]], join(root, "too-few")), /eligible_sources/);
    const identical = [source("one", true), source("two", true), source("three", true)];
    assert.throws(() => buildTrackerDataset(identical, join(root, "no-diversity")), /split_size/);
  });
});
