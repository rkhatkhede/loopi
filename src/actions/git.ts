import simpleGitPkg from "simple-git";
import type { SimpleGit, SimpleGitFactory } from "simple-git";

// simple-git is CJS-only; this double-cast bridges ESM import to CJS default export.
// Once simple-git ships native ESM, replace with: import simpleGit from "simple-git";
const simpleGit: SimpleGitFactory = (simpleGitPkg as unknown as SimpleGitFactory);
import { existsSync } from "fs";
import { resolve } from "path";
import { logger } from "./logger.js";

let _git: SimpleGit | null = null;
let _gitCwd: string | null = null;

export function getGit(cwd?: string): SimpleGit {
  const dir = cwd ?? process.cwd();
  if (!_git || _gitCwd !== dir) {
    if (!existsSync(resolve(dir, ".git"))) {
      throw new Error("Not a git repository. Run `git init` first.");
    }
    _git = simpleGit(dir);
    _gitCwd = dir;
  }
  return _git;
}

/** Reset the cached git instance (e.g. after cwd change) */
export function resetGit(): void {
  _git = null;
  _gitCwd = null;
}

export async function getCurrentBranch(): Promise<string> {
  const git = getGit();
  const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
  return branch.trim();
}

export async function checkoutBranch(branchName: string): Promise<void> {
  const git = getGit();
  await git.checkout(branchName);
  logger.info(`Switched to branch: ${branchName}`);
}

export async function ensureBranch(branchName: string): Promise<void> {
  const git = getGit();
  const branches = await git.branchLocal();
  if (branches.all.includes(branchName)) {
    await git.checkout(branchName);
    logger.info(`Checked out existing branch: ${branchName}`);
  } else {
    await git.checkoutLocalBranch(branchName);
    logger.info(`Created and switched to branch: ${branchName}`);
  }
}

export async function mergeBranch(sourceBranch: string, message?: string): Promise<void> {
  const git = getGit();
  const target = await getCurrentBranch();
  const msg = message ?? `Merge ${sourceBranch} into ${target}`;
  await git.raw(["merge", "--no-ff", "-m", msg, sourceBranch]);
  logger.info(`Merged ${sourceBranch} → ${target}`);
}

export async function deleteBranch(branchName: string): Promise<void> {
  const git = getGit();
  await git.branch(["-d", branchName]);
  logger.info(`Deleted branch: ${branchName}`);
}

export async function getModifiedFiles(): Promise<string[]> {
  const git = getGit();
  const status = await git.status();
  return [...status.modified, ...status.not_added];
}

export async function getStagedDiff(): Promise<string | null> {
  const git = getGit();
  try {
    const diff = await git.diff(["HEAD"]);
    return diff || null;
  } catch {
    return null;
  }
}

export async function hasUncommittedChanges(): Promise<boolean> {
  const git = getGit();
  const status = await git.status();
  return status.files.length > 0;
}

export async function createCommit(message: string): Promise<void> {
  const git = getGit();
  await git.add(".");
  await git.commit(message);
  logger.info(`Committed: ${message}`);
}

export async function createBranch(branchName: string): Promise<void> {
  const git = getGit();
  await git.checkoutLocalBranch(branchName);
  logger.info(`Created branch: ${branchName}`);
}

export async function pushBranch(branchName: string): Promise<void> {
  const git = getGit();
  await git.push("origin", branchName);
  logger.info(`Pushed branch: ${branchName}`);
}

export async function applyDiff(diffPath: string): Promise<void> {
  const git = getGit();
  await git.raw(["apply", diffPath]);
  logger.info(`Applied diff: ${diffPath}`);
}

export async function getFileHistory(filePath: string, maxCount = 10): Promise<string[]> {
  const git = getGit();
  try {
    const log = await git.log({ file: filePath, maxCount });
    return log.all.map((entry) => `${entry.date}: ${entry.message}`);
  } catch {
    return [];
  }
}

export async function getLastModifiedDate(filePath: string): Promise<Date | null> {
  const git = getGit();
  try {
    const log = await git.log({ file: filePath, maxCount: 1 });
    const entry = log.all[0];
    return entry ? new Date(entry.date) : null;
  } catch {
    return null;
  }
}
