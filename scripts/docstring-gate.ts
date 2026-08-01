#!/usr/bin/env node
/**
 * Enforce meaningful docstrings across pm-rl source declarations.
 *
 * The analyzer comes from pm-ops so the fleet shares one lexer-backed policy:
 * every exported declaration, every public member of an exported class, and
 * every substantial private function needs JSDoc that contributes information
 * beyond its identifier. The analyzer has no ignore list and treats unknown
 * declaration forms as violations, so a new syntax form fails closed.
 */

import { join } from "node:path";

import { analyzeDocstringCoverage } from "pm-ops/docstrings";

const report = analyzeDocstringCoverage({ root: join(import.meta.dirname, "..") });

if (report.violations.length > 0) {
  let message = `docstring-gate: ${report.violations.length} violation(s) across ${report.files_scanned} file(s):\n`;
  for (const violation of report.violations) {
    message += `${violation.file}:${violation.line} ${violation.symbol}: ${violation.reason}\n`;
  }
  console.error(message.trimEnd());
  process.exit(1);
}

console.log(`docstring-gate: ${report.files_scanned} file(s), ${report.declarations_checked} declaration(s) documented.`);
