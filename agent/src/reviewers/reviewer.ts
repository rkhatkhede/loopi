import type { Patch, ImprovementPlan, ReviewResult } from "../types/index.js";
import { getConfig } from "../actions/config.js";
import { logger } from "../actions/logger.js";
import { execSync } from "child_process";

/**
 * Local reviewer that evaluates diffs against the plan for safety.
 * This runs without calling a pi.dev agent — it's a fast local check.
 */
export function reviewPatchLocally(patch: Patch, plan: ImprovementPlan): ReviewResult {
  logger.info(`Reviewing patch: ${patch.id}`);

  const regressionChecklist: string[] = [];
  const issues: string[] = [];
  let score = 100;

  // 1. Check file count constraint
  if (patch.files.length > getConfig().constraints.maxFilesPerPatch) {
    issues.push(`Exceeds max files per patch (${patch.files.length} > ${getConfig().constraints.maxFilesPerPatch})`);
    score -= 20;
  }

  // 2. Check patch size
  if (patch.size > getConfig().constraints.maxPatchSizeBytes) {
    issues.push(`Patch too large (${patch.size} bytes > ${getConfig().constraints.maxPatchSizeBytes})`);
    score -= 15;
  }

  // 3. Basic diff validation
  const diffLines = patch.diff.split("\n");
  const hasHunks = diffLines.some((l) => l.startsWith("@@"));
  if (!hasHunks) {
    issues.push("Patch contains no valid diff hunks");
    score -= 30;
  }

  // 4. Check for forbidden directories
  const forbidden = getConfig().constraints.forbiddenDirectories;
  for (const file of patch.files) {
    for (const dir of forbidden) {
      if (file.includes(dir)) {
        issues.push(`Patch touches forbidden directory: ${file}`);
        score -= 50;
      }
    }
  }

  // 5. Check for dangerous patterns
  const dangerousPatterns = [
    { pattern: /process\.exit\b/, msg: "Uses process.exit()" },
    { pattern: /eval\s*\(/, msg: "Uses eval()" },
    { pattern: /child_process\.exec/, msg: "Uses exec() (prefer execFile or spawn)" },
    { pattern: /fs\.writeFileSync/, msg: "Uses sync file write (prefer async)" },
  ];

  for (const { pattern, msg } of dangerousPatterns) {
    // Only check added lines
    for (const line of diffLines) {
      if (line.startsWith("+") && pattern.test(line)) {
        issues.push(msg);
        score -= 10;
        break;
      }
    }
  }

  // 6. Verify plan alignment
  if (!plan.affectedFiles.every((f) => patch.files.includes(f))) {
    issues.push("Patch modifies files not in the plan");
    score -= 25;
  }

  // Build regression checklist
  for (const file of patch.files) {
    regressionChecklist.push(`Verify ${file} still compiles`);
    regressionChecklist.push(`Verify tests pass for ${file}`);
  }
  // Add operation-specific checks
  if (plan.operation === "typing") {
    regressionChecklist.push("Verify no new TypeScript errors introduced");
  }
  if (plan.operation === "refactor") {
    regressionChecklist.push("Verify behavior is unchanged (run existing tests)");
  }

  // Determine risk & approval
  const approved = score >= 60;
  let risk: "low" | "medium" | "high";
  if (score >= 80) risk = "low";
  else if (score >= 60) risk = "medium";
  else risk = "high";

  // Check against config max risk
  const maxRisk = getConfig().review.maxRiskLevel;
  const riskLevels = { low: 0, medium: 1, high: 2 };
  const finalApproved = approved && riskLevels[risk] <= riskLevels[maxRisk];

  const result: ReviewResult = {
    patchId: patch.id,
    approved: finalApproved,
    risk,
    riskReport: issues.length > 0 ? issues.join("\n") : "No issues detected",
    regressionChecklist,
    testImpactSummary: `Affects ${patch.files.length} file(s). Run tests for affected modules.`,
    recommendation: finalApproved
      ? "Approved. Apply patch and run tests."
      : `Rejected. Score: ${score}/100. ${issues.join("; ")}`,
    reviewer: "local-reviewer",
    timestamp: Date.now(),
  };

  logger.info(`Review result: ${result.approved ? "APPROVED" : "REJECTED"} (risk: ${result.risk}, score: ${score})`);
  return result;
}
