/**
 * Behavioral tests for the physical Git identity audit.
 *
 * Every case imports the gate's exported functions and runs them in-process
 * against a throwaway repository, because the properties worth protecting are
 * exactly the ones a subprocess run would miss: that the audit finds
 * unreachable objects, fails closed on unapproved addresses, and ignores
 * replacement refs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  auditGitIdentities,
  collectGitIdentities,
  GitObjectInventory,
  IdentityBatchParser,
  isMainInvocation,
  main,
  maskAddress,
  streamProcess,
  type GitObject,
} from "../scripts/audit-git-identities.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

/** Runs Git in a disposable real repository and returns trimmed output. */
function git(root: string, arguments_: readonly string[], input?: string): string {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8", input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Creates a repository with one public commit and its matching allowlist. */
function repository(): { root: string; allowlist: string; first: string } {
  dir = makeTempDir();
  const root = dir.root;
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Public"]);
  git(root, ["config", "user.email", "public@example.test"]);
  writeFileSync(join(root, "file"), "first");
  git(root, ["add", "file"]);
  git(root, ["commit", "-qm", "first"]);
  const allowlist = join(root, "approved.txt");
  writeFileSync(allowlist, "public@example.test\n");
  return { root, allowlist, first: git(root, ["rev-parse", "HEAD"]) };
}

/** Encodes one raw object using Git's batch-response protocol. */
function batch(object: GitObject, body: string, separator = "\n"): Buffer {
  return Buffer.from(`${object.id} ${object.type} ${Buffer.byteLength(body)}\n${body}${separator}`);
}

test("identity audit accepts an allowlisted reachable history", async () => {
  const { root, allowlist } = repository();
  await assert.doesNotReject(auditGitIdentities(root, allowlist));
});

test("identity audit fails closed on an unapproved identity even when an approved authoring identity is allowlisted", async () => {
  // An allowlist that carries an approved public authoring identity must not
  // become a rubber stamp: any address absent from the file is still rejected.
  const { root } = repository();
  const allowlist = join(root, "approved.txt");
  writeFileSync(
    allowlist,
    [
      "# approved public authoring identity",
      "public@example.test",
      "approved@authoring.identity",
    ].join("\n"),
  );
  git(root, ["config", "user.email", "unapproved@example.test"]);
  writeFileSync(join(root, "file"), "second");
  git(root, ["commit", "-qam", "second"]);
  await assert.rejects(
    auditGitIdentities(root, allowlist),
    /rejected 1 non-public address\(es\): u\*\*\*@example\.test\./,
  );
});

test("identity audit accepts an initialized repository with no commits", async () => {
  dir = makeTempDir();
  git(dir.root, ["init", "-q"]);
  const allowlist = join(dir.root, "approved.txt");
  writeFileSync(allowlist, "public@example.test\n");
  await assert.doesNotReject(auditGitIdentities(dir!.root, allowlist));
});

test("identity audit finds unreachable ancestors and ignores replacement refs", async () => {
  const { root, allowlist, first } = repository();
  git(root, ["config", "user.email", "private@example.test"]);
  writeFileSync(join(root, "file"), "private");
  git(root, ["commit", "-qam", "private"]);
  const privateCommit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["config", "user.email", "public@example.test"]);
  writeFileSync(join(root, "file"), "public child");
  git(root, ["commit", "-qam", "public child"]);
  git(root, ["replace", privateCommit, first]);
  git(root, ["reset", "--hard", "-q", first]);
  await assert.rejects(
    auditGitIdentities(root, allowlist),
    /rejected 1 non-public address/,
  );
});

test("identity inventory refuses malformed commits and unusable repositories", async () => {
  const { root } = repository();
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], "malformed\n");
  await assert.rejects(collectGitIdentities(root), /exactly one well-formed author identity/);
  await assert.rejects(collectGitIdentities(join(root, "missing")), /git .*cat-file.*failed/);
});

test("identity inventory rejects a multi-angle commit identity", async () => {
  const { root } = repository();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const timestamp = "0 +0000";
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], [
    `tree ${tree}`,
    `author Public <private@example.test> <public@example.test> ${timestamp}`,
    `committer Public <public@example.test> ${timestamp}`,
    "",
    "message",
    "",
  ].join("\n"));
  await assert.rejects(collectGitIdentities(root), /exactly one well-formed author identity/);
});

