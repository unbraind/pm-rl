/** Executable examples, path aliases and fresh replay destinations remain safe in real trackers. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkTransferBoundaries } from "./fixtures/transfer-boundary-consumer.ts";
import { replayDiagnosticMain, requireDiagnosticScratch } from "./fixtures/transfer-replay.ts";
import { withTransferScratch } from "./fixtures/transfer-scratch.ts";
import { parseProposerEvolutionConfig } from "../proposer-evolution.ts";

test("runnable documentation and shipped examples declare the same feasible prospective design", () => {
  const config = parseProposerEvolutionConfig(JSON.parse(readFileSync(new URL("../examples/proposer-program.json", import.meta.url), "utf8")));
  assert.ok(config.transfer !== undefined);
  const guide = readFileSync(new URL("../docs/proposer-programs.md", import.meta.url), "utf8");
  const declaration = /transfer: \{ effect: ([\d.]+), alpha: ([\d.]+), power: ([\d.]+) \}/.exec(guide);
  assert.ok(declaration, "SDK run example must explicitly predeclare its design");
  assert.deepEqual({ effect: Number(declaration[1]), alpha: Number(declaration[2]), power: Number(declaration[3]) }, config.transfer);
  const minimum = Math.ceil(2 * (Math.sqrt(Math.log(4 * (config.generations + 1) / config.transfer.alpha)) + Math.sqrt(Math.log(1 / (1 - config.transfer.power)))) ** 2 / (config.transfer.effect - 0.01) ** 2);
  for (const file of ["README.md", "docs/proposer-programs.md", "docs/proposer-transfer.md"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\s+/g, " ");
    for (const count of [`${minimum} independent trackers per task at each look`, `${minimum * 2 * config.generations} meta tasks`, `${minimum * 2} audit tasks`]) {
      assert.ok(text.replace(`${minimum} trackers`, `${minimum} independent trackers`).includes(count), `${file}: ${count}`);
    }
  }
});

test("shipped examples and every source path alias share SDK and CLI preflight", { timeout: 240_000 }, async () => {
  await withTransferScratch("transfer-boundaries-", async (scratch) => {
    assert.deepEqual(await checkTransferBoundaries(scratch, resolve(import.meta.dirname, "../examples")), { examples: 1, paths: 48, native_replay: true });
  });
});

test("diagnostic replay rejects every occupied scratch project before copying or tracker writes", async () => {
  await withTransferScratch("transfer-fresh-", async (physical) => {
    const scratch = join(physical, "alias"); symlinkSync(physical, scratch, "dir");
    const receipt = resolve(import.meta.dirname, "../docs/proposer-transfer-receipt.json");
    const bin = join(scratch, "bin"); mkdirSync(bin);
    const log = join(scratch, "source-command"); const gh = join(bin, "gh");
    writeFileSync(gh, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)},'preflight'); process.exit(71);\n`); chmodSync(gh, 0o755);
    const originalPath = process.env.PATH; process.env.PATH = `${bin}:${originalPath}`;
    try {
      for (const name of ["sentinel", "sources", "dataset", ".agents"]) {
        const project = join(scratch, name); mkdirSync(project);
        if (name === "sentinel") writeFileSync(join(project, name), "untouched");
        else mkdirSync(join(project, name));
        const root = join(project, ".agents/pm");
        assert.equal(requireDiagnosticScratch(root), join(realpathSync(project), ".agents/pm"));
        const before = readdirSync(project, { recursive: true });
        for (const fleet of [[], ["--fleet", "unopened-fleet"]]) {
          await assert.rejects(replayDiagnosticMain(["--pm-root", root, "--receipt", receipt, ...fleet]), /diagnostic_requires_fresh_scratch/);
          assert.deepEqual(readdirSync(project, { recursive: true }), before);
        }
        if (name === "sentinel") assert.equal(readFileSync(join(project, name), "utf8"), "untouched");
        const alias = join(scratch, `${name}-alias`); symlinkSync(project, alias, "dir");
        await assert.rejects(replayDiagnosticMain(["--pm-root", join(alias, ".agents/pm"), "--receipt", receipt]), /diagnostic_requires_fresh_scratch/);
        assert.deepEqual(readdirSync(project, { recursive: true }), before);
      }
      assert.equal(existsSync(log), false, "occupied projects must refuse before source commands");
      // Fresh destinations reach live source preflight; a synthetic external command stops before cloning.
      for (const exists of [false, true]) {
        rmSync(log, { force: true });
        assert.equal(existsSync(log), false, "proof:fresh_stub_log");
        const project = join(scratch, exists ? "empty" : "absent"); if (exists) mkdirSync(project);
        await assert.rejects(replayDiagnosticMain(["--pm-root", join(project, ".agents/pm"), "--receipt", receipt]), /Command failed/);
        assert.equal(readFileSync(log, "utf8"), "preflight");
        assert.equal(existsSync(project), exists); if (exists) assert.deepEqual(readdirSync(project), []);
      }
    } finally { process.env.PATH = originalPath; }
  });
});

test("packed npm and Bun preserve runnable examples and all private path refusals", { timeout: 300_000 }, async (t) => {
  await withTransferScratch("transfer-boundary-pack-", async (scratch) => {
    const root = resolve(import.meta.dirname, "..");
    const environment = { PATH: process.env.PATH, HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, env: environment, encoding: "utf8", timeout: 60_000 })) as { filename: string }[];
    execFileSync("tar", ["-xf", join(scratch, packed[0].filename), "-C", scratch]);
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
    for (const file of ["transfer-boundary-consumer", "transfer-corpus"]) {
      let source = readFileSync(join(import.meta.dirname, `fixtures/${file}.ts`), "utf8").replaceAll(/"\.\.\/\.\.\/([^"/]+)\.ts"/g, '"./package/dist/$1.js"');
      if (file === "transfer-boundary-consumer") source += '\nconsole.log(JSON.stringify(await checkTransferBoundaries(process.cwd(), process.argv[2])));\n';
      writeFileSync(join(scratch, `${file}.ts`), source);
    }
    for (const runtime of [process.execPath, "bun"]) {
      const project = join(scratch, runtime === "bun" ? "bun" : "node"); mkdirSync(project);
      const result = spawnSync(runtime, [join(scratch, "transfer-boundary-consumer.ts"), join(scratch, "package/examples")], { cwd: project, env: environment, encoding: "utf8", timeout: 120_000 });
      if (runtime === "bun" && (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") { t.diagnostic("Bun unavailable (ENOENT); packed Node remains mandatory."); continue; }
      assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { examples: 1, paths: 48, native_replay: true });
      t.diagnostic(`Packed ${runtime === "bun" ? "Bun" : "npm/Node"}: 1 feasible example, 48 private aliases, SDK and JSON/TOON CLI, native replay and historical allow corpus passed.`);
    }
  });
});
