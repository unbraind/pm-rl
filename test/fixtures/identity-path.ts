/** Create a Git-free CLI PATH while retaining the runtime's native process-birth lookup tool. */
import { accessSync, constants, copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

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
  const bin = join(root, "bin"); mkdirSync(bin);
  const tool = process.platform === "win32" ? "powershell.exe" : process.platform === "linux" ? "getconf" : "ps";
  const files = [[process.execPath, process.platform === "win32" ? "node.exe" : "node"], [identityExecutable(tool), tool]];
  for (const [source, name] of files) {
    if (process.platform === "win32") copyFileSync(source, join(bin, name)); else symlinkSync(source, join(bin, name));
  }
  return bin;
}
