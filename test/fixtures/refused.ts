/** Shared refusal matcher: the machine code and the conflict exit code must both match. */
import { EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";

/** Match a pm-rl refusal by its machine code and the conflict exit code, never by the code alone. */
export function refused(code: string) {
  return (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === code && error.exitCode === EXIT_CODE.CONFLICT;
}
