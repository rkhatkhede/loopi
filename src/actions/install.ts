import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

/**
 * Install loopi agents to ~/.pi/agent/agents/ for global pi.dev discovery.
 *
 * The agents are bundled in the package at <package_root>/agents/.
 * At runtime, __dirname points to dist/ so we resolve ../agents/.
 */
export function installAgents(): number {
  // Resolve bundled agents directory
  // __dirname = <package>/dist/ or <package>/src/actions/
  // In dev (ts-node): __dirname may be src/actions/
  // In production (compiled): __dirname = dist/actions/ or dist/
  const possibleDirs = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../../agents"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../agents"),
    resolve(process.cwd(), "agents"),
  ];

  let agentsDir: string | null = null;
  for (const dir of possibleDirs) {
    if (existsSync(dir) && readdirSync(dir).some(f => f.endsWith(".md"))) {
      agentsDir = dir;
      break;
    }
  }

  if (!agentsDir) {
    console.error("Cannot find bundled loopi agents directory.");
    console.error("Expected at: agents/ relative to package root.");
    return 0;
  }

  // Destination: ~/.pi/agent/agents/
  const destDir = resolve(homedir(), ".pi/agent/agents");
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const agentFiles = readdirSync(agentsDir).filter(f => f.endsWith(".md"));
  let count = 0;

  for (const file of agentFiles) {
    const src = resolve(agentsDir, file);
    const dest = resolve(destDir, file);
    copyFileSync(src, dest);
    count++;
  }

  return count;
}
