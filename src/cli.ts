#!/usr/bin/env node
/**
 * loopi — Local Autonomous Improvement Agent
 *
 * Single command: just `loopi`.
 *   - Auto-inits if first run
 *   - Auto-installs agents if missing
 *   - Opens the TUI dashboard
 *
 * That's it. Everything in one.
 */
import { exit } from "process";
import { homedir } from "os";
import { existsSync } from "fs";
import { resolve } from "path";
import { loadConfig } from "./actions/config.js";
import { runDashboard } from "./tui/dashboard.js";
import { installAgents } from "./actions/install.js";
import { initProject } from "./actions/init.js";
import pc from "picocolors";

async function main() {
  const arg = process.argv[2]?.toLowerCase();

  // Only allow --help and --version as flags
  if (arg === "--help" || arg === "help" || arg === "-h") {
    showHelp();
    exit(0);
  }
  if (arg === "--version" || arg === "-v") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = await import("../package.json", { with: { type: "json" } });
    console.log(pkg.default.version);
    exit(0);
  }

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

  // Auto-install agents (idempotent — overwrites existing)
  const agentDir = resolve(
    homedir(),
    ".pi/agent/agents"
  );
  const needsInstall =
    !existsSync(agentDir) ||
    !existsSync(resolve(agentDir, "vision-agent.md"));
  if (needsInstall) {
    const count = installAgents();
    console.log(pc.green(`\n✓ Installed ${count} loopi agents globally`));
  }

  // Open dashboard
  await runDashboard();
  exit(0);
}

// ──────────────────────────────────────────────
// Help
// ──────────────────────────────────────────────

function showHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   loopi — Local Autonomous Improvement Agent            ║
╚══════════════════════════════════════════════════════════╝

  Usage:
    loopi                 Auto-init + auto-install + open dashboard (default)
    loopi --help          Show this message
    loopi --version       Show version

  Everything is in the TUI dashboard:
    [a] approve patch     [R] reject patch       [p] promote dev→main
    [?] show pipeline spec [q] quit              [r] refresh

  Examples:
    pnpx @rkhatkhede/loopi

  Learn more: https://github.com/rkhatkhede/loopi
  `);
}

// ──────────────────────────────────────────────
// Entrypoint
// ──────────────────────────────────────────────

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`\n✖ ${msg}`));
  if (process.env.DEBUG) {
    console.error(pc.dim(err instanceof Error ? err.stack ?? "" : ""));
  }
  exit(1);
});
