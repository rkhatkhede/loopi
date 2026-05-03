import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { resolve } from "path";
import type { Patch } from "../types/index.js";
import { logger } from "./logger.js";

const PENDING_DIR = resolve(process.cwd(), "agent/workflows/pending");
const APPROVED_DIR = resolve(process.cwd(), "agent/workflows/approved");

function ensureDirs(): void {
  for (const dir of [PENDING_DIR, APPROVED_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function writePendingPR(patch: Patch): string {
  ensureDirs();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}-${patch.id.slice(0, 8)}.diff`;
  const filepath = resolve(PENDING_DIR, filename);

  const content = [
    `;; piloop patch: ${patch.id}`,
    `;; plan: ${patch.planId}`,
    `;; files: ${patch.files.join(", ")}`,
    `;; size: ${patch.size} bytes`,
    `;; generated: ${new Date(patch.timestamp).toISOString()}`,
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

  const srcPath = resolve(PENDING_DIR, match);
  const destPath = resolve(APPROVED_DIR, match);

  try {
    const data = readFileSync(srcPath, "utf-8");
    writeFileSync(destPath, data, "utf-8");
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
    return readdirSync(PENDING_DIR).filter((f) => f.endsWith(".diff"));
  } catch {
    return [];
  }
}

export function listApproved(): string[] {
  ensureDirs();
  try {
    return readdirSync(APPROVED_DIR).filter((f: string) => f.endsWith(".diff"));
  } catch {
    return [];
  }
}

export function readDiffFile(filename: string): { content: string; metadata: Record<string, string> } | null {
  const dir = filename.includes("approved") ? APPROVED_DIR : PENDING_DIR;
  const filepath = existsSync(resolve(dir, filename))
    ? resolve(dir, filename)
    : existsSync(resolve(PENDING_DIR, filename))
      ? resolve(PENDING_DIR, filename)
      : existsSync(resolve(APPROVED_DIR, filename))
        ? resolve(APPROVED_DIR, filename)
        : null;

  if (!filepath) return null;

  const content = readFileSync(filepath, "utf-8");
  const metadata: Record<string, string> = {};

  for (const line of content.split("\n")) {
    if (line.startsWith(";; ")) {
      const [key, ...rest] = line.slice(3).split(": ");
      if (key) metadata[key.trim()] = rest.join(": ").trim();
    } else if (line.startsWith("---") || line.startsWith("diff")) {
      break;
    }
  }

  // Strip metadata lines to get pure diff
  const diffLines = content.split("\n").filter((l) => !l.startsWith(";; "));
  return { content: diffLines.join("\n").trim(), metadata };
}
