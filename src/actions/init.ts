import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { DEFAULT_CONFIG } from "../types/index.js";
import { installAgents } from "./install.js";
import pc from "picocolors";

/**
 * Initialize loopi in the current working directory.
 *
 * Creates:
 *   .pi/loopi/config.json   — default configuration
 *   .pi/loopi/workflows/     — pending and approved directories
 *
 * Also installs loopi agents globally for pi.dev discovery.
 */
export function initProject(): void {
  const cwd = process.cwd();
  const configDir = resolve(cwd, ".pi/loopi");
  const workflowsDir = resolve(configDir, "workflows");
  const pendingDir = resolve(workflowsDir, "pending");
  const approvedDir = resolve(workflowsDir, "approved");

  // Create directories
  mkdirSync(pendingDir, { recursive: true });
  mkdirSync(approvedDir, { recursive: true });

  // Write default config (only if not exists)
  const configPath = resolve(configDir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  }

  // Install agents globally
  const agentCount = installAgents();
  const globalDir = resolve(homedir(), ".pi/agent/agents");

  console.log(pc.bold(pc.green("\n✓ loopi initialized")));
  console.log(pc.dim(`  Config:  .pi/loopi/config.json`));
  console.log(pc.dim(`  Pending: .pi/loopi/workflows/pending/`));
  console.log(pc.dim(`  Approved: .pi/loopi/workflows/approved/`));
  console.log(pc.dim(`  Agents:  ${agentCount} installed globally at ${globalDir}`));
  console.log();
  console.log(pc.cyan("  Run: loopi           — Start improvement cycle"));
  console.log(pc.cyan("  Run: loopi dashboard  — Open TUI dashboard"));
  console.log();
}
