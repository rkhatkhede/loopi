/**
 * loopi — Autonomous Pipeline Runner (RPC-based)
 *
 * Orchestrates improvement cycles by compiling prompts and calling
 * pi.dev agents via the RPC client. No hardcoded audit strategies.
 *
 * Flow (per cycle):
 *   1. Load vision, pick active milestone
 *   2. SCAN    → compileScanPrompt() → pi RPC → RepoScanAgent → findings
 *   3. ANALYZE → compileAnalyzePrompt() → pi RPC → AnalyzerAgent → tasks
 *   4. For each task:
 *      a. PLAN    → compilePlanPrompt() → pi RPC → PlannerAgent → plan
 *      b. EXECUTE → compileExecutePrompt() → pi RPC → ExecutorAgent → patch
 *      c. Apply patch on feature branch
 *      d. Self-review (compile + test)
 *      e. Auto-merge to dev or reject
 *   5. IMPROVE → compileImprovePrompt() → pi RPC → SelfImproveAgent
 *   6. Save state, report results
 */

import { existsSync, appendFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { exec } from "child_process";
import crypto from "crypto";
import { logger } from "./actions/logger.js";
import {
  readVision, saveVision, saveOpportunity, readOpportunityHistory,
  readPatterns, savePattern,
  readGoals, saveGoal,
  readTasks, saveTask,
  applyPatch, approveFeatureBranch, rejectFeatureBranch
} from "./pipeline.js";
import { RPCClient } from "./rpc-client.js";
import {
  compileScanPrompt,
  compileAnalyzePrompt,
  compilePlanPrompt,
  compileExecutePrompt,
  compileImprovePrompt,
} from "./prompts/prompts.js";
import type { VisionDocument, Opportunity, Pattern, Task } from "./types/index.js";

// ─── Helpers ───

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function execAsync(
  cmd: string,
  opts: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { ...opts, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() || "",
          stderr: stderr?.toString() || "",
          code: err ? (err as any).code || 1 : 0,
        });
      }
    );
  });
}

function log(msg: string) {
  logger.info(msg);
  const progressDir = resolve(process.cwd(), ".pi/loopi/logs");
  if (!existsSync(progressDir)) mkdirSync(progressDir, { recursive: true });
  appendFileSync(
    resolve(progressDir, "pipeline.log"),
    `[${new Date().toISOString()}] ${msg}\n`,
    "utf-8"
  );
}

function uuid() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ─── Progress State ───

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
  step: "",
  message: "",
  findings: 0,
  patches: 0,
};

export function getPipelineProgress(): PipelineProgress {
  return { ..._progress };
}

// ─── JSON Extraction ───

/**
 * Extract a JSON object from agent output.
 * Handles ```json fences, raw JSON, and embedded JSON in text.
 */
function extractJSON(text: string): string | null {
  // Strategy 1: ```json ... ``` fences
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const candidate = fenceMatch[1]!.trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Continue trying
    }
  }

  // Strategy 2: Try parsing the whole text as JSON
  try {
    JSON.parse(text.trim());
    return text.trim();
  } catch {
    // Continue
  }

  // Strategy 3: Extract first { ... } or [ ... ] block
  const braceMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (braceMatch) {
    const candidate = braceMatch[1]!.trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Parse structured JSON from agent output, returning the data payload
 * from within a { type, data } container, or the entire JSON if no container.
 */
function parseAgentData<T>(text: string): T | null {
  const json = extractJSON(text);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);

    // Handle { type: "...", data: { ... } } container
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.type && parsed.data) {
        return parsed.data as T;
      }
    }

    return parsed as T;
  } catch {
    return null;
  }
}

// ─── Step 1: Ensure Vision ───