test("identity inventory rejects duplicate commit identity headers", async () => {
  const { root } = repository();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const timestamp = "0 +0000";
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], [
    `tree ${tree}`,
    `author Public <public@example.test> ${timestamp}`,
    `author Duplicate <public@example.test> ${timestamp}`,
    `committer Public <public@example.test> ${timestamp}`,
    "",
    "message",
    "",
  ].join("\n"));
  await assert.rejects(collectGitIdentities(root), /exactly one well-formed author identity/);
});

test("identity inventory ignores identity-shaped commit message lines", async () => {
  const { root } = repository();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const timestamp = "0 +0000";
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], [
    `tree ${tree}`,
    `author Public <public@example.test> ${timestamp}`,
    `committer Public <public@example.test> ${timestamp}`,
    "",
    `author Impostor <message@example.test> ${timestamp}`,
    `committer Impostor <message@example.test> ${timestamp}`,
    "",
  ].join("\n"));
  assert.deepEqual(await collectGitIdentities(root), new Set(["public@example.test"]));
});

test("identity inventory streams a large commit message after parsing its header", async () => {
  const { root } = repository();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const timestamp = "0 +0000";
  git(root, ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], [
    `tree ${tree}`,
    `author Public <public@example.test> ${timestamp}`,
    `committer Public <public@example.test> ${timestamp}`,
    "",
    "x".repeat(2 * 1024 * 1024),
    "",
  ].join("\n"));
  assert.deepEqual(await collectGitIdentities(root), new Set(["public@example.test"]));
});

test("identity inventory rejects an oversized unterminated identity header", async () => {
  const { root } = repository();
  git(
    root,
    ["hash-object", "--literally", "-w", "-t", "commit", "--stdin"],
    `author ${"x".repeat(1024 * 1024)}\n`,
  );
  await assert.rejects(collectGitIdentities(root), /has an oversized identity header/);
});

test("identity inventory includes annotated taggers", async () => {
  const { root, allowlist } = repository();
  git(root, ["config", "user.email", "tagger-private@example.test"]);
  git(root, ["tag", "-am", "release", "v1"]);
  await assert.rejects(auditGitIdentities(root, allowlist), /rejected 1 non-public address/);
});

test("object inventory incrementally accepts commits and tags and ignores other objects", () => {
  const inventory = new GitObjectInventory();
  inventory.consume(Buffer.from("a".repeat(40)));
  inventory.consume(Buffer.from(` commit\n${"b".repeat(40)} blob\n${"c".repeat(40)} tag\n${"d".repeat(40)} tree\n`));
  assert.deepEqual(inventory.finish(), [
    { id: "a".repeat(40), type: "commit" },
    { id: "c".repeat(40), type: "tag" },
  ]);
});

test("object inventory refuses malformed complete records", () => {
  const inventory = new GitObjectInventory();
  assert.throws(
    () => inventory.consume(Buffer.from(`${"a".repeat(40)} unknown\n`)),
    /invalid object inventory record/,
  );
});

test("object inventory refuses a truncated final record", () => {
  const inventory = new GitObjectInventory();
  inventory.consume(Buffer.from(`${"a".repeat(40)} commit`));
  assert.throws(() => inventory.finish(), /truncated object inventory/);
});

test("batch parser validates chunked commits and annotated tags", () => {
  const commit = { id: "a".repeat(40), type: "commit" } as const;
  const tag = { id: "b".repeat(40), type: "tag" } as const;
  const bytes = Buffer.concat([
    batch(commit, "author Public <public@example.test> 0 +0000\ncommitter Public <public@example.test> 0 +0000\n\nmessage"),
    batch(tag, "object deadbeef\ntype commit\ntag release\ntagger Tagger <tagger@example.test> 0 +0000\n\nmessage"),
  ]);
  const parser = new IdentityBatchParser([commit, tag]);
  for (const byte of bytes) parser.consume(Buffer.of(byte));
  assert.deepEqual(parser.finish(), new Set(["public@example.test", "tagger@example.test"]));
});

test("batch parser rejects malformed protocol headers", () => {
  const object = { id: "a".repeat(40), type: "commit" } as const;
  for (const header of [
    "not-a-header\n",
    `${"b".repeat(40)} commit 1\n`,
    `${object.id} tag 1\n`,
  ]) {
    const parser = new IdentityBatchParser([object]);
    assert.throws(() => parser.consume(Buffer.from(header)), /invalid header/);
  }
  const unsafe = new IdentityBatchParser([object]);
  assert.throws(
    () => unsafe.consume(Buffer.from(`${object.id} commit 999999999999999999999\n`)),
    /invalid size/,
  );
});

