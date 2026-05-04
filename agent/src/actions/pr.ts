import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { Patch } from "../types/index.js";
import { logger } from "./logger.js";

let _pendingDir = resolve(process.cwd(), "agent/workflows/pending");
let _approvedDir = resolve(process.cwd(), "agent/workflows/approved");

/** Override directories for testing */
export function setPrDirs(pending: string, approved: string): void {
  _pendingDir = pending;
  _approvedDir = approved;
}

function ensureDirs(): void {
  for (const dir of [_pendingDir, _approvedDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function writePendingPR(patch: Patch): string {
  ensureDirs();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}-${patch.id.slice(0, 8)}.diff`;
  const filepath = resolve(_pendingDir, filename);

  const content = [
    `;; loopi patch: ${patch.id}`,
    `;; plan: ${patch.planId ?? "unknown"}`,
    `;; files: ${patch.files.join(", ")}`,
    `;; size: ${patch.size} bytes`,
    `;; generated: ${new Date().toISOString()}`,
    "",
    patch.diff,
  ].join("\n");

  writeFileSync(filepath, content, "utf-8");
  logger.info(`Wrote pending PR: ${filepath}`);
  return filepath;
}

export function moveToApproved(patchId: string): boolean {
  ensureDirs();
  const files = listPending();
  const match = files.find((f) => f.includes(patchId.slice(0, 8)));
  if (!match) {
    logger.error(`Patch not found in pending: ${patchId}`);
    return false;
  }

  const srcPath = resolve(_pendingDir, match);
  const destPath = resolve(_approvedDir, match);

  try {
    const data = readFileSync(srcPath, "utf-8");
    writeFileSync(destPath, data, "utf-8");
    unlinkSync(srcPath); // Remove from pending — it's now approved
    logger.info(`Moved to approved: ${match}`);
    return true;
  } catch (err) {
    logger.error(`Failed to move patch: ${err}`);
    return false;
  }
}

export function listPending(): string[] {
  ensureDirs();
  try {
    return readdirSync(_pendingDir).filter((f) => f.endsWith(".diff"));
  } catch {
    return [];
  }
}

export function listApproved(): string[] {
  ensureDirs();
  try {
    return readdirSync(_approvedDir).filter((f: string) => f.endsWith(".diff"));
  } catch {
    return [];
  }
}

export function readDiffFile(filename: string): { content: string; metadata: Record<string, string> } | null {
  const filepath = existsSync(resolve(_approvedDir, filename))
    ? resolve(_approvedDir, filename)
    : existsSync(resolve(_pendingDir, filename))
      ? resolve(_pendingDir, filename)
      : existsSync(resolve(_approvedDir, filename))
        ? resolve(_approvedDir, filename)
        : null;

  if (!filepath) return null;

  const content = readFileSync(filepath, "utf-8").replace(/\r/g, "");
  const metadata: Record<string, string> = {};

  for (const line of content.split("\n")) {
    if (line.startsWith(";; ")) {
      const [key, ...rest] = line.slice(3).split(": ");
      if (key) metadata[key.trim()] = rest.join(": ").trim();
    } else if (line.startsWith("---") || line.startsWith("diff")) {
      break;
    }
  }

  // Strip metadata lines to get pure diff, trim only leading whitespace
  const diffLines = content.split("\n").filter((l) => !l.startsWith(";; "));
  const rawContent = diffLines.join("\n");
  // Trim leading newlines/whitespace but preserve trailing newline
  const trimmed = rawContent.replace(/^\s+/, "");
  // Ensure diff ends with a newline (git apply requires it)
  const finalContent = trimmed.endsWith("\n") ? trimmed : trimmed + "\n";
  return { content: finalContent, metadata };
}
