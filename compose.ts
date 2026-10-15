/** Controller-owned Docker Compose lifecycle for the durable process trainer protocol. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { launchTrainer, type ProcessInput, type Resources } from "./process.ts";
import { writeTrainerArtifact } from "./process-bandit.ts";
import { expectedFail } from "./refuse.ts";

/** Derive an isolated Compose project from the full content-bound process job identity. */
export function composeProject(id: string, directory: string): string {
  if (!/^process-[a-f0-9]{64}$/u.test(id)) expectedFail("Invalid Compose job identity.", "process_job_drift");
  return `pm-rl-${createHash("sha256").update(JSON.stringify([id, resolve(directory)])).digest("hex")}`;
}

/** Generate only one networkless trainer with job-local storage and no host service inputs. */
export function composeConfiguration(image: string): unknown {
  return { services: { trainer: {
    image, pull_policy: "never", network_mode: "none", read_only: true,
    user: `${process.getuid!()}:${process.getgid!()}`,
    cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
    working_dir: "/job", stdin_open: true, restart: "no",
    volumes: [
      { type: "bind", source: ".", target: "/job", bind: { create_host_path: false } },
      { type: "bind", source: "./compose.json", target: "/job/compose.json", read_only: true, bind: { create_host_path: false } },
    ],
  } } };
}

/** Pin every Compose invocation to this generated file and project, ignoring ambient discovery. */
function composeArgs(directory: string, id: string): string[] {
  return ["compose", "--ansi", "never", "--env-file", devNull, "--project-directory", directory, "--project-name", composeProject(id, directory), "--file", join(directory, "compose.json")];
}

/** Stop only this job's Compose project, preserving every host artifact and recording stop evidence. */
export async function stopComposeTrainer(directory: string, id: string, image: string, reason: string): Promise<void> {
  const file = join(directory, "compose.json");
  // A crash before config publication cannot have launched a container.
  if (!existsSync(file)) return;
  if (readFileSync(file, "utf8") !== JSON.stringify(composeConfiguration(image))) expectedFail("Compose configuration drifted; retained for inspection.", "process_job_drift");
  const project = composeProject(id, directory);
  const options = { timeout: 15_000, maxBuffer: 65_536 };
  // Compose down/rm omit one-off run containers. Resolve only this exact named, labelled container,
  // then remove its immutable daemon ID so name reuse cannot grant stop authority.
  const listed = await promisify(execFile)("docker", ["container", "ls", "--all", "--no-trunc", "--filter", `name=^/${project}-trainer$`, "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=trainer", "--format", "{{.ID}}"], options);
  const container = listed.stdout.trim();
  if (container.length > 0) await promisify(execFile)("docker", ["container", "rm", "--force", container], options);
  await promisify(execFile)("docker", [...composeArgs(directory, id), "down", "--timeout", "0"], options);
  const evidence = join(directory, "compose-stop.json");
  if (!existsSync(evidence)) writeTrainerArtifact(evidence, { format: "pm-rl/compose-stop/1", job: id, project, reason });
}

/** Run the container as the trainer; the controller owns its reservation, watchdog and cleanup. */
export async function launchComposeTrainer(directory: string, id: string, input: ProcessInput, allowance: Resources, image: string, onCleanupFailure: (error: unknown) => void, signal?: AbortSignal): Promise<void> {
  writeTrainerArtifact(join(directory, "compose.json"), composeConfiguration(image));
  let reason = "failed";
  try {
    await launchTrainer(directory, id, input, allowance, ["docker", ...composeArgs(directory, id), "run", "--no-deps", "--pull", "never", "-T", "--name", `${composeProject(id, directory)}-trainer`, "trainer"], signal);
    reason = "exited";
  } finally {
    try { await stopComposeTrainer(directory, id, image, signal?.aborted === true ? "cancelled" : reason); }
    catch (error) { onCleanupFailure(error); }
  }
}
