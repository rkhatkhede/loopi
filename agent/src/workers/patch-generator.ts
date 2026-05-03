import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { ImprovementPlan, Patch } from "../types/index.js";
import { getConfig } from "../actions/config.js";
import { logger } from "../actions/logger.js";

export function generateDiffString(originalPath: string, newContent: string): string {
  const originalContent = existsSync(originalPath) ? readFileSync(originalPath, "utf-8") : "";
  const origLines = originalContent.split("\n");
  const newLines = newContent.split("\n");

  // Simple unified diff generator
  const diffLines: string[] = [];
  const cwd = process.cwd().replace(/\\/g, "/");
  const normalizedPath = originalPath.replace(/\\/g, "/");
  const relativePath = normalizedPath.startsWith(cwd)
    ? normalizedPath.slice(cwd.length)
    : "/" + normalizedPath.split("/").pop()!;

  diffLines.push(`--- a${relativePath}`);
  diffLines.push(`+++ b${relativePath}`);

  // Find differing chunks
  const maxLen = Math.max(origLines.length, newLines.length);
  let hunkStart = -1;
  let hunkOrig: string[] = [];
  let hunkNew: string[] = [];

  // Simple line-by-line comparison
  const changes: { type: "equal" | "remove" | "add"; line: string }[] = [];
  const ctxLines = 3;

  // Build change list
  const minLen = Math.min(origLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < minLen) {
      if (origLines[i] === newLines[i]) {
        changes.push({ type: "equal", line: origLines[i]! });
      } else {
        changes.push({ type: "remove", line: origLines[i]! });
        changes.push({ type: "add", line: newLines[i]! });
      }
    } else if (i < origLines.length) {
      changes.push({ type: "remove", line: origLines[i]! });
    } else {
      changes.push({ type: "add", line: newLines[i]! });
    }
  }

  // Group into hunks
  let i = 0;
  while (i < changes.length) {
    if (changes[i]!.type !== "equal") {
      // Start of a hunk — go back ctxLines for context
      const hunkStartIdx = Math.max(0, i - ctxLines);
      const hunkEndIdx = Math.min(changes.length - 1, i + ctxLines);

      let origStart = hunkStartIdx + 1;
      let newStart = hunkStartIdx + 1;
      let origCount = 0;
      let newCount = 0;

      const hunkContent: string[] = [];

      for (let j = hunkStartIdx; j <= hunkEndIdx; j++) {
        const change = changes[j]!;
        if (change.type === "equal") {
          hunkContent.push(` ${change.line}`);
          origCount++;
          newCount++;
        } else if (change.type === "remove") {
          hunkContent.push(`-${change.line}`);
          origCount++;
        } else {
          hunkContent.push(`+${change.line}`);
          newCount++;
        }
      }

      // Skip to after this hunk
      i = hunkEndIdx + 1;

      // Write hunk header
      diffLines.push(`@@ -${origStart},${origCount} +${newStart},${newCount} @@`);
      diffLines.push(...hunkContent);
    } else {
      i++;
    }
  }

  return diffLines.join("\n");
}

export interface PatchGeneratorInput {
  plan: ImprovementPlan;
  getFileContent: (path: string) => string;
  makeChanges: (path: string, content: string) => void;
}

/**
 * Generates a patch (unified diff string) based on the improvement plan.
 * This is the core local patch generation logic.
 */
export function generatePatch(plan: ImprovementPlan): Patch {
  logger.info(`Generating patch for: ${plan.summary}`);

  const patchLines: string[] = [];
  let totalSize = 0;

  for (const file of plan.affectedFiles) {
    const fullPath = resolve(process.cwd(), file);
    if (!existsSync(fullPath)) {
      logger.warn(`File not found, skipping: ${file}`);
      continue;
    }

    const originalContent = readFileSync(fullPath, "utf-8");

    // Apply the plan's changes to produce modified content
    let modifiedContent = applyPlanChanges(originalContent, plan, file);

    // Generate diff
    const diff = generateDiffString(fullPath, modifiedContent);
    patchLines.push(diff);
    totalSize += Buffer.byteLength(diff, "utf-8");
  }

  const diff = patchLines.join("\n");

  const patch: Patch = {
    id: plan.id,
    planId: plan.id,
    diff,
    timestamp: Date.now(),
    files: plan.affectedFiles,
    size: totalSize,
    status: "pending",
  };

  logger.info(`Patch generated: ${patch.files.length} files, ${totalSize} bytes`);
  return patch;
}

/**
 * Apply plan changes to file content based on the plan type and details.
 * This is a simplified transformation engine. For complex changes, the
 * system invokes the pi.dev patch-agent.
 */
function applyPlanChanges(content: string, plan: ImprovementPlan, filePath: string): string {
  const lines = content.split("\n");

  switch (plan.operation) {
    case "typing": {
      // Replace `any` with `unknown` as a safer default
      return content.replace(/\bany\b/g, "unknown");
    }
    case "fix": {
      // Apply simple fixes based on plan details
      // This is a stub — real fixes come from the pi.dev patch-agent
      return content;
    }
    case "refactor": {
      // Stub for local refactoring — real work done by patch-agent
      return content;
    }
    default:
      return content;
  }
}
