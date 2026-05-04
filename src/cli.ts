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
import { PIPELINE_SPEC } from "./pipeline.js";
import { runDashboard } from "./tui/dashboard.js";
import { installAgents } from "./actions/install.js";
import { initProject } from "./actions/init.js";
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

  console.log(RUN_PROMPT);
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
  console.error("Fatal error:", err);
  exit(1);
});
