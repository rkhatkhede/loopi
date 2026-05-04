import { readFileSync, existsSync } from "fs";
import { resolve, relative } from "path";

/**
 * Generate a unified diff string for a single file.
 *
 * Uses the `diff` library to produce a standard unified diff
 * that can be passed to `git apply`.
 *
 * @param filePath - Absolute path to the file
 * @param newContent - The new content of the file
 * @returns A unified diff string
 */
export function generateDiffString(filePath: string, newContent: string): string {
  const { diffLines, formatPatch } = createDiff();
  const cwd = process.cwd();
  const relPath = relative(cwd, filePath).replace(/\\/g, "/");

  // Read existing content (or empty if new file)
  let oldContent = "";
  if (existsSync(filePath)) {
    oldContent = readFileSync(filePath, "utf-8");
  }

  // Normalize line endings
  const normalizedOld = oldContent.replace(/\r\n/g, "\n");
  const normalizedNew = newContent.replace(/\r\n/g, "\n");

  // Generate diff changes
  const changes = diffLines(normalizedOld, normalizedNew);

  // Build the diff object for formatPatch
  const diffResult = {
    oldFileName: `a/${relPath}`,
    newFileName: `b/${relPath}`,
    oldHeader: new Date().toISOString(),
    newHeader: new Date().toISOString(),
    hunks: changesToHunks(changes),
  };

  // Format as unified diff
  const diff = formatPatch(diffResult);

  // Ensure diff ends with a newline
  return diff.endsWith("\n") ? diff : diff + "\n";
}

/**
 * Convert diff changes array to hunks format expected by formatPatch.
 */
function changesToHunks(changes: Array<{ count: number; added?: boolean; removed?: boolean; value: string }>) {
  const hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }> = [];

  let oldStart = 1;
  let newStart = 1;
  let currentHunk: string[] = [];
  let hunkOldStart = 1;
  let hunkNewStart = 1;
  let hunkOldCount = 0;
  let hunkNewCount = 0;

  function flushHunk() {
    if (currentHunk.length > 0) {
      hunks.push({
        oldStart: hunkOldStart,
        oldLines: hunkOldCount,
        newStart: hunkNewStart,
        newLines: hunkNewCount,
        lines: currentHunk,
      });
      currentHunk = [];
      hunkOldCount = 0;
      hunkNewCount = 0;
    }
  }

  for (const change of changes) {
    if (change.removed || change.added) {
      // Start tracking a new hunk if we haven't already
      if (currentHunk.length === 0) {
        hunkOldStart = oldStart;
        hunkNewStart = newStart;
      }

      const lines = change.value.split("\n");
      // Remove trailing empty line from split
      if (lines[lines.length - 1] === "") lines.pop();

      for (const line of lines) {
        if (change.removed) {
          currentHunk.push("-" + line);
          hunkOldCount++;
        }
        if (change.added) {
          currentHunk.push("+" + line);
          hunkNewCount++;
        }
      }

      if (change.removed) {
        oldStart += change.count;
      }
      if (change.added) {
        newStart += change.count;
      }
    } else {
      // Context (unchanged) lines
      if (currentHunk.length > 0) {
        const lines = change.value.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        for (const line of lines) {
          currentHunk.push(" " + line);
          hunkOldCount++;
          hunkNewCount++;
        }
        oldStart += change.count;
        newStart += change.count;

        // If we have enough context, flush the hunk
        if (hunkOldCount > 0) {
          flushHunk();
        }
      } else {
        oldStart += change.count;
        newStart += change.count;
      }
    }
  }

  flushHunk();
  return hunks;
}

/**
 * Lazy-load the `diff` library to avoid issues with ESM/CJS interop.
 */
function createDiff() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const diff = require("diff");
  return diff;
}
