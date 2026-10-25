/** Real-process fault drills share exactly the same public commands and SDK writes as the parent tests. */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { extractGenerationSpec, withRlController, recordRefusedPolicyCard, type RlCommandResult } from "../index.ts";
import { exportPolicyCard, adoptPolicyCard, recordRecursivePolicyCards } from "../policy-card.ts";

export type RecoveryPath = "register" | "promote" | "evaluate" | "reject" | "publish" | "export" | "adopt";
export type FaultMode = "EIO" | "ENOSPC" | "kill" | "none";

/** Run a public path and optionally fail at a named atomic-effect boundary, using a real tracker throughout. */
export async function recoveryPath(pmRoot: string, path: RecoveryPath, boundary: string, mode: FaultMode): Promise<unknown> {
  const root = dirname(dirname(pmRoot));
  const client = new PmClient({ pmRoot, cwd: root, author: "card-test", noExtensions: true });
  let injected = false;
  /** Persist proof of reaching the exact boundary before simulating storage loss or actual process death. */
  const hit = (point: string): void => {
    if (injected || mode === "none" || point !== boundary) return;
    injected = true;
    writeFileSync(join(root, "fault-hit"), point);
    if (mode === "kill") process.kill(process.pid, "SIGKILL");
    throw Object.assign(new Error(`Injected ${mode} at ${point}`), { code: mode });
  };
  const create = client.create.bind(client); let card = 0;
  client.create = async (options) => {
    const step = String(options?.id).includes("policy-card-") ? `card-${card++}` : "receipt";
    hit(`${step}:before`);
    const result = await create(options);
    hit(`${step}:after`);
    return result;
  };
  const schemaAddType = client.schemaAddType.bind(client);
  client.schemaAddType = async (name, options) => {
    hit(`schema-${name}:before`);
    const result = await schemaAddType(name, options);
    hit(`schema-${name}:after`);
    return result;
  };
  const config = client.config.bind(client);
  client.config = (async (...args: Parameters<PmClient["config"]>) => {
    if (new Error().stack?.includes("mutateLoopItem")) hit("seal:before");
    return config(...args);
  }) as PmClient["config"];
  const get = client.get.bind(client);
  client.get = (async (...args: Parameters<PmClient["get"]>) => {
    const result = await get(...args);
    if ("item" in result && result.item.id === "rl-candidate" && args[1]?.at === undefined && typeof result.item.body === "string") {
      const spec = extractGenerationSpec(result.item.body, "Recovery source");
      if (spec.promoted || (spec.policy_evaluation as Record<string, unknown> | undefined)?.decision === "refuse") hit("seal:after");
    }
    return result;
  }) as PmClient["get"];
  if (path === "promote" || path === "register") {
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
    type HostSdk = NonNullable<Parameters<ExtensionTestHarness["runCommand"]>[0]["sdk"]>;
    if (path === "register") return (await harness.runCommand({ command: "rl generation register", pmRoot, args: ["rl-new-seed"], options: { baseCheckpoint: "sha256:" + "1".repeat(64), policy: "sha256:" + "2".repeat(64) }, sdk: { client } as unknown as HostSdk })).result;
    return (await harness.runCommand({ command: "rl generation promote", pmRoot, args: ["rl-candidate"], options: { approval: "APPROVAL", scores: join(root, "scores.json"), evidence: "Fixed promotion request" }, sdk: { client } as unknown as HostSdk })).result as RlCommandResult;
  }
  if (path === "reject") return recordRefusedPolicyCard(client, "rl-candidate", "Fixed evaluation refusal", "card-test");
  if (path === "evaluate") return withRlController(client, { pmRoot, author: "card-test" }, { id: "recovery", approval: "rl-approval", recoveryCommand: "resume recovery" }, AbortSignal.timeout(60000), async (step) => step("evaluate", {}, async () => ({ configs: [{ samples: 2 }, { samples: 3 }], verdict: { decision: "promote", gain: 0.1 } })));
  if (path === "publish") return recordRecursivePolicyCards(client, "rl-proposals");
  hit("read:before");
  const exported = await exportPolicyCard(client, "rl-candidate");
  if (path === "export") { hit("read:after"); return exported; }
  const adopted = await adoptPolicyCard(client, exported);
  hit("read:after");
  return adopted;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , pmRoot, path, boundary, mode] = process.argv;
  await recoveryPath(pmRoot, path as RecoveryPath, boundary, mode as FaultMode);
}
