#!/usr/bin/env node
/**
 * loopi — Local Autonomous Improvement Agent
 *
 * CLI entry point. The improvement pipeline runs inside your
 * pi coding assistant, which reads src/pipeline.ts as
 * its orchestration specification.
 *
 * Usage:
 *   loopi run              → Print spec for pi agent to execute
 *   loopi watch            → Continuous improvement mode
 *   loopi approve          → Apply the latest pending diff
 *   loopi reject           → Discard the latest pending diff
 *   loopi status           → Show system status
 *   loopi dashboard        → Open the TUI dashboard (or: tui)
 *   loopi init             → Initialize loopi in the current repo
 *   loopi install          → Install loopi agents globally
 *   loopi promote          → Merge dev → main (end of session)
 *
 * Config: .pi/loopi/config.json (optional)
 */
import { exit } from "process";
import { logger } from "./actions/logger.js";
import { loadConfig } from "./actions/config.js";
import { readVision, approvePending, rejectPending, promoteToMain, PIPELINE_SPEC } from "./pipeline.js";
import { listPending } from "./actions/pr.js";
import { runDashboard } from "./tui/dashboard.js";
import { installAgents } from "./actions/install.js";
import { initProject } from "./actions/init.js";
import { showStatus } from "./actions/status.js";
import pc from "picocolors";

async function main() {
  const command = process.argv[2] ?? "run";

  // Commands that don't need config validation
  switch (command) {
    case "install":
    case "--install": {
      const count = installAgents();
      console.log(pc.green(`\n✓ Installed ${count} loopi agents globally`));
      exit(0);
    }

    case "init":
    case "--init": {
      initProject();
      exit(0);
    }

    case "--help":
    case "help":
    case "-h": {
      showHelp();
      exit(0);
    }
  }

  // Load config — uses defaults if no file exists
  try {
    loadConfig();
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Run `loopi init` to set up the project.");
    exit(1);
  }

  switch (command) {
    case "approve":
    case "--apply": {
      logger.info(`Applying latest pending patch...`);
      const ok = await approvePending(".");
      if (!ok && listPending().length === 0) {
        // No pending patches is a clean state, not an error
        exit(0);
      }
      exit(ok ? 0 : 1);
    }

    case "reject":
    case "--reject": {
      logger.info("Rejecting latest pending patch...");
      const ok = await rejectPending();
      if (!ok && listPending().length === 0) {
        // No pending patches is a clean state, not an error
        exit(0);
      }
      exit(ok ? 0 : 1);
    }

    case "status":
    case "--status": {
      showStatus();
      exit(0);
    }

    case "run":
    case "--run": {
      console.log(RUN_PROMPT);
      exit(0);
    }

    case "watch":
    case "--watch": {
      console.log(WATCH_PROMPT);
      exit(0);
    }

    case "promote":
    case "--promote": {
      logger.info("Promoting dev → main...");
      const ok = await promoteToMain(".");
      exit(ok ? 0 : 1);
    }

    case "dashboard":
    case "tui":
    case "--dashboard": {
      await runDashboard();
      exit(0);
    }

    default: {
      showHelp();
      exit(0);
    }
  }
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
    loopi <command>

  Commands:
    run           Execute one improvement cycle (default)
    status        Show current system state
    dashboard     Open the live TUI dashboard
    approve       Apply the latest pending diff → merges into dev
    reject        Discard the latest pending diff
    init          Initialize loopi in the current repo
    install       Install loopi agents globally for pi.dev
    promote       Merge dev → main (end of session)
    help          Show this message

  Examples:
    pnpx @loopi-cli/loopi init
    pnpx @loopi-cli/loopi status
    pnpx @loopi-cli/loopi dashboard
    pnpx @loopi-cli/loopi approve
    pnpx @loopi-cli/loopi promote
    pnpx @loopi-cli/loopi run

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
║   with all code changes requiring human approval.        ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`;

const RUN_PROMPT = `
${HEADER}

  ✅ Setup ready — all config loaded.
  📋 To the pi coding assistant: read and execute the pipeline
     specification below using subagent() and bash tools.

  Commands:
    loopi status          → Show current system state
    loopi dashboard       → Open the live TUI dashboard
    loopi approve         → Apply the latest pending diff
    loopi reject          → Discard the latest pending diff
    loopi init            → (Re)initialize loopi
    loopi promote         → Merge dev → main (end of session)

${PIPELINE_SPEC}
`;

const WATCH_PROMPT = `
${HEADER}

  🕐 Continuous improvement mode

  Tell your pi coding assistant:

     "Run loopi in watch mode — continuously improve the repo"

  The pi agent will loop through improvement cycles. After each
  applied change, it immediately starts the next cycle. When no
  improvements are available, it retries periodically.

  Press Ctrl+C to stop the watch loop at any time.
`;

main().catch((err) => {
  console.error("Fatal error:", err);
  exit(1);
});
