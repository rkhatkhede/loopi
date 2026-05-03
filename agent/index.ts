#!/usr/bin/env node
/**
 * piloop — Local Autonomous Improvement Agent
 *
 * Usage:
 *   pnpm agent:run              Run one improvement cycle
 *   pnpm agent:run --watch      Run and continue watching (auto mode)
 *   pnpm agent:run --apply      Apply all approved patches
 *   pnpm agent:run --status     Show current status
 *   pnpm agent:run --once       Force run one cycle (even with no signals)
 *
 * Config: agent/agent.config.json
 */
import { exit } from "process";
import { logger } from "./src/actions/logger.js";
import { loadConfig } from "./src/actions/config.js";
import { Pipeline } from "./src/pipeline.js";

// Suppress noisy ts-node warnings
process.env.TS_NODE_TRANSPILE_ONLY = "true";

async function main() {
  const args = process.argv.slice(2);

  // Load config
  try {
    loadConfig();
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Run from project root with agent/agent.config.json present.");
    exit(1);
  }

  const pipeline = new Pipeline();

  if (args.includes("--status") || args[0] === "status") {
    // Delegate to status tool
    const { showStatus } = await import("./src/actions/status.js");
    showStatus();
    return;
  }

  if (args.includes("--apply") || args[0] === "apply") {
    logger.info("Applying all approved patches...");
    await pipeline.applyApprovedPatches();
    return;
  }

  if (args.includes("--watch") || args[0] === "watch") {
    logger.info("Starting auto-watch mode...");
    pipeline.startAutoMode();

    // Keep alive
    process.on("SIGINT", () => {
      pipeline.stopAutoMode();
      logger.info("Shutting down...");
      exit(0);
    });
    process.on("SIGTERM", () => {
      pipeline.stopAutoMode();
      exit(0);
    });

    // Wait indefinitely
    await new Promise(() => {});
  }

  // Default: run once
  const state = await pipeline.runOnce();
  const statusEmoji: Record<string, string> = {
    completed: "✓",
    failed: "✗",
    idle: "○",
    detecting: "…",
    analyzing: "…",
    planning: "…",
    generating: "…",
    reviewing: "…",
    applying: "…",
  };

  console.log(`\n${"─".repeat(45)}`);
  console.log(` ${statusEmoji[state.status] ?? "?"} Pipeline: ${state.status}`);
  if (state.completedAt && state.startedAt) {
    const duration = ((state.completedAt - state.startedAt) / 1000).toFixed(1);
    console.log(` ⏱  Duration: ${duration}s`);
  }
  if (state.signals) {
    console.log(` 📡 Signals: ${state.signals.length}`);
  }
  if (state.analysis) {
    console.log(` 📊 Health score: ${state.analysis.healthScore}/100`);
  }
  if (state.plan) {
    console.log(` 📋 Plan: ${state.plan.summary.slice(0, 60)}`);
    console.log(` ⚠️  Risk: ${state.plan.risk}`);
  }
  if (state.review) {
    console.log(` 🔍 Review: ${state.review.approved ? "✓ Approved" : "✗ Rejected"}`);
  }
  if (state.error) {
    console.log(` ❌ Error: ${state.error}`);
  }
  console.log(`${"─".repeat(45)}\n`);

  // Exit with proper code
  if (state.status === "failed") exit(1);
  exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  exit(1);
});
