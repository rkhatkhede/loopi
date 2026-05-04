/**
 * loopi — Autonomous Pipeline Runner
 *
 * Hands-off improvement pipeline:
 *   1. Scan code
 *   2. Create opportunities
 *   3. For each opportunity:
 *      a. Feature branch from dev
 *      b. Generate + apply patch
 *      c. Self-review (compile, tests, lint)
 *      d. Pass → merge to dev. Fail → delete branch, log why
 *   4. Dashboard shows results
 */

import { exec } from "child_process";
import { existsSync, appendFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import crypto from "crypto";
import { logger } from "./actions/logger.js";
import {
  readVision, saveVision, saveOpportunity,
  applyPatch, approveFeatureBranch, rejectFeatureBranch
} from "./pipeline.js";
import type { Opportunity, Patch } from "./types/index.js";

// ─── Helpers ───

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function execAsync(cmd: string, opts: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    exec(cmd, { ...opts, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout?.toString() || "", stderr: stderr?.toString() || "", code: err ? (err as any).code || 1 : 0 });
    });
  });
}

function log(msg: string) {
  logger.info(msg);
  const progressDir = resolve(process.cwd(), ".pi/loopi/logs");
  if (!existsSync(progressDir)) mkdirSync(progressDir, { recursive: true });
  appendFileSync(resolve(progressDir, "pipeline.log"), `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
}

function uuid() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

function estimateValue(n: number): "low" | "medium" | "high" | "critical" {
  return n > 50 ? "critical" : n > 20 ? "high" : n > 5 ? "medium" : "low";
}

function estimateEffort(n: number): "trivial" | "small" | "medium" | "large" | "epic" {
  return n > 50 ? "epic" : n > 20 ? "large" : n > 10 ? "medium" : n > 3 ? "small" : "trivial";
}

interface Finding { file: string; line?: number; severity: "error" | "warning" | "info"; message: string; rule?: string; fixable?: boolean; }
interface ScanResult { findings: Finding[]; testFailures: string[]; todos: Finding[]; }
interface ReviewResult { pass: boolean; reason?: string; }

// ─── Step 1: Vision ───

async function ensureVision() {
  log("Step 1: Checking vision...");
  let vision = readVision();
  if (!vision) {
    vision = {
      version: 1,
      projectDescription: "Improve code quality, fix issues, and reduce technical debt.",
      businessGoals: ["Fix lint errors", "Fix failing tests", "Resolve TODOs", "Improve code quality"],
      technicalPriorities: [], userPersonas: [], constraints: [],
      northStar: "A clean, well-tested, maintainable codebase", milestones: [],
    };
    saveVision(vision);
    log("  Vision created from defaults.");
  } else log("  Vision found.");
  await sleep(10);
  return vision;
}

// ─── Step 2: Async code scan ───

async function scanCode(): Promise<ScanResult> {
  log("Step 2: Scanning codebase...");
  const findings: Finding[] = [];
  const testFailures: string[] = [];
  const todos: Finding[] = [];
  const cwd = process.cwd();

  // ── Lint ──
  const eslintFiles = [".eslintrc", ".eslintrc.json", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs", "eslint.config.ts"];
  if (eslintFiles.some(f => existsSync(resolve(cwd, f)))) {
    log("  Running eslint...");
    const { stdout } = await execAsync("npx eslint . --format json 2>/dev/null", { cwd, timeout: 30_000 });
    await sleep(10);
    try {
      if (stdout.trim()) {
        const results = JSON.parse(stdout);
        for (const file of results) {
          for (const msg of file.messages || []) {
            findings.push({
              file: file.filePath, line: msg.line,
              severity: msg.severity === 2 ? "error" : "warning",
              message: msg.message, rule: msg.ruleId, fixable: !!msg.fix,
            });
          }
        }
      }
    } catch { /* ignore parse errors */ }
    log(findings.length ? `  Found ${findings.length} lint issue(s).` : "  Lint clean.");
  } else {
    const { stdout: pkgStr } = await execAsync("cat package.json 2>/dev/null || type package.json 2>/dev/null", { cwd });
    await sleep(10);
    if (pkgStr.includes("eslint")) {
      log("  eslint in package.json, running...");
      const { stdout } = await execAsync("npx eslint . --format json 2>/dev/null", { cwd, timeout: 30_000 });
      await sleep(10);
      try {
        if (stdout.trim()) {
          const results = JSON.parse(stdout);
          for (const file of results) {
            for (const msg of file.messages || []) findings.push({
              file: file.filePath, line: msg.line,
              severity: msg.severity === 2 ? "error" : "warning",
              message: msg.message, rule: msg.ruleId, fixable: !!msg.fix,
            });
          }
        }
      } catch { /* ignore */ }
      log(findings.length ? `  Found ${findings.length} lint issue(s).` : "  Lint clean.");
    } else log("  No eslint — skipping lint.");
  }
  await sleep(10);

  // ── Tests ──
  const testCmds = [
    { file: "vitest.config.ts", cmd: "npx vitest run 2>&1" },
    { file: "vitest.config.js", cmd: "npx vitest run 2>&1" },
    { file: "jest.config.js", cmd: "npx jest 2>&1" },
    { file: "jest.config.ts", cmd: "npx jest 2>&1" },
  ];
  const matched = testCmds.find(t => existsSync(resolve(cwd, t.file)));
  if (matched) {
    log(`  Running tests (${matched.file})...`);
    const { stdout, stderr } = await execAsync(matched.cmd, { cwd, timeout: 60_000 });
    await sleep(10);
    const combined = stdout + "\n" + stderr;
    const failed = combined.split("\n").filter(l => l.includes("FAIL") || l.includes("✗") || l.includes("×"));
    if (failed.length > 0) {
      testFailures.push(...failed.slice(0, 10));
      log(`  Found ${testFailures.length} test failure(s).`);
    } else log("  All tests pass.");
  } else {
    const { stdout: pkgStr2 } = await execAsync("cat package.json 2>/dev/null || type package.json 2>/dev/null", { cwd });
    await sleep(10);
    if (pkgStr2.includes('"test"')) {
      log("  Running npm test...");
      const { stdout: tout, stderr: terr } = await execAsync("npm test 2>&1", { cwd, timeout: 60_000 });
      await sleep(10);
      const combined = tout + "\n" + terr;
      const failed = combined.split("\n").filter(l => l.includes("FAIL") || l.includes("✗") || l.includes("×"));
      if (failed.length > 0) { testFailures.push(...failed.slice(0, 10)); log(`  Found ${testFailures.length} test failure(s).`); }
      else log("  All tests pass.");
    } else log("  No test config — skipping tests.");
  }
  await sleep(10);

  // ── TODOs ──
  const srcDirs = ["src", "lib", "app", "client", "server"].filter(d => existsSync(resolve(cwd, d)));
  if (srcDirs.length > 0) {
    for (const dir of srcDirs) {
      const ext = `--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rs" --include="*.go"`;
      const { stdout } = await execAsync(`grep -rn "TODO\\|FIXME\\|HACK\\|XXX" ${dir} ${ext} 2>/dev/null || true`, { cwd, timeout: 15_000 });
      await sleep(10);
      for (const line of stdout.split("\n").filter(Boolean)) {
        const parts = line.split(":");
        if (parts.length >= 3) {
          const msg = parts.slice(2).join(":").trim();
          if (msg.length > 0 && !msg.startsWith(":") && !msg.startsWith("//")) {
            todos.push({ file: parts[0]!, line: parseInt(parts[1]!, 10), severity: "info", message: msg });
          }
        }
      }
    }
    log(todos.length ? `  Found ${todos.length} TODO/FIXME(s).` : "  No TODOs found.");
  } else log("  No src/lib/app dir — skipping TODO scan.");
  await sleep(10);

  return { findings, testFailures, todos };
}

