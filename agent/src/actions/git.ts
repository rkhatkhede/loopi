import simpleGit from "simple-git";
import type { SimpleGit } from "simple-git";
import { existsSync } from "fs";
import { resolve } from "path";
import { logger } from "./logger.js";

let _git: SimpleGit | null = null;

export function getGit(): SimpleGit {
  if (!_git) {
    const cwd = process.cwd();
    if (!existsSync(resolve(cwd, ".git"))) {
      throw new Error("Not a git repository. Run `git init` first.");
    }
    _git = simpleGit(cwd);
  }
  return _git;
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
