#!/usr/bin/env node
/**
 * loopi — Local Autonomous Improvement Agent
 *
 * CLI entry point. The improvement pipeline runs inside your
 * pi coding assistant, which reads src/pipeline.ts as
 * its orchestration specification.
 *
 * Usage:
 *   loopi                 → Auto-init if needed, print pipeline spec
 *   loopi dashboard       → Open the TUI dashboard (or: tui)
 *   loopi install         → Install loopi agents globally
 *   loopi --help          → Show this message
 *
 * Config: .pi/loopi/config.json (optional)
 */
import { exit } from "process";
import { existsSync } from "fs";
import { resolve } from "path";
import { logger } from "./actions/logger.js";
import { loadConfig } from "./actions/config.js";
import { PIPELINE_SPEC, readVision, readPatterns } from "./pipeline.js";
import { runDashboard } from "./tui/dashboard.js";
import { installAgents } from "./actions/install.js";
import { initProject } from "./actions/init.js";
import { listPending } from "./actions/pr.js";
import pc from "picocolors";

async function main() {
  const command = process.argv[2] ?? "run";

  switch (command) {
    case "install":
    case "--install": {
      const count = installAgents();
      console.log(pc.green(`\n✓ Installed ${count} loopi agents globally`));
      exit(0);
    }

    case "dashboard":
    case "tui":
    case "--dashboard": {
      console.log(pc.dim("Loading dashboard..."));
      await runDashboard();
      exit(0);
    }

    case "--help":
    case "help":
    case "-h": {
      showHelp();
      exit(0);
    }

    default: {
      // Default: auto-init if needed, then print pipeline spec
      runDefault();
      exit(0);
    }
  }
}

function runDefault(): void {
  // Auto-init if not yet set up
  const configDir = resolve(process.cwd(), ".pi/loopi");
  if (!existsSync(configDir)) {
    console.log(pc.dim("⚡ First run — initializing loopi..."));
    initProject();
    console.log();
  }

  // Load config
  try {
    loadConfig();
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(pc.dim("Try deleting .pi/loopi/config.json and running loopi again."));
    exit(1);
  }

  // Show a quick status summary
  console.log(summaryLine());

  console.log(RUN_PROMPT);
}

function summaryLine(): string {
  const parts: string[] = [];

  // Vision
  const vision = readVision();
  if (vision) {
    const total = vision.milestones?.length ?? 0;
    const done = vision.milestones?.filter((m) => m.status === "completed").length ?? 0;
    if (total > 0) {
      parts.push(pc.green(`✓ milestones ${done}/${total}`));
    } else {
      parts.push(pc.green("✓ vision set"));
    }
  } else {
    parts.push(pc.yellow("○ no vision yet"));
  }

  // Pending patches
  const pending = listPending();
  if (pending.length > 0) {
    parts.push(pc.yellow(`⚠ ${pending.length} patch${pending.length > 1 ? "es" : ""} pending (dashboard)`));
  } else {
    parts.push(pc.dim("○ no pending patches"));
  }

  // Past patterns
  const patterns = readPatterns();
  if (patterns.length > 0) {
    const last = patterns[patterns.length - 1]!;
    const ago = msAgo(last.createdAt);
    parts.push(pc.dim(`◈ ${patterns.length} pattern${patterns.length > 1 ? "s" : ""}, latest ${ago}`));
  }

  return parts.join(pc.dim(" · "));
}

function msAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

// ──────────────────────────────────────────────
// Help & prompts
// ──────────────────────────────────────────────

function showHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   loopi — Local Autonomous Improvement Agent            ║
╚══════════════════════════════════════════════════════════╝

  Usage:
    loopi                 Auto-init + print pipeline spec (default)
    loopi dashboard       Open the live TUI dashboard
    loopi install         Install loopi agents globally for pi.dev
    loopi --help          Show this message

  The TUI dashboard has approve/reject/promote built in:
    [a] approve patch    [R] reject patch    [p] promote dev→main

  Examples:
    pnpx @rkhatkhede/loopi
    pnpx @rkhatkhede/loopi dashboard

  Learn more: https://github.com/rkhatkhede/loopi
  `);
}

const HEADER = `
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   loopi — Local Autonomous Improvement Agent            ║
║                                                          ║
║   The improvement pipeline runs inside your pi           ║
║   coding assistant using subagents for each step,        ║
║   with all code changes reviewed via the TUI dashboard.  ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`;

const RUN_PROMPT = `
${HEADER}

  ✅ Setup ready — all config loaded.
  📋 To the pi coding assistant: read and execute the pipeline
     specification below using subagent() and bash tools.

  Dashboard:
    loopi dashboard       → Open TUI (approve/reject/promote via keys)

${PIPELINE_SPEC}
`;

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`\n✖ ${msg}`));
  if (process.env.DEBUG) {
    console.error(pc.dim(err instanceof Error ? err.stack ?? "" : ""));
  }
  exit(1);
});