// ─── Step 3: Create opportunities ───

async function createOpportunities(scan: ScanResult): Promise<Opportunity[]> {
  log("Step 3: Creating improvement opportunities...");
  const opps: Opportunity[] = [];

  const errors = scan.findings.filter(f => f.severity === "error");
  if (errors.length > 0) opps.push({
    id: uuid(), createdAt: Date.now(),
    title: `Fix ${errors.length} lint error(s)`,
    description: errors.slice(0, 20).map(e => `${e.file}:${e.line} — ${e.message}`).join("\n"),
    category: "quality", estimatedValue: estimateValue(errors.length),
    estimatedEffort: estimateEffort(errors.length),
    affectedAreas: [...new Set(errors.map(e => e.file))].slice(0, 5), status: "suggested",
  });

  const warnings = scan.findings.filter(f => f.severity === "warning");
  if (warnings.length > 0) opps.push({
    id: uuid(), createdAt: Date.now(),
    title: `Fix ${warnings.length} lint warning(s)`,
    description: warnings.slice(0, 20).map(e => `${e.file}:${e.line} — ${e.message}`).join("\n"),
    category: "quality", estimatedValue: estimateValue(warnings.length),
    estimatedEffort: estimateEffort(warnings.length),
    affectedAreas: [...new Set(warnings.map(e => e.file))].slice(0, 5), status: "suggested",
  });

  if (scan.testFailures.length > 0) opps.push({
    id: uuid(), createdAt: Date.now(),
    title: `Fix ${scan.testFailures.length} failing test(s)`,
    description: scan.testFailures.slice(0, 10).join("\n"),
    category: "quality", estimatedValue: "high",
    estimatedEffort: estimateEffort(scan.testFailures.length),
    affectedAreas: ["tests"], status: "suggested",
  });

  if (scan.todos.length > 0) opps.push({
    id: uuid(), createdAt: Date.now(),
    title: `Resolve ${scan.todos.length} TODO/FIXME(s)`,
    description: scan.todos.slice(0, 20).map(t => `${t.file}:${t.line} — ${t.message}`).join("\n"),
    category: "tech-debt", estimatedValue: estimateValue(scan.todos.length),
    estimatedEffort: estimateEffort(scan.todos.length),
    affectedAreas: [...new Set(scan.todos.map(t => t.file))].slice(0, 5), status: "suggested",
  });

  log(`  Created ${opps.length} opportunity/opportunities.`);
  await sleep(10);
  return opps;
}