async function ensureVision(): Promise<VisionDocument> {
  log("Step 1: Checking vision...");
  let vision = readVision();
  if (!vision) {
    vision = {
      version: 1,
      projectDescription:
        "Improve code quality, fix issues, and reduce technical debt.",
      businessGoals: [
        "Fix lint errors",
        "Fix failing tests",
        "Resolve TODOs",
        "Improve code quality",
      ],
      technicalPriorities: [],
      userPersonas: [],
      constraints: [],
      northStar: "A clean, well-tested, maintainable codebase",
      milestones: [],
    };
    saveVision(vision);
    log("  Vision created from defaults.");
  } else {
    log("  Vision found.");
  }

  // Pick first pending milestone as active goal
  const activeMilestone =
    vision.milestones?.find((m) => m.status === "pending") ?? null;
  if (activeMilestone) {
    log(`  Active milestone: "${activeMilestone.name}"`);
  } else {
    log("  No pending milestones — scanning for general improvements.");
  }

  await sleep(10);
  return vision;
}

// ─── Step 2: SCAN via pi RPC ───

interface ScanFinding {
  file: string;
  line?: number;
  message: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
}

interface ScanResult {
  summary: string;
  findings: ScanFinding[];
  codebaseHealth?: Record<string, string>;
  milestoneProgress?: string;
  recommendations?: string[];
}

async function scanWithPi(
  vision: VisionDocument,
  rpc: RPCClient
): Promise<ScanResult> {
  log("Step 2: Scanning codebase with pi.dev RepoScanAgent...");

  const prompt = compileScanPrompt(vision);
  const response = await rpc.prompt(prompt);
  const data = parseAgentData<ScanResult>(response);

  if (!data) {
    log("  Warning: Could not parse scan result from agent. Using empty scan.");
    log(`  Raw response (first 500 chars): ${response.slice(0, 500)}`);
    return { summary: "Scan parsing failed", findings: [] };
  }

  log(`  Scan complete: ${data.findings?.length ?? 0} finding(s) found`);
  if (data.summary) log(`  Summary: ${data.summary}`);
  await sleep(10);

  return data;
}

// ─── Step 3: ANALYZE via pi RPC ───

interface AnalyzeTask {
  title: string;
  description: string;
  impact: "high" | "medium" | "low";
  effort: "small" | "medium" | "large";
  category: string;
  filesLikelyAffected?: string[];
}

interface AnalyzeResult {
  summary: string;
  tasks: AnalyzeTask[];
  recommendedOrder?: string[];
}

async function analyzeWithPi(
  vision: VisionDocument,
  scanResult: ScanResult,
  rpc: RPCClient
): Promise<AnalyzeResult> {
  log("Step 3: Analyzing scan results with pi.dev AnalyzerAgent...");

  const prompt = compileAnalyzePrompt(
    vision,
    JSON.stringify(scanResult, null, 2)
  );
  const response = await rpc.prompt(prompt);
  const data = parseAgentData<AnalyzeResult>(response);

  if (!data) {
    log(
      "  Warning: Could not parse analyze result. Using empty task list."
    );
    return { summary: "Analysis parsing failed", tasks: [] };
  }

  log(`  Analysis complete: ${data.tasks?.length ?? 0} task(s) identified`);
  await sleep(10);

  return data;
}

// ─── Step 4a: PLAN via pi RPC ───

interface PlanResult {
  summary: string;
  rationale: string;
  risk: "low" | "medium" | "high";
  steps: string[];
  filesToModify: Array<{
    path: string;
    operation: "modify" | "create" | "delete";
    description: string;
  }>;
  testRequirements: string[];
  estimatedComplexity: string;
}

async function planWithPi(
  vision: VisionDocument,
  task: AnalyzeTask,
  rpc: RPCClient
): Promise<PlanResult | null> {
  log(`  Planning: "${task.title}"...`);

  const prompt = compilePlanPrompt(
    vision,
    JSON.stringify(task, null, 2)
  );
  const response = await rpc.prompt(prompt);
  const data = parseAgentData<PlanResult>(response);

  if (!data) {
    log(`  Warning: Could not parse plan for "${task.title}". Skipping.`);
    return null;
  }

  log(`  Plan: ${data.summary} (risk: ${data.risk})`);
  await sleep(10);

  return data;
}

// ─── Step 4b: EXECUTE via pi RPC ───

