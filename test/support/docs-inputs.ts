/** Run existing suites whose inputs include shipped documentation or package contents. */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { testTime } from "./depth.ts";

const files = readdirSync("test").filter((file) => file.endsWith(".test.ts")).filter((file) => {
  const source = readFileSync(`test/${file}`, "utf8");
  return /docs\/|README\.md|ARCHITECTURE\.md|LICENSE|CHANGELOG|changelog|["']pack["']|npm pack/.test(source);
}).map((file) => `test/${file}`);
if (files.length === 0) throw new Error("No documentation/packaging input suites selected");
console.log(`Documentation and packaging suites: ${files.join(" ")}`);
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", ...files], { stdio: "inherit", timeout: testTime(25 * 60_000) });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