test("batch parser rejects malformed tag identities and oversized tag headers", () => {
  const object = { id: "b".repeat(40), type: "tag" } as const;
  const malformed = new IdentityBatchParser([object]);
  assert.throws(() => malformed.consume(batch(object, "object deadbeef\n")), /well-formed tagger identity/);
  const oversized = new IdentityBatchParser([object]);
  assert.throws(
    () => oversized.consume(batch(object, `tagger ${"x".repeat(1024 * 1024)}`, "")),
    /Tag .* oversized identity header/,
  );
  const terminatedOversized = new IdentityBatchParser([object]);
  assert.throws(
    () => terminatedOversized.consume(batch(object, `tagger ${"x".repeat(1024 * 1024)}\n\nmessage`)),
    /Tag .* oversized identity header/,
  );
  const commit = { id: "a".repeat(40), type: "commit" } as const;
  const terminatedOversizedCommit = new IdentityBatchParser([commit]);
  assert.throws(
    () => terminatedOversizedCommit.consume(batch(commit, `author ${"x".repeat(1024 * 1024)}\n\nmessage`)),
    /Commit .* oversized identity header/,
  );
});

test("batch parser refuses missing separators, partial objects, and surplus bytes", () => {
  const object = { id: "a".repeat(40), type: "commit" } as const;
  const body = "author Public <public@example.test> 0 +0000\ncommitter Public <public@example.test> 0 +0000\n\nmessage";
  const missingSeparator = new IdentityBatchParser([object]);
  assert.throws(() => missingSeparator.consume(batch(object, body, "x")), /omitted the separator/);

  const missingObject = new IdentityBatchParser([object]);
  assert.throws(() => missingObject.finish(), /truncated or unrequested/);

  const partialObject = new IdentityBatchParser([object]);
  partialObject.consume(Buffer.from(`${object.id} commit ${Buffer.byteLength(body)}\npartial`));
  assert.throws(() => partialObject.finish(), /truncated or unrequested/);

  const surplus = new IdentityBatchParser([object]);
  surplus.consume(Buffer.concat([batch(object, body), Buffer.from("surplus")]));
  assert.throws(() => surplus.finish(), /truncated or unrequested/);
});

test("stream transport reports real spawn, exit, signal, consumer, and timeout failures", async () => {
  dir = makeTempDir();
  const options = { cwd: dir.root, timeoutMs: 1_000 };
  await assert.rejects(
    streamProcess(join(dir.root, "missing-command"), [], options, () => {}),
    /failed: spawn .* ENOENT/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "console.error('detail'); process.exit(2)"], options, () => {}),
    /failed: detail/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "process.exit(2)"], options, () => {}),
    /failed\.$/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], options, () => {}),
    /with SIGTERM/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "process.stdout.write('x')"], options, () => { throw "not-an-error"; }),
    /output consumer failed/,
  );
  await assert.rejects(
    streamProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeoutMs: 20 }, () => {}),
    /timed out after 20ms/,
  );
});

test("stream transport reports a real broken stdin pipe", async () => {
  dir = makeTempDir();
  await assert.rejects(
    streamProcess(
      process.execPath,
      ["-e", "process.stdin.destroy(); setTimeout(() => {}, 100)"],
      { cwd: dir.root, input: "x".repeat(16 * 1024 * 1024), timeoutMs: 1_000 },
      () => {},
    ),
    /stdin failed/,
  );
});

test("stream transport escalates a SIGTERM-ignoring child to SIGKILL after the timeout", async () => {
  // A child that swallows SIGTERM and keeps running survives the timeout's
  // SIGTERM and holds the stdio pipes open, which would hang the release gate
  // after the very timeout meant to bound it. A short escalation window fires
  // SIGKILL and terminates the child for real, so the promise rejects and the
  // process can drain. timeoutMs is large enough that the child has installed
  // its SIGTERM handler before the timeout fires.
  dir = makeTempDir();
  await assert.rejects(
    streamProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { cwd: dir.root, timeoutMs: 200, escalationMs: 100 },
      () => {},
    ),
    /timed out after 200ms/,
  );
});

test("maskAddress elides the local part and masks malformed input", () => {
  // The audit never publishes a full rejected address; masking keeps the first
  // character and domain so a rejection is identifiable, and falls back to
  // `***` for input without a usable local part.
  assert.equal(maskAddress("stefan@preu.at"), "s***@preu.at");
  assert.equal(maskAddress("ab@host.test"), "a***@host.test");
  assert.equal(maskAddress("@host.test"), "***");
  assert.equal(maskAddress("no-at-sign"), "***");
});