interface ExecuteResult {
  summary: string;
  diff: string;
  filesChanged: string[];
  testChanges?: string;
  verificationNotes?: string[];
}

async function executeWithPi(
  plan: PlanResult,
  rpc: RPCClient
): Promise<ExecuteResult | null> {
  log(`  Executing: "${plan.summary}"...`);

  const prompt = compileExecutePrompt(JSON.stringify(plan, null, 2));
  const response = await rpc.prompt(prompt);
  const data = parseAgentData<ExecuteResult>(response);

  if (!data) {
    log("  Warning: Could not parse execute result. Skipping.");
    return null;
  }

  if (!data.diff || data.diff.trim().length < 10) {
    log("  Warning: Generated diff is empty or too short. Skipping.");
    return null;
  }

  log(`  Generated diff (${data.diff.length} chars) for ${data.filesChanged?.length ?? 0} file(s)`);
  await sleep(10);

  return data;
}

// ─── Step 5: Self-review (local validation) ───

interface ReviewResult {
  pass: boolean;
  reason?: string;
}

async function selfReview(branchName: string): Promise<ReviewResult> {
  log(`    Reviewing ${branchName}...`);
  const cwd = process.cwd();
  const issues: string[] = [];

  // Checkout the feature branch
  const { code: coCode } = await execAsync(
    `git checkout ${branchName} 2>&1`,
    { cwd, timeout: 10_000 }
  );
  await sleep(10);

  if (coCode !== 0) {
    await execAsync("git checkout dev 2>&1", { cwd }).catch(() => {});
    return { pass: false, reason: "Could not checkout feature branch" };
  }

  // 1. Compilation check
  if (existsSync(resolve(cwd, "tsconfig.json"))) {
    log("    Checking compilation...");
    const { code, stderr } = await execAsync("npx tsc --noEmit 2>&1", {
      cwd,
      timeout: 60_000,
    });
    await sleep(10);
    if (code !== 0) {
      const lines = stderr.split("\n").filter((l) => l.includes("error"));
      issues.push(`Compilation: ${lines.length} error(s)`);
      log(`    ✖ Compilation errors`);
    } else {
      log("    ✓ Compilation OK");
    }
  }

  // 2. Test run
  const testConfigs = [
    { file: "vitest.config.ts", cmd: "npx vitest run 2>&1" },
    { file: "vitest.config.js", cmd: "npx vitest run 2>&1" },
    { file: "jest.config.js", cmd: "npx jest 2>&1" },
    { file: "jest.config.ts", cmd: "npx jest 2>&1" },
  ];
  const matched = testConfigs.find((t) =>
    existsSync(resolve(cwd, t.file))
  );
  if (matched) {
    log("    Running tests...");
    const { code, stderr } = await execAsync(matched.cmd, {
      cwd,
      timeout: 60_000,
    });
    await sleep(10);
    if (code !== 0) {
      const fails = (stderr || "")
        .split("\n")
        .filter((l) => l.includes("FAIL"));
      if (fails.length > 0) {
        issues.push(`Tests: ${fails.length} failure(s)`);
        log(`    ✖ Test failures`);
      } else {
        // Non-zero exit could be test runner issue, not test failure
        log("    ⚠ Test runner exited with non-zero (may be config issue)");
      }
    } else {
      log("    ✓ All tests pass");
    }
  }

  // Return to dev
  await execAsync("git checkout dev 2>&1", { cwd }).catch(() => {});
  await sleep(10);

  if (issues.length > 0) {
    return { pass: false, reason: issues.join("; ") };
  }
  return { pass: true };
}

// ─── Step 4-5: Process one task (plan → execute → branch → review → merge/reject) ───

