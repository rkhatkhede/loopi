/**
 * Patch Generator — unified diff utility
 *
 * Uses the `diff` library for industry-standard diff generation.
 * Intelligent code changes are delegated to loopi.patch-agent.
 * This module only handles the mechanical diff formatting.
 */
import { readFileSync, existsSync } from "fs";
import { structuredPatch } from "diff";

/**
 * Generate a unified diff string comparing the original file
 * (read from disk) with the provided new content.
 *
 * @param originalPath - Path to the original file (used for headers only)
 * @param newContent   - Modified content to diff against
 * @returns A valid unified diff string, always ending with "\n"
 */
export function generateDiffString(originalPath: string, newContent: string): string {
  // Normalize line endings to LF — CRLF confuses the diff library on Windows
  const originalContent = existsSync(originalPath)
    ? readFileSync(originalPath, "utf-8").replace(/\r\n/g, "\n")
    : "";

  const result = structuredPatch(
    // Use relative-ish paths for the diff headers
    `a/${originalPath.replace(/^.*[/\\]/, "")}`,
    `b/${originalPath.replace(/^.*[/\\]/, "")}`,
    originalContent,
    newContent.replace(/\r\n/g, "\n"),
    undefined,
    undefined,
    { context: 3 }
  );

  const lines: string[] = [];
  lines.push("--- " + result.oldFileName);
  lines.push("+++ " + result.newFileName);

  for (const hunk of result.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    );
    // Filter out trailing whitespace-only context lines that confuse git apply
    const hunkLines = hunk.lines.filter(
      (l, i) => !(l.trim() === "" && i >= hunk.lines.length - 1)
    );
    for (const line of hunkLines) {
      lines.push(line);
    }
  }

  // git apply requires a trailing newline
  return lines.join("\n") + "\n";
}
