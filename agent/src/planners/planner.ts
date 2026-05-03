import crypto from "crypto";
import type { AnalysisReport, ImprovementPlan, OperationType } from "../types/index.js";
import { getConfig } from "../actions/config.js";
import { logger } from "../actions/logger.js";

export function planImprovement(analysis: AnalysisReport): ImprovementPlan {
  logger.info("Planning improvement from analysis...");

  const cfg = getConfig();
  const allowedOps = new Set(cfg.constraints.allowedOperations);

  // Scoring system to pick the best improvement
  const candidates: { op: OperationType; score: number; rationale: string; files: string[]; details: string }[] = [];

  // 1. Check for high-complexity functions
  const highComplexity = analysis.complexity.filter(
    (c) => c.risk === "high" || c.risk === "critical"
  );
  if (highComplexity.length > 0 && allowedOps.has("refactor")) {
    const top = highComplexity[0]!;
    candidates.push({
      op: "refactor",
      score: Math.min(top.complexity, 50),
      rationale: `Function '${top.functionName}' in ${top.file} has high complexity (${top.complexity})`,
      files: [top.file],
      details: `Extract sub-logic from '${top.functionName}' into smaller functions to reduce cyclomatic complexity from ${top.complexity} to under 10.`,
    });
  }

  // 2. Check for error patterns
  const errorPatterns = analysis.errors.filter((e) => e.severity === "high" || e.severity === "critical");
  if (errorPatterns.length > 0 && allowedOps.has("fix")) {
    const top = errorPatterns[0]!;
    candidates.push({
      op: "fix",
      score: 40 + top.count,
      rationale: `${top.pattern}: ${top.example}`,
      files: [top.file],
      details: `Fix ${top.pattern} in ${top.file}. ${top.example}`,
    });
  }

  // 3. Check for TODO/FIXME density
  if (analysis.todos.length > 0 && allowedOps.has("fix")) {
    // Group TODOs by file
    const fileTodoCount = new Map<string, number>();
    for (const todo of analysis.todos) {
      fileTodoCount.set(todo.file, (fileTodoCount.get(todo.file) ?? 0) + 1);
    }
    let topFile = "";
    let topCount = 0;
    for (const [file, count] of fileTodoCount) {
      if (count > topCount) {
        topFile = file;
        topCount = count;
      }
    }
    if (topFile) {
      const todosInFile = analysis.todos.filter((t) => t.file === topFile);
      candidates.push({
        op: "fix",
        score: 30 + topCount * 2,
        rationale: `${topCount} TODO/FIXME markers in ${topFile}`,
        files: [topFile],
        details: `Address TODOs in ${topFile}:\n${todosInFile.map((t) => `  - Line ${t.line}: ${t.text}`).join("\n")}`,
      });
    }
  }

  // 4. Check for `any` type overuse
  const anyErrors = analysis.errors.filter((e) => e.pattern === "excessive-any");
  if (anyErrors.length > 0 && allowedOps.has("typing")) {
    const top = anyErrors[0]!;
    candidates.push({
      op: "typing",
      score: 25 + top.count,
      rationale: `Excessive 'any' types (${top.count} occurrences) in ${top.file}`,
      files: [top.file],
      details: `Replace 'any' types with specific types in ${top.file}. ${top.count} uses found.`,
    });
  }

  // 5. Deep nesting — refactor
  const nestingSmells = analysis.smells.filter((s) => s.type === "deep-nesting" && s.severity === "high");
  if (nestingSmells.length > 0 && allowedOps.has("refactor")) {
    const top = nestingSmells[0]!;
    candidates.push({
      op: "refactor",
      score: 20,
      rationale: `Deep nesting in ${top.file} at line ${top.line}: ${top.description}`,
      files: [top.file],
      details: top.suggestion ?? `Extract inner logic to separate functions in ${top.file}.`,
    });
  }

  // 6. Check for try-without-catch
  const tryCatchErrors = analysis.errors.filter((e) => e.pattern === "try-without-catch");
  if (tryCatchErrors.length > 0 && allowedOps.has("fix")) {
    const top = tryCatchErrors[0]!;
    candidates.push({
      op: "fix",
      score: 15 + top.count,
      rationale: `Missing catch blocks: ${top.example}`,
      files: [top.file],
      details: `Add proper error handling for try blocks without catch in ${top.file}.`,
    });
  }

  // Pick the best candidate
  if (candidates.length === 0) {
    throw new Error("No actionable improvements found based on analysis.");
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;

  // Determine risk
  let risk: "low" | "medium" | "high" = "low";
  if (best.op === "refactor" && best.score > 30) risk = "medium";
  if (best.op === "fix" && best.score > 35) risk = "medium";
  if (best.op === "fix" && best.score > 50) risk = "high";

  // Estimate patch size (rough heuristic)
  const estimatedSize = Math.min(
    Math.round(best.score * 3 + 20),
    cfg.constraints.maxPatchSizeLines
  );

  const plan: ImprovementPlan = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    summary: `${best.op}: ${best.rationale.slice(0, 80)}`,
    rationale: best.rationale,
    affectedFiles: best.files,
    expectedPatchSize: estimatedSize,
    requiredTests: [],
    risk,
    operation: best.op,
    details: best.details,
  };

  logger.info(`Planned: ${plan.summary} (risk: ${plan.risk}, ~${plan.expectedPatchSize} lines)`);
  return plan;
}