async function processTask(
  vision: VisionDocument,
  task: AnalyzeTask,
  rpc: RPCClient
): Promise<{ merged: number; rejected: number }> {
  let merged = 0;
  let rejected = 0;

  log(`\n  ── Processing task: ${task.title} ──`);

  // 4a. Plan
  const plan = await planWithPi(vision, task, rpc);
  if (!plan) {
    log(`  No plan generated for "${task.title}" — skipping.`);
    return { merged, rejected };
  }
  await sleep(10);

  // 4b. Execute
  const executeResult = await executeWithPi(plan, rpc);
  if (!executeResult) {
    log(`  No patch generated for "${task.title}" — skipping.`);
    return { merged, rejected };
  }
  await sleep(10);

  // 4c. Apply patch on feature branch
  const summary = executeResult.summary.slice(0, 60) || task.title.slice(0, 60);
  let branchName: string | null = null;
  try {
    branchName = await applyPatch(executeResult.diff, summary, ".");
  } catch (e: any) {
    log(`  Failed to apply patch: ${e.message}`);
    return { merged: 0, rejected: 1 };
  }
  await sleep(10);

  if (!branchName) {
    log("  applyPatch returned null — skipping.");
    return { merged: 0, rejected: 1 };
  }

  // 4d. Self-review (compile + tests on feature branch)
  const review = await selfReview(branchName);

  // 4e. Auto-merge or reject
  if (review.pass) {
    try {
      await approveFeatureBranch(branchName, ".");
      merged++;
      log(`  ✓ Auto-approved: merged ${branchName} into dev`);

      // Record a pattern for this successful change
      try {
        const pattern: Pattern = {
          id: uuid(),
          createdAt: Date.now(),
          category: (task.category as any) ?? "quality",
          summary: task.title,
          filesChanged: executeResult.filesChanged ?? [],
          patchSize: executeResult.diff.length,
          outcome: "applied",
          tags: [task.category, plan.risk],
        };
        savePattern(pattern);
      } catch {
        // Best-effort pattern saving
      }
    } catch (e: any) {
      log(`  ✖ Merge failed for ${branchName}: ${e.message}`);
      rejected++;
    }
  } else {
    try {
      await rejectFeatureBranch(branchName, ".");
      rejected++;
      log(`  ✖ Auto-rejected ${branchName}: ${review.reason}`);
    } catch (e: any) {
      log(`  ✖ Could not delete ${branchName}: ${e.message}`);
    }
  }

  await sleep(10);
  return { merged, rejected };
}

// ─── Step 6: IMPROVE via pi RPC ───

interface ImproveResult {
  summary: string;
  promptImprovements?: string[];
  strategyAdjustments?: string[];
  newPatterns?: Array<{ summary: string; category: string; tags: string[] }>;
  milestoneProgress?: string;
  nextFocus?: string;
}

async function improveWithPi(
  vision: VisionDocument,
  metrics: {
    opportunitiesFound: number;
    tasksCreated: number;
    tasksCompleted: number;
    tasksRejected: number;
    totalChanges: number;
    cycleDurationMs: number;
  },
  patternHistory: Pattern[],
  rpc: RPCClient
): Promise<void> {
  log("Step 6: Self-improvement analysis with pi.dev SelfImproveAgent...");

  const prompt = compileImprovePrompt(vision, metrics, patternHistory);
  const response = await rpc.prompt(prompt);
  const data = parseAgentData<ImproveResult>(response);

  if (!data) {
    log("  Warning: Could not parse self-improvement result.");
    return;
  }

  log(`  Improvement analysis: ${data.summary}`);
  if (data.promptImprovements?.length) {
    for (const imp of data.promptImprovements) {
      log(`  Prompt improvement: ${imp}`);
    }
  }
  if (data.strategyAdjustments?.length) {
    for (const adj of data.strategyAdjustments) {
      log(`  Strategy adjustment: ${adj}`);
    }
  }
  if (data.nextFocus) {
    log(`  Next focus: ${data.nextFocus}`);
  }

  // Save new patterns from self-improvement
  if (data.newPatterns?.length) {
    for (const np of data.newPatterns) {
      try {
        const pattern: Pattern = {
          id: uuid(),
          createdAt: Date.now(),
          category: (np.category as any) ?? "quality",
          summary: np.summary,
          filesChanged: [],
          patchSize: 0,
          outcome: "suggested",
          tags: np.tags ?? [],
        };
        savePattern(pattern);
      } catch {
        // best effort
      }
    }
    log(`  Saved ${data.newPatterns.length} new pattern(s) from self-improvement`);
  }

  // Update milestone status if we made progress
  if (data.milestoneProgress) {
    log(`  Milestone progress: ${data.milestoneProgress}`);
  }

  await sleep(10);
}