// ─── Step 4: Generate patch for one opportunity ───

async function generatePatchesForOpportunity(opportunity: Opportunity): Promise<Patch[]> {
  log(`  Generating patches for "${opportunity.title.slice(0, 50)}..."`);
  const patches: Patch[] = [];
  const cwd = process.cwd();

  if (opportunity.title.includes("lint")) {
    log("    Running eslint --fix...");
    await execAsync("npx eslint . --fix 2>&1", { cwd, timeout: 60_000 });
    await sleep(10);

    const { stdout: diff } = await execAsync("git diff 2>&1", { cwd, timeout: 10_000 });
    await sleep(10);
    if (diff.trim()) {
      const { stdout: stat } = await execAsync("git diff --stat 2>&1", { cwd, timeout: 5_000 });
      const filesChanged: string[] = [];
      for (const line of stat.split("\n").filter(l => l.includes("|"))) {
        const f = line.split("|")[0]?.trim();
        if (f) filesChanged.push(f);
      }
      patches.push({
        id: uuid(), planId: opportunity.id, diff,
        files: filesChanged.slice(0, 3), size: diff.length, status: "pending",
      });
    } else log("    No changes after eslint --fix.");
  } else log("    No auto-fix strategy for this opportunity type.");

  log(`  Generated ${patches.length} patch/patches.`);
  await sleep(10);
  return patches;
}

// ─── Step 5a: Apply patch on a feature branch ───

async function applyOnePatch(patch: Patch): Promise<string | null> {
  const summary = `auto-fix: ${patch.files.join(", ")}`;
  try {
    // applyPatch creates a feature branch from dev, applies, commits, returns to dev
    const branchName = await applyPatch(patch.diff, summary, ".");
    if (!branchName) return null;
    log(`    Feature branch: ${branchName}`);
    await sleep(10);
    return branchName;
  } catch (e: any) {
    log(`    Failed to apply: ${e.message}`);
    return null;
  }
}

