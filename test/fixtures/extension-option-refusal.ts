/** Exact host-owned missing-option witnesses against real tracker bytes. */
import assert from "node:assert/strict";
import { EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import type { ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { sourceBytes } from "./corpus-source-snapshot.ts";

/** Preserve the precise untyped host refusal until the SDK supplies a machine code. */
export async function assertMissingHostOption(
  harness: ExtensionTestHarness,
  request: Parameters<ExtensionTestHarness["runCommand"]>[0] & { pmRoot: string },
  flag: string,
): Promise<void> {
  const before = sourceBytes(request.pmRoot);
  await assert.rejects(harness.runCommand(request), (error: unknown) => {
    assert.ok(isPmCliExpectedError(error));
    assert.equal(error.context.code, undefined);
    assert.equal(error.exitCode, EXIT_CODE.USAGE);
    assert.equal(error.message, `Missing required option '${flag}' for extension command '${request.command}'.`);
    return true;
  });
  assert.equal(sourceBytes(request.pmRoot), before, "host refusal must preserve durable tracker bytes");
}
