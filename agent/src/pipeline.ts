import { globby } from "globby";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { PipelineState, Signal } from "./types/index.js";
import { loadConfig, getConfig } from "./actions/config.js";
import { logger } from "./actions/logger.js";
import { applyDiff, createCommit, createBranch, pushBranch } from "./actions/git.js";
import { writePendingPR, moveToApproved, listApproved, readDiffFile } from "./actions/pr.js";
import { detectAllSignals } from "./signals/detectors.js";
import { analyzeCodebase } from "./analyzers/analyzer.js";
import { planImprovement } from "./planners/planner.js";
import { generatePatch } from "./workers/patch-generator.js";
import { reviewPatchLocally } from "./reviewers/reviewer.js";

export class Pipeline {
  private state: PipelineState = { status: "idle" };
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor() {
    loadConfig();
    logger.info("piloop pipeline initialized");
  }

  getState(): PipelineState {
    return { ...this.state };
  }

  async runOnce(): Promise<PipelineState> {
    logger.info("=".repeat(50));
    logger.info("Starting improvement cycle");
    logger.info("=".repeat(50));

    try {
      // Step 1: Detect signals
      this.state = { status: "detecting" };
      const signals = await this.detectSignals();
      this.state.signals = signals;

      if (signals.length === 0) {
        logger.info("No signals detected. Nothing to improve.");
        this.state = { status: "completed" };
        return this.state;
      }

      // Step 2: Collect files
      const files = await this.collectFiles(signals);

      // Step 3: Analyze codebase
      this.state = { status: "analyzing" };
      const analysis = analyzeCodebase({ files, signals });
      this.state.analysis = analysis;

      // Step 4: Plan improvement
      this.state = { status: "planning" };
      const plan = planImprovement(analysis);
      this.state.plan = plan;

      // Step 5: Generate patch
      this.state = { status: "generating" };
      const patch = generatePatch(plan);
      this.state.patch = patch;

      // Step 6: Write pending PR
      writePendingPR(patch);

      // Step 7: Local review
      this.state = { status: "reviewing" };
      const review = reviewPatchLocally(patch, plan);
      this.state.review = review;

      if (review.approved) {
        // Step 8: Apply
        this.state = { status: "applying" };
        await this.applyPatch(patch, plan.summary);
        this.state = { status: "completed" };
      } else {
        logger.warn(`Patch rejected: ${review.recommendation}`);
        this.state = {
          ...this.state,
          status: "completed",
          error: `Patch rejected: ${review.recommendation}`,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Pipeline failed: ${msg}`);
      this.state = { ...this.state, status: "failed", error: msg };
    }

    this.state.completedAt = Date.now();

    // Save state
    this.saveState();

    return this.state;
  }

  private async detectSignals(): Promise<Signal[]> {
    logger.info("Step 1: Detecting signals...");
    const signals = await detectAllSignals();

    // Filter: require at least one meaningful signal
    const meaningful = signals.filter(
      (s) =>
        s.severity === "high" ||
        s.severity === "critical" ||
        s.type === "todo.present" ||
        s.type === "code.smell" ||
        s.type === "complexity.threshold"
    );

    if (signals.length > 0 && meaningful.length === 0) {
      // Low-severity signals only — still proceed if there's volume
      if (signals.length < 3) {
        logger.info("Only low-severity signals found. Skipping.");
        return [];
      }
    }

    return signals;
  }

  private async collectFiles(signals: Signal[]): Promise<string[]> {
    // Collect files referenced by signals + all agent source files
    const signalFiles = signals
      .filter((s) => s.file)
      .map((s) => s.file!)
      .filter((f) => f.endsWith(".ts"));

    const agentFiles = await globby(["agent/src/**/*.ts", "agent/index.ts"], {
      ignore: ["**/node_modules/**", "**/dist/**"],
    });

    // Merge and deduplicate
    const fileSet = new Set([...signalFiles, ...agentFiles]);
    const files = Array.from(fileSet);

    logger.info(`Collected ${files.length} files for analysis`);
    return files;
  }

  private async applyPatch(patch: { files: string[]; diff: string; id: string }, summary: string): Promise<void> {
    const config = getConfig();

    // Write diff to a temp file and apply it
    const diffPath = resolve(process.cwd(), ".piloop-current.diff");
    writeFileSync(diffPath, patch.diff, "utf-8");

    try {
      // Apply the diff
      await applyDiff(diffPath);
      logger.info("Diff applied successfully");

      // Create a branch and commit
      const branchName = `${config.git.branchPrefix}${summary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 50)}`;

      await createBranch(branchName);
      await createCommit(`${config.git.commitPrefix} ${summary}`);

      // Move to approved
      moveToApproved(patch.id);

      // Optionally push
      if (config.git.autoPush) {
        await pushBranch(branchName);
      }

      logger.info(`Changes committed to branch: ${branchName}`);
    } finally {
      // Clean up temp diff
      try {
        if (existsSync(diffPath)) unlinkSync(diffPath);
      } catch {
        // ignore
      }
    }
  }

  startAutoMode(): void {
    const intervalMs = getConfig().runFrequencyMinutes * 60 * 1000;
    logger.info(`Starting auto mode (every ${getConfig().runFrequencyMinutes} minutes)`);

    // Run immediately
    this.runOnce();

    // Schedule recurring runs
    this.intervalHandle = setInterval(() => {
      this.runOnce();
    }, intervalMs);
  }

  stopAutoMode(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.info("Auto mode stopped");
    }
  }

  private saveState(): void {
    try {
      const statePath = resolve(process.cwd(), "agent/logs/last-state.json");
      writeFileSync(statePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch {
      // ignore
    }
  }

  async applyApprovedPatches(): Promise<void> {
    const approved = listApproved();
    if (approved.length === 0) {
      logger.info("No approved patches to apply");
      return;
    }

    for (const patchFile of approved) {
      logger.info(`Applying approved patch: ${patchFile}`);
      const data = readDiffFile(patchFile);
      if (!data) {
        logger.error(`Could not read: ${patchFile}`);
        continue;
      }

      // Extract patch ID from metadata
      const patchId = data.metadata["piloop patch"] ?? patchFile;
      const files = (data.metadata["files"] ?? "").split(", ").filter(Boolean);

      const patch = {
        id: patchId,
        planId: data.metadata["plan"] ?? patchId,
        diff: data.content,
        timestamp: Date.now(),
        files,
        size: data.content.length,
        status: "approved" as const,
      };

      await this.applyPatch(patch, data.metadata["plan"] ?? patchId);
    }
  }
}
