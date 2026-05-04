/**
 * loopi — Autonomous Pipeline Runner
 *
 * Runs the improvement pipeline directly from the Node.js process
 * without requiring a pi agent. Handles basic code scanning,
 * opportunity detection, and patch generation.
 *
 * Logs progress to .pi/loopi/logs/ which the TUI dashboard picks up.
 */

import { execSync } from "child_process";
import { readFileSync, existsSync, readdirSync, appendFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import crypto from "crypto";
import { logger } from "./actions/logger.js";
import { readVision, saveVision, saveOpportunity, writePending } from "./pipeline.js";
import type { Opportunity, Patch } from "./types/index.js";

// ─── Finding types ───

interface Finding {
  file: string;
  line?: number;
  severity: "error" | "warning" | "info";
  message: string;
  rule?: string;
  fixable?: boolean;
}

interface ScanResult {
  findings: Finding[];
  testFailures: string[];
  todos: Finding[];
}

// ─── Helpers ───

function log(msg: string) {
  logger.info(msg);
  const progressDir = resolve(process.cwd(), ".pi/loopi/logs");
  if (!existsSync(progressDir)) mkdirSync(progressDir, { recursive: true });
  const logFile = resolve(progressDir, "pipeline.log");
  appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
}

function estimateValue(count: number): "low" | "medium" | "high" | "critical" {
  if (count > 50) return "critical";
  if (count > 20) return "high";
  if (count > 5) return "medium";
  return "low";
}

function estimateEffort(count: number): "trivial" | "small" | "medium" | "large" | "epic" {
  if (count > 50) return "epic";
  if (count > 20) return "large";
  if (count > 10) return "medium";
  if (count > 3) return "small";
  return "trivial";
}

function uuid() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ─── Step 1: Ensure vision ───

function ensureVision() {
  log("Step 1/5: Checking vision...");
  let vision = readVision();
  if (!vision) {
    vision = {
      version: 1,
      projectDescription: "Improve code quality, fix issues, and reduce technical debt.",
      businessGoals: ["Fix lint errors", "Fix failing tests", "Resolve TODOs", "Improve code quality"],
      technicalPriorities: [],
      userPersonas: [],
      constraints: [],
      northStar: "A clean, well-tested, maintainable codebase",
      milestones: [],
    };
    saveVision(vision);
    log("  Vision created from defaults.");
  } else {
    log(`  Vision found.`);
  }
  return vision;
}

// ─── Step 2: Scan code ───

function scanCode(): ScanResult {
  log("Step 2/5: Scanning codebase...");
  const findings: Finding[] = [];
  const testFailures: string[] = [];
  const todos: Finding[] = [];

  // Lint
  const eslintFiles = [".eslintrc", ".eslintrc.json", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs"];
  if (eslintFiles.some(f => existsSync(resolve(process.cwd(), f)))) {
    try {
      log("  Running eslint...");
      const stdout = execSync("npx eslint . --format json 2>/dev/null", {
        cwd: process.cwd(),
        timeout: 30_000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      const results = JSON.parse(stdout);
      for (const file of results) {
        for (const msg of file.messages || []) {
          findings.push({
            file: file.filePath,
            line: msg.line,
            severity: msg.severity === 2 ? "error" : "warning",
            message: msg.message,
            rule: msg.ruleId,
            fixable: !!msg.fix,
          });
        }
      }
      log(`  Found ${findings.length} lint issue(s).`);
    } catch {
      log("  Lint check skipped.");
    }
  } else {
    log("  No eslint config — skipping lint.");
  }

  // Tests
  const testCmd = existsSync(resolve(process.cwd(), "vitest.config.ts"))
    ? "npx vitest run 2>&1"
    : existsSync(resolve(process.cwd(), "jest.config.js"))
      ? "npx jest 2>&1"
      : null;
  if (testCmd) {
    try {
      log("  Running tests...");
      execSync(testCmd, { cwd: process.cwd(), timeout: 60_000, stdio: "pipe" });
      log("  All tests pass.");
    } catch (e: any) {
      const out = e.stdout?.toString() || "";
      const err = e.stderr?.toString() || "";
      const lines = (out + "\n" + err).split("\n").filter(l => l.includes("FAIL") || l.includes("fail") || l.includes("Error"));
      testFailures.push(...lines.slice(0, 10));
      log(`  Found ${testFailures.length} test failure(s).`);
    }
  } else {
    log("  No test config — skipping tests.");
  }

  // TODO/FIXME
  try {
    const srcDirs = ["src"].filter(d => existsSync(resolve(process.cwd(), d)));
    for (const dir of srcDirs) {
      const out = execSync(
        `npx grep -rn "TODO\\|FIXME\\|HACK\\|XXX" ${dir} --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" 2>/dev/null || true`,
        { cwd: process.cwd(), timeout: 10_000, encoding: "utf-8", maxBuffer: 1024 * 1024 }
      );
      for (const line of out.split("\n").filter(Boolean)) {
        const parts = line.split(":");
        if (parts.length >= 3) {
          todos.push({
            file: parts[0]!,
            line: parseInt(parts[1]!, 10),
            severity: "info",
            message: parts.slice(2).join(":").trim(),
          });
        }
      }
    }
    log(`  Found ${todos.length} TODO/FIXME(s).`);
  } catch {
    log("  TODO scan skipped.");
  }

  return { findings, testFailures, todos };
}

// ─── Step 3: Create opportunities ───

function createOpportunities(_vision: any, scan: ScanResult): Opportunity[] {
  log("Step 3/5: Creating improvement opportunities...");
  const opportunities: Opportunity[] = [];

  const errors = scan.findings.filter(f => f.severity === "error");
  if (errors.length > 0) {
    opportunities.push({
      id: uuid(),
      createdAt: Date.now(),
      title: `Fix ${errors.length} lint error(s)`,
      description: errors.slice(0, 20).map(e => `${e.file}:${e.line} — ${e.message}`).join("\n"),
      category: "quality",
      estimatedValue: estimateValue(errors.length),
      estimatedEffort: estimateEffort(errors.length),
      affectedAreas: [...new Set(errors.map(e => e.file))].slice(0, 5),
      status: "suggested",
    });
  }

  const warnings = scan.findings.filter(f => f.severity === "warning");
  if (warnings.length > 0) {
    opportunities.push({
      id: uuid(),
      createdAt: Date.now(),
      title: `Fix ${warnings.length} lint warning(s)`,
      description: warnings.slice(0, 20).map(e => `${e.file}:${e.line} — ${e.message}`).join("\n"),
      category: "quality",
      estimatedValue: estimateValue(warnings.length),
      estimatedEffort: estimateEffort(warnings.length),
      affectedAreas: [...new Set(warnings.map(e => e.file))].slice(0, 5),
      status: "suggested",
    });
  }

  if (scan.testFailures.length > 0) {
    opportunities.push({
      id: uuid(),
      createdAt: Date.now(),
      title: `Fix ${scan.testFailures.length} failing test(s)`,
      description: scan.testFailures.join("\n"),
      category: "quality",
      estimatedValue: "high",
      estimatedEffort: estimateEffort(scan.testFailures.length),
      affectedAreas: ["tests"],
      status: "suggested",
    });
  }

  if (scan.todos.length > 0) {
    opportunities.push({
      id: uuid(),
      createdAt: Date.now(),
      title: `Resolve ${scan.todos.length} TODO/FIXME(s)`,
      description: scan.todos.slice(0, 20).map(t => `${t.file}:${t.line} — ${t.message}`).join("\n"),
      category: "tech-debt",
      estimatedValue: estimateValue(scan.todos.length),
      estimatedEffort: estimateEffort(scan.todos.length),
      affectedAreas: [...new Set(scan.todos.map(t => t.file))].slice(0, 5),
      status: "suggested",
    });
  }

  log(`  Created ${opportunities.length} opportunity/opportunities.`);
  return opportunities;
}

// ─── Step 4: Generate patches ───

function generatePatches(opportunity: Opportunity): Patch[] {
  log(`Step 4/5: Generating patches for "${opportunity.title.slice(0, 50)}..."`);
  const patches: Patch[] = [];

  if (opportunity.title.includes("lint")) {
    try {
      log("  Running eslint --fix...");
      execSync("npx eslint . --fix 2>&1", { cwd: process.cwd(), timeout: 60_000, encoding: "utf-8" });
      log("  Eslint --fix done.");

      try {
        const diff = execSync("git diff 2>&1", { cwd: process.cwd(), timeout: 10_000, encoding: "utf-8" });
        if (diff.trim()) {
          const stat = execSync("git diff --stat 2>&1", { cwd: process.cwd(), timeout: 5_000, encoding: "utf-8" });
          const filesChanged: string[] = [];
          for (const line of stat.split("\n").filter(l => l.includes("|"))) {
            const f = line.split("|")[0]?.trim();
            if (f) filesChanged.push(f);
          }
          patches.push({
            id: uuid(),
            planId: opportunity.id,
            diff,
            files: filesChanged.slice(0, 3),
            size: diff.length,
            status: "pending",
          });
        }
      } catch {
        log("  No git diff available.");
      }
    } catch {
      log("  Eslint --fix had issues.");
    }
  }

  log(`  Generated ${patches.length} patch/patches.`);
  return patches;
}

// ─── Step 5: Write pending ───

function writePendingPatches(patches: Patch[]) {
  log(`Step 5/5: Writing ${patches.length} patch/patches for review...`);
  for (const patch of patches) {
    writePending(patch);
    log(`  Written: ${patch.id.slice(0, 8)}`);
  }
}

// ─── Main entry point ───

export interface PipelineProgress {
  status: "idle" | "running" | "completed" | "failed";
  step: string;
  message: string;
  findings: number;
  patches: number;
  error?: string;
}

let _progress: PipelineProgress = {
  status: "idle",
  step: "",
  message: "",
  findings: 0,
  patches: 0,
};

export function getPipelineProgress(): PipelineProgress {
  return { ..._progress };
}

export async function runAutoPipeline(): Promise<PipelineProgress> {
  _progress = { status: "running", step: "starting", message: "Starting pipeline...", findings: 0, patches: 0 };
  log("Pipeline started.");

  try {
    // Step 1
    _progress = { ..._progress, step: "Vision check", message: "Checking vision..." };
    log(`  → ${_progress.step}`);
    const vision = ensureVision();
    if (!vision) throw new Error("Failed to create/read vision");

    // Step 2
    _progress = { ..._progress, step: "Code scan", message: "Scanning codebase..." };
    log(`  → ${_progress.step}`);
    const scan = scanCode();
    _progress.findings = scan.findings.length + scan.todos.length + scan.testFailures.length;
    _progress.message = `Found ${_progress.findings} issue(s)`;

    // Step 3
    _progress = { ..._progress, step: "Opportunities", message: "Creating improvement opportunities..." };
    log(`  → ${_progress.step}`);
    const opportunities = createOpportunities(vision, scan);
    for (const opp of opportunities) {
      saveOpportunity(opp);
    }

    // Step 4
    _progress = { ..._progress, step: "Generating patches", message: "Generating automated patches..." };
    log(`  → ${_progress.step}`);
    let patches: Patch[] = [];
    if (opportunities.length > 0) {
      const sorted = [...opportunities].sort((a, b) => {
        const val = { low: 1, medium: 2, high: 3, critical: 4 };
        const eff = { trivial: 4, small: 3, medium: 2, large: 1, epic: 0 };
        return (val[b.estimatedValue] || 0) * (eff[b.estimatedEffort] || 0) -
               (val[a.estimatedValue] || 0) * (eff[a.estimatedEffort] || 0);
      });
      patches = generatePatches(sorted[0]!);
    }

    // Step 5
    _progress = { ..._progress, step: "Writing patches", message: "Writing patches for review..." };
    log(`  → ${_progress.step}`);
    writePendingPatches(patches);
    _progress.patches = patches.length;

    _progress.status = "completed";
    _progress.message = `${patches.length} patch(es) ready for review`;
    log("Pipeline complete.");
  } catch (e: any) {
    _progress.status = "failed";
    _progress.error = e.message || String(e);
    _progress.message = `Failed: ${_progress.error}`;
    log(`Pipeline failed: ${_progress.error}`);
  }

  return { ..._progress };
}