test("main invocation detection resolves matching, different, and absent scripts", () => {
  dir = makeTempDir();
  const script = join(dir.root, "audit-git-identities.ts");
  const other = join(dir.root, "other.ts");
  writeFileSync(script, "");
  writeFileSync(other, "");
  const url = pathToFileURL(script).href;
  assert.equal(isMainInvocation(["node", script], url), true);
  assert.equal(isMainInvocation(["node", other], url), false);
  assert.equal(isMainInvocation(["node"], url), false);
});

test("command main succeeds for a public repository and marks a refusal", async () => {
  const { root, allowlist } = repository();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  await main(root, allowlist);
  assert.equal(process.exitCode, undefined);
  await main(root, join(root, "missing-allowlist"));
  assert.equal(process.exitCode, 1);
  process.exitCode = previousExitCode;
});

// The repository's real allowlist, used to prove the Dependabot approval is a
// data-file change rather than a code change: the gate accepts a genuine
// Dependabot commit because the address is listed, and reverts red because the
// address is not. Resolving the path from the test file keeps the test honest
// against a checkout rather than hard-coding a path that could drift.
const realAllowlist = resolve(import.meta.dirname, "..", ".github", "approved-git-identities.txt");

/** The exact noreply address Dependabot authors dependency-bump commits with. */
const DEPENDABOT_IDENTITY = "49699333+dependabot[bot]@users.noreply.github.com";

test("the repository allowlist approves a genuine dependabot[bot] commit", async () => {
  // A Dependabot pull request introduces its own commit object into the CI
  // checkout's object database, and the audit inspects every physical object,
  // so the gate fails unless the bot's address is allowlisted. This test runs
  // against the real .github/approved-git-identities.txt and goes red if that
  // entry is reverted: the audit would then reject the Dependabot identity.
  dir = makeTempDir();
  const root = dir.root;
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "dependabot[bot]"]);
  git(root, ["config", "user.email", DEPENDABOT_IDENTITY]);
  writeFileSync(join(root, "package-lock.json"), "{}");
  git(root, ["add", "package-lock.json"]);
  git(root, ["commit", "-qm", "chore(deps): bump a dependency"]);
  await assert.doesNotReject(auditGitIdentities(root, realAllowlist));
});

test("the repository allowlist still rejects an unknown human identity beside the Dependabot entry", async () => {
  // Approving the Dependabot address must not weaken the gate: an unknown human
  // identity is still rejected against the real allowlist. This test is
  // independent of the Dependabot entry (it holds a single human commit), so
  // it passes whether or not the bot is listed. Paired with the approval test
  // above and the near-miss bot test below, the three pin the smallest correct
  // change: the approved bot passes, the human does not, and a different bot
  // does not either.
  dir = makeTempDir();
  const root = dir.root;
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Local Developer"]);
  git(root, ["config", "user.email", "steve@laptop.local"]);
  writeFileSync(join(root, "file"), "work");
  git(root, ["add", "file"]);
  git(root, ["commit", "-qm", "local work"]);
  await assert.rejects(
    auditGitIdentities(root, realAllowlist),
    /rejected 1 non-public address\(es\): s\*\*\*@laptop\.local\./,
  );
});

test("the repository allowlist rejects an unapproved GitHub-style bot identity, so a noreply wildcard cannot pass", async () => {
  // The human-identity test above does not catch a wildcard that accepts every
  // *@users.noreply.github.com address, because steve@laptop.local is not a
  // noreply address. A near-miss bot identity -- same domain, different
  // user-id and bot name -- is rejected by the exact-address entry and would
  // be accepted by such a wildcard, so this test goes red if the allowlist is
  // weakened from the exact Dependabot address to a domain-wide pattern.
  dir = makeTempDir();
  const root = dir.root;
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "somebody[bot]"]);
  git(root, ["config", "user.email", "12345678+somebody[bot]@users.noreply.github.com"]);
  writeFileSync(join(root, "file"), "work");
  git(root, ["add", "file"]);
  git(root, ["commit", "-qm", "bot work"]);
  await assert.rejects(
    auditGitIdentities(root, realAllowlist),
    /rejected 1 non-public address\(es\): 1\*\*\*@users\.noreply\.github\.com\./,
  );
});