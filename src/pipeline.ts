/**
 * loopi — Pipeline Orchestrator
 *
 * This file is BOTH a TypeScript module (exporting utility functions)
 * AND a structured specification that a pi agent reads and executes.
 *
 * A pi agent has access to:
 *   - subagent()   — call specialized agents
 *   - bash         — run shell commands (node, git, etc.)
 *   - read/write/edit — file operations
 *   - grep/find/ls — code exploration
 *
 * === PIPELINE STEPS (for the pi agent) ===
 *
 * 1. [init]   vision-agent    — Ensure .pi/loopi/vision.json exists
 * 2. [cycle]  opportunity-agent — Find opportunities matching vision
 * 3. [cycle]  scout-agent      — Recon on chosen opportunity
 * 4. [cycle]  analysis-agent   — Deep analysis of relevant code
 * 5. [cycle]  planner-agent    — Step-by-step improvement plan
 * 6. [cycle]  patch-agent      — Generate new file contents
 * 7. [cycle]  reviewer-agent   — Safety review
 * 8. [gate]   HUMAN APPROVAL  — contact_supervisor, wait for decision
 * 9. [apply]  approvePending() — git apply + commit
 * 10. [docs]  docs-agent      — Sync documentation
 *
 * Each step uses subagent() for intelligence and
 * node to run the utility functions in this file (from dist/).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { z } from "zod/v3";

import {
  AgentOutputSchema,
  VisionSchema,
  OpportunitySchema,
  ScoutReportSchema,
  AnalysisReportSchema,
  ImprovementPlanSchema,
  PatchSchema,
  ReviewResultSchema,
  PatternSchema,
  ConfigSchema,
  type VisionDocument,
  type Opportunity,
  type ScoutReport,
  type AnalysisReport,
  type ImprovementPlan,
  type Patch,
  type ReviewResult,
  type Pattern,
  type Config,
  type CycleResult,
  GoalSchema,
  type Goal,
  TaskSchema,
  type Task,
  AGENTS,
} from "./types/index.js";

import { logger } from "./actions/logger.js";
import { getConfig } from "./actions/config.js";
import { getGit, applyDiff, createCommit, createBranch, ensureBranch, mergeBranch, deleteBranch, getCurrentBranch, checkoutBranch, hasUncommittedChanges } from "./actions/git.js";
import { writePendingPR, moveToApproved, listPending } from "./actions/pr.js";

// ──────────────────────────────────────────────
// Agent output parser — runtime Zod validation
// ──────────────────────────────────────────────

/**
 * Extract a JSON block from agent output and validate against a Zod schema.
 *
 * Handles three formats:
 * 1. ```json ... ``` fenced block (most common)
 * 2. A plain JSON object/array
 * 3. Text containing { ... } or [ ... ] block (extracts first match)
 *
 * @throws Error if no valid JSON matching the schema is found.
 */