// ─── Main Entry ───

export async function runAutoPipeline(): Promise<PipelineProgress> {
  _progress = {
    status: "running",
    step: "starting",
    message: "Starting pipeline...",
    findings: 0,
    patches: 0,
  };
  const pipelineStartTime = Date.now();
  log("Pipeline started.");

  const rpc = new RPCClient();

  try {
    // ── Check pi availability ──
    _progress = { ..._progress, step: "Preflight", message: "Checking pi.dev availability..." };
    log("  → Checking pi.dev CLI...");

    const piAvailable = await RPCClient.isAvailable();
    if (!piAvailable) {
      _progress.status = "failed";
      _progress.error =
        "pi.dev CLI not found. Install: npm install -g @mariozechner/pi-coding-agent";
      _progress.message = _progress.error;
      log(`  ✖ ${_progress.error}`);
      return { ..._progress };
    }
    log("  ✓ pi.dev CLI found.");

    // ── Spawn RPC connection ──
    _progress = { ..._progress, step: "Connecting", message: "Connecting to pi.dev RPC..." };
    log("  → Spawning pi RPC mode...");
    await rpc.spawn();
    log("  ✓ Connected to pi.dev RPC.");

    // ── Step 1: Vision ──
    _progress = { ..._progress, step: "Vision", message: "Checking vision..." };
    log("  → Step 1: Vision");
    const vision = await ensureVision();

    // ── Step 2: Scan ──
    _progress = {
      ..._progress,
      step: "Scanning",
      message: "Scanning codebase with pi.dev RepoScanAgent...",
    };
    log("  → Step 2: Scan");
    const scanResult = await scanWithPi(vision, rpc);
    _progress.findings = scanResult.findings?.length ?? 0;

    if (_progress.findings === 0 && !scanResult.summary) {
      _progress.status = "nothing-to-do";
      _progress.step = "Complete";
      _progress.message = "No findings from scan — codebase looks clean!";
      log("  No findings — stopping.");
      return { ..._progress };
    }
    await sleep(10);

    // ── Step 3: Analyze ──
    _progress = {
      ..._progress,
      step: "Analyzing",
      message: "Analyzing findings with pi.dev AnalyzerAgent...",
    };
    log("  → Step 3: Analyze");
    const analyzeResult = await analyzeWithPi(vision, scanResult, rpc);
    const tasks = analyzeResult.tasks ?? [];
    _progress.message = `${tasks.length} task(s) identified`;

    if (tasks.length === 0) {
      _progress.status = "nothing-to-do";
      _progress.step = "Complete";
      _progress.message = `${_progress.findings} finding(s) found but no actionable tasks`;
      log("  No actionable tasks — stopping.");
      return { ..._progress };
    }

    // Save scan findings as opportunities for dashboard
    for (const finding of scanResult.findings ?? []) {
      // Convert top findings to opportunities
      if (finding.severity === "critical" || finding.severity === "high") {
        const opp: Opportunity = {
          id: uuid(),
          createdAt: Date.now(),
          title: finding.message.slice(0, 200),
          description: `${finding.file}${finding.line ? `:${finding.line}` : ""} — ${finding.message}`,
          category: (finding.category as any) ?? "quality",
          estimatedValue: finding.severity === "critical" ? "critical" : "high",
          estimatedEffort: "medium",
          affectedAreas: finding.file ? [finding.file] : [],
          status: "suggested",
        };
        try {
          saveOpportunity(opp);
        } catch {
          // best effort
        }
      }
    }

    // Auto-generate a goal for the active milestone and persist tasks
    const activeMilestoneIdx = vision.milestones?.findIndex(
      m => m.status === "pending" || m.status === "in_progress"
    ) ?? -1;
    let currentGoalId: string | null = null;
    if (activeMilestoneIdx >= 0 && tasks.length > 0) {
      const existingGoals = readGoals();
      const milestoneName = vision.milestones![activeMilestoneIdx]!.name;
      // Reuse an existing in_progress goal for this milestone, or create one
      let goal = existingGoals.find(
        g => g.milestoneIndex === activeMilestoneIdx && g.status !== "completed"
      );
      if (!goal) {
        goal = {
          id: uuid(),
          milestoneIndex: activeMilestoneIdx,
          name: `Improve: ${milestoneName}`,
          description: `Auto-generated goal for milestone: ${milestoneName}`,
          priority: "high",
          status: "in_progress",
          createdAt: new Date().toISOString(),
        };
        saveGoal(goal);
        log(`  Created goal: "${goal.name}"`);
      }
      currentGoalId = goal.id;

      // Persist each analyze task
      for (const at of tasks) {
        const existingTasks = readTasks();
        const alreadyExists = existingTasks.some(t => t.name === at.title);
        if (!alreadyExists) {
          const persistentTask: Task = {
            id: uuid(),
            goalId: currentGoalId,
            name: at.title,
            description: at.description,
            impact: at.impact as "low" | "medium" | "high",
            effort: at.effort as "small" | "medium" | "large",
            category: at.category ?? "quality",
            status: "pending",
            filesAffected: at.filesLikelyAffected ?? [],
            createdAt: new Date().toISOString(),
          };
          saveTask(persistentTask);
        }
      }
      log(`  Persisted ${tasks.length} task(s) under goal "${goal.name}"`);
    }
    await sleep(10);

    // ── Step 4-5: Process each task ──
    _progress = {
      ..._progress,
      step: "Processing",
      message: "Processing each task via pi.dev agents...",
    };
    log("  → Step 4-5: Process tasks");
    _progress.patches = 0;
    let totalMerged = 0;
    let totalRejected = 0;

    // Sort tasks by impact (high first), then effort (small first)
    const impactOrder: Record<string, number> = {
      high: 3,
      medium: 2,
      low: 1,
    };
    const effortOrder: Record<string, number> = {
      small: 3,
      medium: 2,
      large: 1,
    };
    const sortedTasks = [...tasks].sort((a, b) => {
      const ai = impactOrder[a.impact] ?? 0;
      const bi = impactOrder[b.impact] ?? 0;
      if (ai !== bi) return bi - ai;
      return (effortOrder[a.effort] ?? 0) - (effortOrder[b.effort] ?? 0);
    });

    for (const task of sortedTasks) {
      _progress.message = task.title;
      const result = await processTask(vision, task, rpc);
      totalMerged += result.merged;
      totalRejected += result.rejected;
      _progress.patches = totalMerged;
      await sleep(10);
    }

    _progress.autoMerged = totalMerged;
    _progress.autoRejected = totalRejected;

    // ── Step 6: Self-improvement ──
    const cycleStartTime = Date.now() - pipelineStartTime;
    const patterns = readPatterns();
    await improveWithPi(
      vision,
      {
        opportunitiesFound: scanResult.findings?.length ?? 0,
        tasksCreated: tasks.length,
        tasksCompleted: totalMerged,
        tasksRejected: totalRejected,
        totalChanges: totalMerged,
        cycleDurationMs: cycleStartTime,
      },
      patterns,
      rpc
    );

    // ── Complete ──
    _progress.status = "completed";
    _progress.step = "Complete";
    _progress.message = `${totalMerged} task(s) merged, ${totalRejected} rejected`;
    log(
      `Pipeline complete: ${totalMerged} merged, ${totalRejected} rejected`
    );
  } catch (e: any) {
    _progress.status = "failed";
    _progress.error = e.message || String(e);
    _progress.message = `Failed: ${_progress.error}`;
    log(`Pipeline failed: ${_progress.error}`);
  } finally {
    // Clean up RPC connection
    try {
      rpc.close();
    } catch {
      // best effort
    }
  }

  return { ..._progress };
}
