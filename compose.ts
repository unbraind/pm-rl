import { statePath, identifier } from "./state-boundary.ts";
import { parseBoundedJson } from "./tracker-record.ts";
/** Controller-owned Docker Compose lifecycle for the durable process trainer protocol. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { launchTrainer, type TrainerInput, type ProcessAdapter, type Resources } from "./process.ts";
import { writeTrainerArtifact } from "./process-bandit.ts";
import { expectedFail } from "./refuse.ts";

/** Derive an isolated Compose project from the full content-bound process job identity. */
export function composeProject(id: string, directory: string): string {
  if (!/^process-[a-f0-9]{64}$/u.test(id)) expectedFail("Invalid Compose job identity.", "process_job_drift");
  return `pm-rl-${createHash("sha256").update(JSON.stringify([identifier(id), resolve(directory)])).digest("hex")}`;
}

/** Generate only one networkless trainer with job-local storage and no host service inputs. */
export function composeConfiguration(image: string, limits?: Extract<ProcessAdapter, { kind: "compose-lm" }>): unknown {
  return { services: { trainer: {
    ...(limits === undefined ? {} : { mem_limit: limits.memory_bytes, memswap_limit: limits.memory_bytes, cpus: limits.cpus, pids_limit: 64 }),
    labels: { "pm-rl-trainer": "pm-rl-compose" },
    image, pull_policy: "never", network_mode: "none", read_only: true,
    user: `${Math.max(1, process.getuid!())}:${Math.max(1, process.getgid!())}`,
    cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
    working_dir: "/job", stdin_open: true, restart: "no",
    volumes: [
      ...(limits === undefined ? [] : [{ type: "bind", source: "./input.json", target: "/job/input.json", read_only: true, bind: { create_host_path: false } }]),
      { type: "bind", source: ".", target: "/job", bind: { create_host_path: false } },
      { type: "bind", source: "./compose.json", target: "/job/compose.json", read_only: true, bind: { create_host_path: false } },
    ],
  } } };
}

/** Pin every Compose invocation to this generated file and project, ignoring ambient discovery. */
function composeArgs(directory: string, id: string): string[] {
  return ["compose", "--ansi", "never", "--env-file", devNull, "--project-directory", directory, "--project-name", composeProject(id, directory), "--file", statePath(directory, "compose.json")];
}

/** Stop only this job's Compose project, preserving every host artifact and recording stop evidence. */
export async function stopComposeTrainer(directory: string, id: string, image: string, reason: string, limits?: Extract<ProcessAdapter, { kind: "compose-lm" }>): Promise<void> {
  const file = statePath(directory, "compose.json");
  // A crash before config publication cannot have launched a container.
  if (!existsSync(file)) return;
  if (readFileSync(file, "utf8") !== JSON.stringify(composeConfiguration(image, limits))) expectedFail("Compose configuration drifted; retained for inspection.", "process_job_drift");
  const project = composeProject(id, directory);
  const options = { timeout: 15_000, maxBuffer: 65_536 };
  // Compose down/rm omit one-off run containers. Resolve only this exact named, labelled container,
  // then remove its immutable daemon ID so name reuse cannot grant stop authority.
  const listed = await promisify(execFile)("docker", ["container", "ls", "--all", "--no-trunc", "--filter", `name=^/${project}-trainer$`, "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=trainer", "--format", "{{.ID}}"], options);
  const container = listed.stdout.trim();
  let resources: unknown = null;
  if (limits !== undefined && container.length > 0) {
    const inspected = await promisify(execFile)("docker", ["container", "inspect", container, "--format", '{"memory_bytes":{{.HostConfig.Memory}},"nano_cpus":{{.HostConfig.NanoCpus}},"oom_killed":{{.State.OOMKilled}},"exit_code":{{.State.ExitCode}},"network":{{json .HostConfig.NetworkMode}},"user":{{json .Config.User}}}'], options);
    resources = parseBoundedJson(inspected.stdout) as unknown;
  }
  if (container.length > 0) await promisify(execFile)("docker", ["container", "rm", "--force", container], options);
  await promisify(execFile)("docker", [...composeArgs(directory, id), "down", "--timeout", "0"], options);
  const evidence = statePath(directory, "compose-stop.json");
  if (!existsSync(evidence)) writeTrainerArtifact(evidence, { format: "pm-rl/compose-stop/1", job: id, project, reason, ...(limits === undefined ? {} : { resources }) });
}

/** Run the container as the trainer; the controller owns its reservation, watchdog and cleanup. */
export async function launchComposeTrainer(directory: string, id: string, input: TrainerInput, allowance: Resources, image: string, onCleanupFailure: (error: unknown) => void, signal?: AbortSignal, limits?: Extract<ProcessAdapter, { kind: "compose-lm" }>): Promise<void> {
  if (limits !== undefined) writeTrainerArtifact(statePath(directory, "input.json"), { job: id, input });
  writeTrainerArtifact(statePath(directory, "compose.json"), composeConfiguration(image, limits));
  let reason = "failed";
  try {
    await launchTrainer(directory, id, input, allowance, ["docker", ...composeArgs(directory, id), "run", "--no-deps", "--pull", "never", "-T", "--name", `${composeProject(id, directory)}-trainer`, "trainer"], signal);
    reason = "exited";
  } finally {
    try { await stopComposeTrainer(directory, id, image, signal?.aborted === true ? "cancelled" : reason, limits); }
    catch (error) { onCleanupFailure(error); }
  }
}
