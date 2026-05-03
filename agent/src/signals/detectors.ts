import { readFileSync, existsSync, statSync } from "fs";
import { globby } from "globby";
import { resolve, extname } from "path";
import type { Signal } from "../types/index.js";
import { getConfig } from "../actions/config.js";
import { getGit, hasUncommittedChanges, getModifiedFiles, getLastModifiedDate } from "../actions/git.js";
import { logger } from "../actions/logger.js";

export async function detectGitModifiedSignals(): Promise<Signal[]> {
  if (!getConfig().signals.enabled.gitModified) return [];

  try {
    if (!(await hasUncommittedChanges())) return [];
    const files = await getModifiedFiles();
    return files.map((file) => ({
      type: "git.modified" as const,
      severity: "medium" as const,
      file,
      message: `Modified file detected: ${file}`,
      timestamp: Date.now(),
    }));
  } catch (err) {
    logger.debug("Git modified detection skipped (not a git repo?)");
    return [];
  }
}

export async function detectGitUntrackedSignals(): Promise<Signal[]> {
  if (!getConfig().signals.enabled.gitUntracked) return [];

  try {
    const git = getGit();
    const status = await git.status();
    const untracked = status.not_added ?? [];
    return untracked.map((file) => ({
      type: "git.untracked" as const,
      severity: "low" as const,
      file,
      message: `New untracked file: ${file}`,
      timestamp: Date.now(),
    }));
  } catch {
    return [];
  }
}

export async function detectErrorLogSignals(): Promise<Signal[]> {
  if (!getConfig().signals.enabled.errorLog) return [];

  const logPath = resolve(process.cwd(), getConfig().signals.errorLogPath);
  if (!existsSync(logPath)) return [];

  try {
    const content = readFileSync(logPath, "utf-8").trim();
    if (!content) return [];

    const lines = content.split("\n").filter((l) => l.length > 0);
    const recentErrors = lines.slice(-20); // Last 20 lines

    return [
      {
        type: "runtime.errorLog" as const,
        severity: "high" as const,
        message: `${recentErrors.length} recent error log entries found`,
        timestamp: Date.now(),
        metadata: { recentErrors: recentErrors.join("\n") },
      },
    ];
  } catch {
    return [];
  }
}

export async function detectTodoSignals(): Promise<Signal[]> {
  if (!getConfig().signals.enabled.todoPresent) return [];

  const patterns = getConfig().signals.todoPatterns;
  const srcFiles = await globby(["agent/src/**/*.ts", "agent/index.ts", "src/**/*.ts"], {
    ignore: ["**/node_modules/**", "**/dist/**"],
  });

  const signals: Signal[] = [];
  const regex = new RegExp(`\\b(${patterns.join("|")})\\b`, "g");

  for (const file of srcFiles.slice(0, 100)) {
    try {
      const content = readFileSync(file, "utf-8");
      let match: RegExpExecArray | null;
      let firstMatch = true;
      while ((match = regex.exec(content)) !== null) {
        if (firstMatch) {
          const lineNum = content.slice(0, match.index).split("\n").length;
          signals.push({
            type: "todo.present" as const,
            severity: "medium" as const,
            file,
            message: `${match[1]} found at line ${lineNum}: ${content.slice(match.index, match.index + 80).trim()}`,
            timestamp: Date.now(),
          });
          firstMatch = false;
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return signals;
}

export async function detectLargeFileSignals(): Promise<Signal[]> {
  if (!getConfig().signals.enabled.largeFile) return [];

  const threshold = getConfig().constraints.largeFileLines;
  const srcFiles = await globby(["agent/src/**/*.ts", "agent/index.ts", "src/**/*.ts"], {
    ignore: ["**/node_modules/**", "**/dist/**"],
  });

  const signals: Signal[] = [];
  for (const file of srcFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n").length;
      if (lines > threshold) {
        signals.push({
          type: "large-file" as const,
          severity: lines > threshold * 2 ? "high" : "medium",
          file,
          message: `Large file (${lines} lines, threshold: ${threshold})`,
          timestamp: Date.now(),
          metadata: { lines },
        });
      }
    } catch {
      // skip
    }
  }

  return signals;
}

export async function detectComplexitySignals(): Promise<Signal[]> {
  if (!getConfig().signals.enabled.complexityThreshold) return [];

  const threshold = getConfig().constraints.minComplexityThreshold;
  const srcFiles = await globby(["agent/src/**/*.ts", "agent/index.ts", "src/**/*.ts"], {
    ignore: ["**/node_modules/**", "**/dist/**"],
  });

  const signals: Signal[] = [];
  for (const file of srcFiles.slice(0, 50)) {
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");

      // Simple heuristic: count deeply nested blocks
      let nestingDepth = 0;
      let maxDepth = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const openers = (line.match(/\{/g) || []).length;
        const closers = (line.match(/\}/g) || []).length;
        nestingDepth += openers - closers;
        maxDepth = Math.max(maxDepth, nestingDepth);

        // Check for long functions (simple heuristic)
        if (maxDepth > threshold && signals.length < 5) {
          signals.push({
            type: "complexity.threshold" as const,
            severity: maxDepth > 15 ? "high" : "medium",
            file,
            message: `High nesting depth (${maxDepth}) detected in ${file}`,
            timestamp: Date.now(),
            metadata: { maxDepth, line: i + 1 },
          });
          break;
        }
      }
    } catch {
      // skip
    }
  }

  return signals;
}

export async function detectStaleFileSignals(): Promise<Signal[]> {
  if (!getConfig().signals.enabled.staleFile) return [];

  const daysThreshold = getConfig().constraints.staleFileDays;
  const srcFiles = await globby(["agent/src/**/*.ts", "agent/index.ts", "src/**/*.ts"], {
    ignore: ["**/node_modules/**", "**/dist/**"],
  });

  const now = Date.now();
  const msThreshold = daysThreshold * 24 * 60 * 60 * 1000;
  const signals: Signal[] = [];

  for (const file of srcFiles.slice(0, 100)) {
    try {
      const lastMod = await getLastModifiedDate(file);
      if (lastMod && now - lastMod.getTime() > msThreshold) {
        signals.push({
          type: "stale-file" as const,
          severity: "low",
          file,
          message: `File not modified in ${daysThreshold}+ days: ${file}`,
          timestamp: Date.now(),
          metadata: { lastModified: lastMod.toISOString() },
        });
      }
    } catch {
      // skip
    }
  }

  return signals;
}

export async function detectAllSignals(): Promise<Signal[]> {
  logger.info("Detecting signals...");

  const detectors = [
    detectGitModifiedSignals(),
    detectGitUntrackedSignals(),
    detectErrorLogSignals(),
    detectTodoSignals(),
    detectLargeFileSignals(),
    detectComplexitySignals(),
    detectStaleFileSignals(),
  ];

  const results = await Promise.all(detectors);
  const allSignals = results.flat();

  logger.info(`Found ${allSignals.length} signals`);
  for (const s of allSignals) {
    logger.debug(`  [${s.severity}] ${s.type}: ${s.message}`);
  }

  return allSignals;
}
