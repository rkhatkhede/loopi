#!/usr/bin/env node
/**
 * CLI reviewer for pending diffs.
 * Usage: pnpm agent:review [diff-file]
 * If no file specified, reviews all pending diffs.
 */
import { exit } from "process";
import { resolve } from "path";
import { listPending, readDiffFile, moveToApproved } from "../actions/pr.js";
import { reviewPatchLocally } from "./reviewer.js";
import { logger } from "../actions/logger.js";
import { loadConfig } from "../actions/config.js";

async function main() {
  loadConfig();
  const args = process.argv.slice(2);
  const targetFile = args[0];

  let diffFiles: string[];

  if (targetFile) {
    diffFiles = [targetFile];
  } else {
    diffFiles = listPending();
  }

  if (diffFiles.length === 0) {
    console.log("No pending diffs to review.");
    exit(0);
  }

  for (const df of diffFiles) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Reviewing: ${df}`);
    console.log(`${"=".repeat(60)}\n`);

    const data = readDiffFile(df);
    if (!data) {
      console.error(`  ✗ Could not read diff file: ${df}`);
      continue;
    }

    // Build a minimal plan from metadata
    const plan = {
      id: data.metadata["plan"] ?? "unknown",
      timestamp: Date.now(),
      summary: data.metadata["piloop patch"] ?? "Unknown patch",
      rationale: "",
      affectedFiles: (data.metadata["files"] ?? "").split(", ").filter(Boolean),
      expectedPatchSize: data.content.length,
      requiredTests: [],
      risk: "medium" as const,
      operation: "fix" as const,
      details: "",
    };

    const patch = {
      id: data.metadata["piloop patch"] ?? df.replace(".diff", ""),
      planId: plan.id,
      diff: data.content,
      timestamp: Date.now(),
      files: plan.affectedFiles,
      size: data.content.length,
      status: "pending" as const,
    };

    const result = reviewPatchLocally(patch, plan);

    console.log(`  Risk: ${result.risk}`);
    console.log(`  Score: ${result.approved ? "PASS" : "FAIL"}`);
    console.log(`  Recommendation: ${result.recommendation}`);

    if (result.riskReport !== "No issues detected") {
      console.log(`\n  Issues:`);
      for (const issue of result.riskReport.split("\n")) {
        console.log(`    • ${issue}`);
      }
    }

    console.log(`\n  Regression checklist:`);
    for (const item of result.regressionChecklist) {
      console.log(`    ☐ ${item}`);
    }

    if (result.approved) {
      const moved = moveToApproved(patch.id);
      if (moved) {
        console.log(`\n  ✓ Approved and moved to workflows/approved/`);
      }
    } else {
      console.log(`\n  ✗ Not approved. Review manually.`);
    }
  }
}

main().catch((err) => {
  console.error("Review CLI failed:", err);
  exit(1);
});