// ─── Step 5b: Self-review on the feature branch ───

async function selfReview(branchName: string): Promise<ReviewResult> {
  log(`    Reviewing ${branchName}...`);
  const cwd = process.cwd();
  const issues: string[] = [];

  // Checkout the feature branch
  const { code: coCode } = await execAsync(`git checkout ${branchName} 2>&1`, { cwd, timeout: 10_000 });
  await sleep(10);
  if (coCode !== 0) {
    await execAsync("git checkout dev 2>&1", { cwd }).catch(() => {});
    return { pass: false, reason: "Could not checkout feature branch" };
  }

  // 1. Compilation check
  if (existsSync(resolve(cwd, "tsconfig.json"))) {
    log("    Checking compilation...");
    const { code, stderr } = await execAsync("npx tsc --noEmit 2>&1", { cwd, timeout: 60_000 });
    await sleep(10);
    if (code !== 0) {
      const lines = stderr.split("\n").filter(l => l.includes("error"));
      issues.push(`Compilation: ${lines.length} error(s)`);
      log(`    ✖ Compilation errors`);
    } else log("    ✓ Compilation OK");
  }

  // 2. Test run
  const testCmds = [
    { file: "vitest.config.ts", cmd: "npx vitest run 2>&1" },
    { file: "vitest.config.js", cmd: "npx vitest run 2>&1" },
    { file: "jest.config.js", cmd: "npx jest 2>&1" },
    { file: "jest.config.ts", cmd: "npx jest 2>&1" },
  ];
  const matched = testCmds.find(t => existsSync(resolve(cwd, t.file)));
  if (matched) {
    log(`    Running tests...`);
    const { code, stderr } = await execAsync(matched.cmd, { cwd, timeout: 60_000 });
    await sleep(10);
    if (code !== 0) {
      const fails = (stderr || "").split("\n").filter(l => l.includes("FAIL"));
      if (fails.length > 0) {
        issues.push(`Tests: ${fails.length} failure(s)`);
        log(`    ✖ Test failures`);
      }
    } else log("    ✓ All tests pass");
  }

  // 3. Lint check
  const eslintFiles = [".eslintrc", ".eslintrc.json", "eslint.config.js", "eslint.config.mjs", "eslint.config.ts"];
  if (eslintFiles.some(f => existsSync(resolve(cwd, f)))) {
    log("    Linting...");
    const { code } = await execAsync("npx eslint . 2>&1", { cwd, timeout: 30_000 });
    await sleep(10);
    if (code !== 0) {
      issues.push("Lint errors after fix");
      log("    ✖ Lint errors");
    } else log("    ✓ Lint clean");
  }

  // Return to dev
  await execAsync("git checkout dev 2>&1", { cwd }).catch(() => {});
  await sleep(10);

  if (issues.length > 0) return { pass: false, reason: issues.join("; ") };
  return { pass: true };
}

// ─── Step 5: Process one opportunity (branch → apply → review → merge/reject) ───

async function processOpportunity(opportunity: Opportunity): Promise<{ merged: number; rejected: number }> {
  let merged = 0;
  let rejected = 0;

  log(`\n  ── Processing: ${opportunity.title} ──`);

  // Generate patches
  const patches = await generatePatchesForOpportunity(opportunity);
  if (patches.length === 0) {
    log(`  No patches generated for — skipping.`);
    return { merged, rejected };
  }

  for (const patch of patches) {
    // Apply on feature branch
    const branchName = await applyOnePatch(patch);
    if (!branchName) { rejected++; continue; }

    // Self-review
    const review = await selfReview(branchName);

    if (review.pass) {
      // Auto-merge to dev
      try {
        await approveFeatureBranch(branchName, ".");
        merged++;
        log(`  ✓ Auto-approved: merged ${branchName} into dev`);
      } catch (e: any) {
        log(`  ✖ Merge failed for ${branchName}: ${e.message}`);
        rejected++;
      }
    } else {
      // Auto-reject
      try {
        await rejectFeatureBranch(branchName, ".");
        rejected++;
        log(`  ✖ Auto-rejected ${branchName}: ${review.reason}`);
      } catch (e: any) {
        log(`  ✖ Could not delete ${branchName}: ${e.message}`);
      }
    }
    await sleep(10);
  }

  return { merged, rejected };
}