export function parseAgentOutput<T>(
  output: string,
  schema: z.ZodType<T>,
  label?: string
): T {
  // Strategy 1: Extract from ```json ... ``` fences
  const fenceMatch = output.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]!.trim());
      return schema.parse(parsed);
    } catch (err) {
      logger.warn(
        `parseAgentOutput(${label ?? "unknown"}): fenced JSON failed — trying raw output`
      );
    }
  }

  // Strategy 2: Try parsing the whole output as JSON
  try {
    const parsed = JSON.parse(output.trim());
    return schema.parse(parsed);
  } catch {
    // fall through
  }

  // Strategy 3: Look for any { ... } or [ ... ] block in the text
  const braceMatch = output.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[1]!.trim());
      return schema.parse(parsed);
    } catch (err) {
      throw new Error(
        `parseAgentOutput(${label ?? "unknown"}): ` +
        `found JSON but schema validation failed:\n${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  throw new Error(
    `parseAgentOutput(${label ?? "unknown"}): no valid JSON found in agent output`
  );
}

/**
 * Parse an agent output container ({ type, data }) and validate
 * just the data payload against the given schema.
 *
 * ```json
 * { "type": "vision", "data": { ... } }
 * ```
 */
export function parseAgentData<T>(
  output: string,
  schema: z.ZodType<T>,
  label?: string
): T {
  const container = parseAgentOutput(output, AgentOutputSchema, label);
  const data = container.data as unknown;
  try {
    return schema.parse(data);
  } catch (err) {
    throw new Error(
      `parseAgentData(${label ?? "unknown"}): ` +
      `agent returned type="${container.type}" but data failed validation:\n${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// ──────────────────────────────────────────────
// Concurrency lock (file-based)                  
// ──────────────────────────────────────────────

const LOCK_PATH = resolve(process.cwd(), ".pi/loopi/.pipeline.lock");

/**
 * Acquire a pipeline lock. Throws if another pipeline is running.
 */
export function acquireLock(): void {
  if (existsSync(LOCK_PATH)) {
    const pid = readFileSync(LOCK_PATH, "utf-8").trim();
    throw new Error(
      `Pipeline lock held by pid=${pid} at ${LOCK_PATH}. ` +
      `If no other pipeline is running, delete the lock file and retry.`
    );
  }
  writeFileSync(LOCK_PATH, String(process.pid), "utf-8");
}

/**
 * Release the pipeline lock.
 */
export function releaseLock(): void {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* already gone — fine */
  }
}

// ──────────────────────────────────────────────
// Mechanical utility functions
// (Called by the pi agent via: bash node dist/... )
// ──────────────────────────────────────────────

/**
 * Read the vision document from disk. Returns null if missing.
 */
export function readVision(): VisionDocument | null {
  const path = resolve(process.cwd(), ".pi/loopi/vision.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return VisionSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.error(`Invalid vision.json: ${err}`);
    return null;
  }
}

/**
 * Save the vision document to disk.
 */
export function saveVision(vision: VisionDocument): void {
  const path = resolve(process.cwd(), ".pi/loopi/vision.json");
  writeFileSync(path, JSON.stringify(vision, null, 2), "utf-8");
  logger.info(`Vision saved to: ${path}`);
}

/**
 * Read opportunity history (suggested/accepted/rejected/applied).
 */
export function readOpportunityHistory(): Opportunity[] {
  const cfg = getConfig();
  const path = resolve(
    process.cwd(),
    cfg.opportunity?.historyFile ?? ".pi/loopi/opportunity-history.json"
  );
  if (!existsSync(path)) return [];
  try {
    return z
      .array(OpportunitySchema)
      .parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return [];
  }
}

/**
 * Save an opportunity using atomic write (temp file + rename).
 * Prevents partial writes and read-modify-write clobbering.
 */
export function saveOpportunity(opportunity: Opportunity): void {
  const cfg = getConfig();
  const targetPath = resolve(
    process.cwd(),
    cfg.opportunity?.historyFile ?? ".pi/loopi/opportunity-history.json"
  );
  const existing = readOpportunityHistory();
  const idx = existing.findIndex((o) => o.id === opportunity.id);
  if (idx >= 0) {
    existing[idx] = opportunity;
  } else {
    existing.push(opportunity);
  }
  const tmpPath = resolve(dirname(targetPath), `.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(existing, null, 2), "utf-8");
  renameSync(tmpPath, targetPath);
}

/**
 * Read all patterns from disk.
 */
export function readPatterns(): Pattern[] {
  const path = resolve(process.cwd(), ".pi/loopi/patterns.json");
  if (!existsSync(path)) return [];
  try {
    return z.array(PatternSchema).parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return [];
  }
}

/**
 * Append a pattern to the patterns file.
 */
export function savePattern(pattern: Pattern): void {
  const path = resolve(process.cwd(), ".pi/loopi/patterns.json");
  const existing = readPatterns();
  existing.push(pattern);
  const tmpPath = resolve(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(existing, null, 2), "utf-8");
  renameSync(tmpPath, path);
  logger.info(`Pattern saved: ${pattern.summary}`);
}

// ─── Goals ───

const GOALS_FILE = ".pi/loopi/goals.json";

/**
 * Read all goals from disk.
 */
export function readGoals(): Goal[] {
  const path = resolve(process.cwd(), GOALS_FILE);
  if (!existsSync(path)) return [];
  try {
    return z.array(GoalSchema).parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return [];
  }
}

/**
 * Save or update a goal using atomic write.
 */
export function saveGoal(goal: Goal): void {
  const path = resolve(process.cwd(), GOALS_FILE);
  const existing = readGoals();
  const idx = existing.findIndex((g) => g.id === goal.id);
  if (idx >= 0) {
    existing[idx] = goal;
  } else {
    existing.push(goal);
  }
  const tmpPath = resolve(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(existing, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

/**
 * Replace all goals atomically (used during goal regeneration).
 */
export function replaceGoals(goals: Goal[]): void {
  const path = resolve(process.cwd(), GOALS_FILE);
  const tmpPath = resolve(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(goals, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

// ─── Tasks ───

const TASKS_FILE = ".pi/loopi/tasks.json";

/**
 * Read all tasks from disk.
 */
export function readTasks(): Task[] {
  const path = resolve(process.cwd(), TASKS_FILE);
  if (!existsSync(path)) return [];
  try {
    return z.array(TaskSchema).parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return [];
  }
}

/**
 * Save or update a task using atomic write.
 */
export function saveTask(task: Task): void {
  const path = resolve(process.cwd(), TASKS_FILE);
  const existing = readTasks();
  const idx = existing.findIndex((t) => t.id === task.id);
  if (idx >= 0) {
    existing[idx] = task;
  } else {
    existing.push(task);
  }
  const tmpPath = resolve(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(existing, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

/**
 * Update the status of multiple tasks at once (e.g. mark all failed).
 */
export function updateTaskStatus(
  taskIds: string[],
  status: Task["status"]
): void {
  const tasks = readTasks();
  let changed = false;
  for (const task of tasks) {
    if (taskIds.includes(task.id) && task.status !== status) {
      task.status = status;
      if (status === "completed") task.completedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (!changed) return;
  const path = resolve(process.cwd(), TASKS_FILE);
  const tmpPath = resolve(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(tasks, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

/**
 * Apply a patch using the dev-branch workflow:
 *
 *   1. Check for uncommitted changes — fail early if dirty
 *   2. Checkout/ensure dev branch (created from main if not exists)
 *   3. Create feature branch from dev: loopi/<summary>-<timestamp>
 *   4. Apply the diff to the feature branch
 *   5. Commit to the feature branch
 *   6. Checkout dev, merge feature branch (--no-ff)
 *   7. Delete feature branch
 *
 * Returns the feature branch name.
 */
export async function applyPatch(
  diff: string,
  summary: string,
  targetRoot = "."
): Promise<string> {
  const git = getGit(targetRoot);

  // Temporary diff file
  const diffDir = resolve(targetRoot, ".pi/loopi/workflows");
  if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true });
  const diffPath = resolve(diffDir, ".loopi-current.diff");
  writeFileSync(diffPath, diff.replace(/\r/g, ""), "utf-8");

  // Acquire pipeline lock (prevents concurrent runs)
  acquireLock();

  // Fail early if working tree is dirty
  if (await hasUncommittedChanges()) {
    releaseLock();
    throw new Error("Working tree has uncommitted changes. Commit or stash them first.");
  }

  try {
    // Determine which branch to use as base
    const currentBranch = await getCurrentBranch();
    const baseBranch = "dev";

    // Ensure dev branch exists (create from main if needed)
    if (currentBranch !== baseBranch) {
      const branches = await git.branchLocal();
      if (!branches.all.includes(baseBranch)) {
        // Create dev from main
        await checkoutBranch("main");
        await createBranch(baseBranch);
        logger.info(`Created dev branch from main`);
      } else {
        await checkoutBranch(baseBranch);
      }
    } else {
      // On dev — ensure it exists (create from main)
      const branches = await git.branchLocal();
      if (!branches.all.includes(baseBranch)) {
        await checkoutBranch("main");
        await createBranch(baseBranch);
        logger.info(`Created dev branch from main`);
      }
    }

    // Pull latest dev if remote exists
    try {
      await git.pull("origin", baseBranch);
    } catch (pullErr) {
      // No remote or merge conflict — log and continue
      const msg = pullErr instanceof Error ? pullErr.message : String(pullErr);
      if (msg.includes("couldn't find remote") || msg.includes("No remote")) {
        logger.info("No remote configured, skipping pull");
      } else if (msg.includes("merge")) {
        // Abort any in-progress merge so the working tree is clean
        logger.warn(`Pull merge conflict — aborting merge: ${msg}`);
        await git.raw(["merge", "--abort"]).catch(() => {});
        throw new Error(`git pull conflict on ${baseBranch}: ${msg}`);
      } else {
        logger.warn(`git pull skipped: ${msg}`);
      }
    }

    // Create feature branch from dev
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const cfg = getConfig();
    const branchName = `${cfg.git.branchPrefix}${summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)}-${timestamp}`;

    await createBranch(branchName);

    // Apply the diff to the feature branch
    await applyDiff(diffPath);

    // Commit
    await createCommit(`${cfg.git.commitPrefix} ${summary}`);

    // Switch back to dev — changes stay on the feature branch for review
    await checkoutBranch(baseBranch);

    logger.info(`Applied ${summary} → feature branch ${branchName} (waiting for approval)`);
    return branchName;
  } finally {
    // Release lock
    releaseLock();

    // Clean up temp diff file
    try {
      unlinkSync(diffPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Write a pending diff for human review.
 */
export function writePending(patch: Patch): string {
  return writePendingPR(patch);
}

/**
 * Get the latest pending diff filename, or null.
 */
export function getLatestPending(): string | null {
  const pending = listPending();
  if (pending.length === 0) return null;
  return pending.sort().reverse()[0]!;
}

/**
 * Approve the latest pending patch — apply, commit, move to approved.
 */
export async function approvePending(targetRoot = "."): Promise<boolean> {
  const { readDiffFile } = await import("./actions/pr.js");
  const latest = getLatestPending();
  if (!latest) {
    logger.info("No pending patches to approve.");
    return false;
  }

  const data = readDiffFile(latest);
  if (!data) {
    logger.error(`Could not read: ${latest}`);
    return false;
  }

  const patchId = data.metadata["loopi patch"] ?? latest;
  const planSummary = data.metadata["plan"] ?? "improvement";

  await applyPatch(data.content, planSummary, targetRoot);
  moveToApproved(patchId);
  logger.info(`Applied and approved: ${latest}`);
  return true;
}

/**
 * Approve a feature branch — merge it into dev and delete the branch.
 */
export async function approveFeatureBranch(
  branchName: string,
  targetRoot = "."
): Promise<boolean> {
  const git = getGit(targetRoot);
  const currentBranch = await getCurrentBranch();

  try {
    // Ensure we're on dev
    if (currentBranch !== "dev") {
      await checkoutBranch("dev");
    }

    // Merge feature branch into dev (squash merge with a single commit)
    const cfg = getConfig();
    await mergeBranch(branchName, `${cfg.git.commitPrefix} merge ${branchName}`);

    // Delete the feature branch
    await deleteBranch(branchName);

    logger.info(`Approved: merged ${branchName} into dev`);
    return true;
  } catch (err) {
    logger.error(`Failed to approve ${branchName}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Reject a feature branch — delete it without merging.
 */
export async function rejectFeatureBranch(
  branchName: string,
  targetRoot = "."
): Promise<boolean> {
  try {
    await deleteBranch(branchName);
    logger.info(`Rejected: deleted ${branchName}`);
    return true;
  } catch (err) {
    logger.error(`Failed to reject ${branchName}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * List active feature branches (branches with the configured prefix).
 */
export async function getActiveFeatureBranches(targetRoot = "."): Promise<string[]> {
  const git = getGit(targetRoot);
  const cfg = getConfig();
  const prefix = cfg.git.branchPrefix;
  const branches = await git.branchLocal();
  return branches.all
    .filter((b: string) => b.startsWith(prefix))
    .sort()
    .reverse();
}

/**
 * Reject the latest pending patch — delete it.
 */
export async function rejectPending(): Promise<boolean> {
  const latest = getLatestPending();
  if (!latest) {
    logger.info("No pending patches to reject.");
    return false;
  }
  const path = resolve(process.cwd(), ".pi/loopi/workflows/pending", latest);
  try {
    const { unlink } = await import("fs/promises");
    await unlink(path);
    logger.info(`Rejected: ${latest}`);
    return true;
  } catch (err) {
    logger.error(`Could not delete: ${latest}`);
    return false;
  }
}

/**
 * Promote dev → main when the session is complete.
 * Merges all accumulated dev changes into main (fast-forward),
 * staying on main afterward.
 */
export async function promoteToMain(targetRoot = "."): Promise<boolean> {
  const git = getGit(targetRoot);
  const currentBranch = await getCurrentBranch();

  // Acquire pipeline lock (prevents concurrent runs)
  acquireLock();

  // Fail early if working tree is dirty
  if (await hasUncommittedChanges()) {
    releaseLock();
    logger.error("Working tree has uncommitted changes. Commit or stash them first.");
    return false;
  }

  try {
    // Check dev exists
    const branches = await git.branchLocal();
    if (!branches.all.includes("dev")) {
      logger.error("No dev branch found. Nothing to promote.");
      return false;
    }

    // Ensure dev is up to date
    if (currentBranch !== "dev") {
      await checkoutBranch("dev");
    }

    // Pull if remote
    try {
      await git.pull("origin", "dev");
    } catch {
      /* no remote */
    }

    // Switch to main
    await checkoutBranch("main");

    // Pull if remote
    try {
      await git.pull("origin", "main");
    } catch {
      /* no remote */
    }

    // Merge dev into main
    await mergeBranch("dev", "feat(loopi): promote dev to main");

    logger.info("Promoted dev → main successfully");
    return true;
  } finally {
    releaseLock();
  }
}

// ──────────────────────────────────────────────
// Pipeline specification
//
// The pi agent reads this and executes each step
// using subagent() for intelligence and
// bash + node for mechanical operations.
// ──────────────────────────────────────────────

export const PIPELINE_SPEC = `
# loopi Pipeline Specification

> 🔁 **Retry strategy (use for every step):**
>   1st failure → wait 2s, retry
>   2nd failure → wait 5s, retry
>   3rd failure → wait 10s, retry
>   4th failure → abort cycle with error message
>   Use parseAgentOutput / parseAgentData for runtime validation.
>   If validation fails after retries, log the error and exit gracefully.

## Step 1: Ensure Vision
- If .pi/loopi/vision.json doesn't exist, run:
  subagent({ agent: "${AGENTS.VISION}", task: "Create vision document for this repo" })
- Read .pi/loopi/vision.json and pass it to all downstream agents.
- Validate the output with: parseAgentData(output, VisionSchema, "vision")

## Step 2: Find Opportunity
- Read .pi/loopi/patterns.json via bash: node -e "import('./dist/pipeline.js').then(m => console.log(JSON.stringify(m.readPatterns())))"
- Run: subagent({ agent: "${AGENTS.OPPORTUNITY}", task: JSON.stringify({ vision, history, patterns }) })
- Validate the output with: parseAgentData(output, z.array(OpportunitySchema), "opportunity")
- Pick the best opportunity (highest value/effort ratio).
- If none found, exit with "nothing to improve."

## Step 3: Scout
- Run: subagent({ agent: "${AGENTS.SCOUT}", task: JSON.stringify({ opportunity }) })
- Validate the output with: parseAgentData(output, ScoutReportSchema, "scout")

## Step 4: Analyze
- Run: subagent({ agent: "${AGENTS.ANALYSIS}", task: JSON.stringify({ opportunity, scout }) })
- Validate the output with: parseAgentData(output, AnalysisReportSchema, "analysis")

## Step 5: Plan
- Run: subagent({ agent: "${AGENTS.PLANNER}", task: JSON.stringify({ analysis, constraints }) })
- Validate the output with: parseAgentData(output, ImprovementPlanSchema, "plan")

## Step 6: Generate Patch
- Run: subagent({ agent: "${AGENTS.PATCH}", task: JSON.stringify({ plan }) })
- Validate patch output with: parseAgentData(output, PatchSchema, "patch")

## Step 7: Review
- Run: subagent({ agent: "${AGENTS.REVIEWER}", task: JSON.stringify({ plan, diff, originalFiles }) })
- Validate the output with: parseAgentData(output, ReviewResultSchema, "review")
- If not approved (result.approved === false), abort with "patch rejected: <reason>".

## Step 8: Human Gate
- Write diff to .pi/loopi/workflows/pending/ via writePending()
- Use contact_supervisor to show the diff to the user:
  contact_supervisor({
    reason: "need_decision",
    message: "=== Review this patch ===\\n\\n" + diff + "\\n\\nApprove? Run: loopi approve  |  Reject? Run: loopi reject"
  })
- Wait for the user's response.
- If user says 'reject' or 'no': abort with "rejected by user."
- If user says 'approve' or 'yes': continue.

## Step 9: Apply (dev-branch workflow)
- Run: bash: loopi approve
- This calls approvePending() which:
  1. Switches to the \`dev\` branch (creating it from \`main\` if needed)
  2. Creates a feature branch \`loopi/<summary>-<timestamp>\` from \`dev\`
  3. Applies the diff to the feature branch
  4. Commits to the feature branch
  5. Switches back to \`dev\`
  6. Merges the feature branch into \`dev\` (--no-ff)
  7. Deletes the feature branch
  8. Stays on \`dev\` ready for the next cycle

## Step 10: Update Docs
- Run: subagent({ agent: "${AGENTS.DOCS}", task: JSON.stringify({ plan, diff }) })
- Validate the output with: parseAgentData(output, z.object({ filesUpdated: z.array(z.string()), summary: z.string() }), "docs")
- The docs agent will also save a pattern record to .pi/loopi/patterns.json

## End of Cycle
- All approved changes accumulate on \`dev\`.
- At the end of a complete session, promote \`dev → main\` with: loopi promote
`;
