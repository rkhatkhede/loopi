#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { loadConfig } from "../actions/config.js";

export function showStatus() {
  const config = loadConfig();
  const cwd = process.cwd();

  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   loopi — Agent Status             ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  // Repository info
  const gitDir = resolve(cwd, ".git");
  const hasGit = existsSync(gitDir);
  console.log(`  Repository: ${hasGit ? "✓ git initialized" : "✗ no git"}`);

  // Config (now uses the typed Zod-validated config)
  console.log(`  Config: ✓ loaded`);
  console.log(`  Project: ${config.projectName}`);
  console.log(`  Run frequency: every ${config.runFrequencyMinutes} min`);
  if (config.targetRepo?.path) {
    console.log(`  Target repo: ${config.targetRepo.path}`);
  }

  // Workflow counts
  const pendingDir = resolve(cwd, "agent/workflows/pending");
  const approvedDir = resolve(cwd, "agent/workflows/approved");

  let pendingCount = 0;
  let approvedCount = 0;

  if (existsSync(pendingDir)) {
    pendingCount = readdirSync(pendingDir).filter((f) => f.endsWith(".diff")).length;
  }
  if (existsSync(approvedDir)) {
    approvedCount = readdirSync(approvedDir).filter((f) => f.endsWith(".diff")).length;
  }

  console.log(`\n  ─── Workflows ───`);
  console.log(`  Pending:  ${pendingCount} diff(s)`);
  console.log(`  Approved: ${approvedCount} diff(s)`);

  // Logs
  const logDir = resolve(cwd, "agent/logs");
  if (existsSync(logDir)) {
    const logs = readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse();
    console.log(`\n  ─── Logs ───`);
    console.log(`  Log files: ${logs.length}`);
    if (logs.length > 0) {
      const latestLog = resolve(logDir, logs[0]!);
      const logContent = readFileSync(latestLog, "utf-8").trim();
      const lastLines = logContent.split("\n").slice(-3);
      console.log(`  Latest log: ${logs[0]}`);
      for (const line of lastLines) {
        console.log(`    ${line.slice(0, 100)}`);
      }
    }
  }

  // Agent definitions
  const agentsDir = resolve(cwd, ".pi/agents");
  if (existsSync(agentsDir)) {
    const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    console.log(`\n  ─── pi.dev Agents ───`);
    for (const agent of agents) {
      const content = readFileSync(resolve(agentsDir, agent), "utf-8");
      const desc = content.match(/description: (.+)/)?.[1] ?? "";
      console.log(`  • ${agent.replace(".md", "")}: ${desc}`);
    }
  }

  // Source count
  const totalFiles = readdirRecursive(resolve(cwd, "agent"), ".ts");
  console.log(`\n  ─── Source ───`);
  console.log(`  TypeScript files: ${totalFiles}`);

  console.log();
}

function readdirRecursive(dir: string, ext: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        count += readdirRecursive(full, ext);
      } else if (entry.endsWith(ext)) {
        count++;
      }
    }
  } catch {
    // skip
  }
  return count;
}

// Allow direct CLI execution
const isMainModule = process.argv[1]?.endsWith("status.ts") || process.argv[1]?.endsWith("status.js");
if (isMainModule) {
  showStatus();
}
