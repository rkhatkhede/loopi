import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { loadConfig } from "./config.js";

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

  // Config
  const configFile = resolve(cwd, ".pi/loopi/config.json");
  const hasConfig = existsSync(configFile);
  console.log(`  Config: ${hasConfig ? "✓ loaded from .pi/loopi/config.json" : "✓ defaults (no config file)"}`);
  console.log(`  Project: ${config.projectName}`);
  console.log(`  Run frequency: every ${config.runFrequencyMinutes} min`);

  // Workflow counts
  const pendingDir = resolve(cwd, ".pi/loopi/workflows/pending");
  const approvedDir = resolve(cwd, ".pi/loopi/workflows/approved");

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
  const logDir = resolve(cwd, ".pi/loopi/logs");
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

  // Agent definitions (global first, fallback to local)
  const globalAgentsDir = resolve(homedir(), ".pi/agent/agents");
  const localAgentsDir = resolve(cwd, ".pi/agents");

  if (existsSync(globalAgentsDir)) {
    const agents = readdirSync(globalAgentsDir).filter((f) => f.endsWith(".md"));
    console.log(`\n  ─── Global Agents (global install) ───`);
    for (const agent of agents) {
      const content = readFileSync(resolve(globalAgentsDir, agent), "utf-8");
      const desc = content.match(/description: (.+)/)?.[1] ?? "";
      console.log(`  • ${agent.replace(".md", "")}: ${desc}`);
    }
  }

  if (existsSync(localAgentsDir)) {
    const agents = readdirSync(localAgentsDir).filter((f) => f.endsWith(".md"));
    console.log(`\n  ─── Project Agents (.pi/agents/) ───`);
    for (const agent of agents) {
      const content = readFileSync(resolve(localAgentsDir, agent), "utf-8");
      const desc = content.match(/description: (.+)/)?.[1] ?? "";
      console.log(`  • ${agent.replace(".md", "")}: ${desc}`);
    }
  }

  console.log();
}