// ─── Pipeline Progress ───

export interface PipelineProgress {
  status: "idle" | "running" | "completed" | "failed" | "nothing-to-do";
  step: string;
  message: string;
  findings: number;
  patches: number;
  autoMerged?: number;
  autoRejected?: number;
  error?: string;
}

let _progress: PipelineProgress = {
  status: "idle",
  step: "", message: "", findings: 0, patches: 0,
};

export function getPipelineProgress(): PipelineProgress {
  return { ..._progress };
}

// ─── Main entry ───

export async function runAutoPipeline(): Promise<PipelineProgress> {
  _progress = { status: "running", step: "starting", message: "Starting pipeline...", findings: 0, patches: 0 };
  log("Pipeline started.");

  try {
    // Step 1 — Vision
    _progress = { ..._progress, step: "Vision", message: "Checking vision..." };
    log(`  → ${_progress.step}`);
    await ensureVision();
    await sleep(10);

    // Step 2 — Scan
    _progress = { ..._progress, step: "Scanning", message: "Scanning codebase..." };
    log(`  → ${_progress.step}`);
    const scan = await scanCode();
    _progress.findings = scan.findings.length + scan.todos.length + scan.testFailures.length;
    _progress.message = `Found ${_progress.findings} issue(s)`;
    if (_progress.findings === 0) {
      _progress.status = "nothing-to-do";
      _progress.step = "Complete";
      _progress.message = "No issues found — codebase looks clean!";
      log("  No issues — stopping.");
      return { ..._progress };
    }
    await sleep(10);

    // Step 3 — Opportunities
    _progress = { ..._progress, step: "Opportunities", message: "Creating improvement opportunities..." };
    log(`  → ${_progress.step}`);
    const opportunities = await createOpportunities(scan);
    for (const opp of opportunities) saveOpportunity(opp);
    if (opportunities.length === 0) {
      _progress.status = "nothing-to-do";
      _progress.step = "Complete";
      _progress.message = `${_progress.findings} issue(s) found but no actionable opportunities`;
      log("  No actionable opportunities — stopping.");
      return { ..._progress };
    }
    await sleep(10);

    // Step 4-5 — Process each opportunity (branch → apply → review → auto-merge/reject)
    _progress = { ..._progress, step: "Processing", message: "Processing each opportunity..." };
    log(`  → ${_progress.step}`);
    _progress.patches = 0;
    let totalMerged = 0;
    let totalRejected = 0;

    // Sort: highest value, lowest effort first
    const sorted = [...opportunities].sort((a, b) => {
      const v: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
      const e: Record<string, number> = { trivial: 4, small: 3, medium: 2, large: 1, epic: 0 };
      return (v[b.estimatedValue] || 0) * (e[b.estimatedEffort] || 0) -
             (v[a.estimatedValue] || 0) * (e[a.estimatedEffort] || 0);
    });

    for (const opp of sorted) {
      _progress.message = opp.title;
      const result = await processOpportunity(opp);
      totalMerged += result.merged;
      totalRejected += result.rejected;
      _progress.patches = totalMerged;
      await sleep(10);
    }

    _progress.autoMerged = totalMerged;
    _progress.autoRejected = totalRejected;
    _progress.status = "completed";
    _progress.message = `${totalMerged} patch(es) merged, ${totalRejected} rejected`;
    log(`Pipeline complete: ${totalMerged} merged, ${totalRejected} rejected`);
  } catch (e: any) {
    _progress.status = "failed";
    _progress.error = e.message || String(e);
    _progress.message = `Failed: ${_progress.error}`;
    log(`Pipeline failed: ${_progress.error}`);
  }

  return { ..._progress };
}
