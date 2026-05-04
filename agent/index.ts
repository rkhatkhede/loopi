#!/usr/bin/env node
/**
 * loopi — Local Autonomous Improvement Agent
 *
 * CLI entry point. The improvement pipeline runs inside your
 * pi coding assistant, which reads agent/src/pipeline.ts as
 * its orchestration specification.
 *
 * Usage:
 *   pnpm loopi run              → Print spec for pi agent to execute
 *   pnpm loopi run --target ..  → Same, targeting sibling repo
 *   pnpm loopi watch            → Continuous improvement mode
 *   pnpm loopi approve          → Apply the latest pending diff
 *   pnpm loopi reject           → Discard the latest pending diff
 *   pnpm loopi status           → Show system status
 *   pnpm loopi dashboard        → Open the TUI dashboard (or: tui)
 *   pnpm loopi init             → Run vision-agent to create vision.json
 *   pnpm loopi promote          → Merge dev → main (end of session)
 *
 * Config: agent/agent.config.json
 */
import { exit } from "process";
import { resolve } from "path";
import { logger } from "./src/actions/logger.js";
import { loadConfig } from "./src/actions/config.js";
import { readVision, approvePending, rejectPending, promoteToMain, PIPELINE_SPEC } from "./src/pipeline.js";
import { listPending } from "./src/actions/pr.js";
import { runDashboard } from "./src/tui/dashboard.js";

function parseArgs(argv: string[]): { command: string; target?: string } {
  const args = [...argv];
  let target: string | undefined;

  // Extract --target <path>
  const targetIdx = args.indexOf("--target");
  if (targetIdx >= 0 && targetIdx + 1 < args.length) {
    target = resolve(process.cwd(), args[targetIdx + 1]!);
    args.splice(targetIdx, 2);
  }

  const command = args[0] ?? "run";
  return { command, target };
}

async function main() {
  const { command, target } = parseArgs(process.argv.slice(2));

  // If --target was passed, set it as the working directory
  if (target) {
    logger.info(`Target repo: ${target}`);
    process.chdir(target);
  }

  // Load config — validates we're in the right directory
  try {
    loadConfig();
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Run from project root with agent/agent.config.json present.");
    console.error("Use --target <path> to point at another repo.");
    exit(1);
  }

  switch (command) {
    case "approve":
    case "--apply": {
      logger.info(`Applying latest pending patch...`);
      const ok = await approvePending(target ?? ".");
      if (!ok && listPending().length === 0) {
        // No pending patches is a clean state, not an error
        exit(0);
      }
      exit(ok ? 0 : 1);
    }

    case "reject":
    case "--reject": {
      logger.info("Rejecting latest pending patch...");
      const ok = rejectPending();
      if (!ok && listPending().length === 0) {
        // No pending patches is a clean state, not an error
        exit(0);
      }
      exit(ok ? 0 : 1);
    }

    case "status":
    case "--status": {
      const { showStatus } = await import("./src/actions/status.js");
      showStatus();
      exit(0);
    }

    case "init":
    case "--init": {
      console.log(INIT_PROMPT);
      exit(0);
    }

    case "--help":
    case "help":
    case "-h": {
      showHelp();
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
      const ok = await promoteToMain(target ?? ".");
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
    pnpm loopi <command>

  Commands:
    run           Execute one improvement cycle (default)
    status        Show current system state
    dashboard     Open the live TUI dashboard
    approve       Apply the latest pending diff → merges into dev
    reject        Discard the latest pending diff
    init          (Re)initialize the vision document
    promote       Merge dev → main (end of session)
    help          Show this message

  Options:
    --target <path>   Point at a sibling repository

  Examples:
    pnpm loopi status
    pnpm loopi dashboard
    pnpm loopi approve
    pnpm loopi promote
    pnpm loopi run --target ../some-project

  Learn more: https://github.com/your-org/loopi
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
    pnpm loopi status          → Show current system state
    pnpm loopi dashboard       → Open the live TUI dashboard
    pnpm loopi approve         → Apply the latest pending diff
    pnpm loopi reject          → Discard the latest pending diff
    pnpm loopi init            → (Re)initialize the vision document
    pnpm loopi run --target .. → Target a sibling repository
    pnpm loopi promote         → Merge dev → main (end of session)

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

const INIT_PROMPT = `
${HEADER}

  📝 Vision initialization

  Tell your pi coding assistant:

     "Run loopi.vision-agent to create the vision document"

  The vision agent will read your repo, ask a few questions about
  your goals, and create agent/vision.json — the strategic
  foundation for all future improvement cycles.
`;

main().catch((err) => {
  console.error("Fatal error:", err);
  exit(1);
});
