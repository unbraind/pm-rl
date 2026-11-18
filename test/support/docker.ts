/** Explicit routing for real Docker drills; synthetic Docker executables run in every tier. */
import { spawnSync } from "node:child_process";
import { testTime } from "./depth.ts";

const mode = process.env.PM_TEST_DOCKER;
const version = mode === "off" ? undefined : spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: testTime(30_000) });
if (mode === "required" && version?.status !== 0) throw new Error(`Docker drills require docker compose: ${version?.error?.message ?? version?.stderr}`);
export const dockerSkip = mode === "off" ? "Real Docker drills run in the hosted CI Deep docker job" : version?.status === 0 ? false : `Docker Compose unavailable: ${version?.error?.message ?? version?.stderr}`;
