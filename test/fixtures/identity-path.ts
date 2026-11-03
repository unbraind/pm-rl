/** Create a Git-free CLI PATH while retaining the runtime's native process-birth lookup tool. */
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** Resolve the exact required executable from the caller's PATH, without assuming a POSIX shell. */
export function identityExecutable(tool: string, searchPath = process.env.PATH ?? ""): string {
  for (const directory of searchPath.split(delimiter)) {
    if (directory === "") continue;
    const file = join(directory, tool);
    try { accessSync(file, constants.X_OK); return file; } catch { /* Try the next PATH directory. */ }
  }
  throw new Error(`Required process identity executable is missing: ${tool}`);
}
/** Keep native node and process identity reachable on Windows, Linux and other Unix platforms. */
export function identityPath(root: string): string {
  const tool = process.platform === "win32" ? "powershell.exe" : process.platform === "linux" ? "getconf" : "ps";
  const executable = identityExecutable(tool); const bin = join(root, "bin");
  if (process.platform === "win32") {
    // Preserve the installed tool's own directory; require its PATH entry to remain Git-free.
    const directory = dirname(executable);
    if (["git", "git.exe", "git.com", "git.cmd", "git.bat"].some(name => existsSync(join(directory, name)))) throw new Error("Process identity directory must not contain Git.");
    mkdirSync(bin); copyFileSync(process.execPath, join(bin, "node.exe"));
    return [bin, directory].join(delimiter);
  }
  mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node")); symlinkSync(executable, join(bin, tool));
  return bin;
}
