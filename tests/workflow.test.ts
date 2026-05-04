/**
 * Tests for git workflow and pipeline orchestration functions.
 *
 * Run with: pnpm test
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import simpleGitPkg from "simple-git";
import type { SimpleGitFactory } from "simple-git";

const simpleGit: SimpleGitFactory = (simpleGitPkg as unknown as SimpleGitFactory);

// ─── Git helpers ─────────────────────────────────

/**
 * Create a temporary git repo with an initial commit on main.
 * Returns the repo directory path.
 */
async function createGitRepo(): Promise<string> {
  const dir = resolve(tmpdir(), "loopi-test-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "test");
  await git.addConfig("user.email", "test@test.com");
  writeFileSync(resolve(dir, "README.md"), "# Test Repo\n", "utf-8");
  await git.add(".");
  await git.commit("Initial commit");
  return dir;
}

function destroyRepo(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ok */
  }
}

/**
 * Import a fresh instance of the git module (clears module cache).
 */
async function freshGitModule() {
  vi.resetModules();
  const mod = await import("../src/actions/git.js");
  mod.resetGit();
  return mod;
}

/**
 * Import a fresh instance of the pipeline module.
 */
async function freshPipelineModule() {
  vi.resetModules();
  return await import("../src/pipeline.js");
}

// ─── Tests ──────────────────────────────────────

describe("git.ts — getGit / resetGit", () => {
  let repoDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    destroyRepo(repoDir);
  });

  it("getGit returns a SimpleGit instance", async () => {
    repoDir = await createGitRepo();
    process.chdir(repoDir);
    const gitModule = await freshGitModule();
    const git = gitModule.getGit();
    expect(git).toBeDefined();
    const branch = await gitModule.getCurrentBranch();
    expect(branch).toBe("main");
  });

  it("getCurrentBranch returns correct branch name", async () => {
    repoDir = await createGitRepo();
    process.chdir(repoDir);
    const gitModule = await freshGitModule();
    const branch = await gitModule.getCurrentBranch();
    expect(branch).toBe("main");
  });

  it("hasUncommittedChanges returns false for clean repo", async () => {
    repoDir = await createGitRepo();
    process.chdir(repoDir);
    const gitModule = await freshGitModule();
    const dirty = await gitModule.hasUncommittedChanges();
    expect(dirty).toBe(false);
  });

  it("hasUncommittedChanges returns true for dirty repo", async () => {
    repoDir = await createGitRepo();
    process.chdir(repoDir);
    const gitModule = await freshGitModule();
    writeFileSync(resolve(repoDir, "new-file.txt"), "hello", "utf-8");
    const dirty = await gitModule.hasUncommittedChanges();
    expect(dirty).toBe(true);
  });

  it("checkoutBranch switches branches", async () => {
    repoDir = await createGitRepo();
    process.chdir(repoDir);
    const gitModule = await freshGitModule();
    const git = simpleGit(repoDir);
    await git.checkoutLocalBranch("dev");
    await git.checkout("main");
    await gitModule.checkoutBranch("dev");
    expect(await gitModule.getCurrentBranch()).toBe("dev");
  });

  it("createBranch creates and switches to new branch", async () => {
    repoDir = await createGitRepo();
    process.chdir(repoDir);
    const gitModule = await freshGitModule();
    await gitModule.createBranch("feature/test");
    expect(await gitModule.getCurrentBranch()).toBe("feature/test");
  });
});

describe("git.ts — createCommit / getModifiedFiles", () => {
  let repoDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    destroyRepo(repoDir);
  });

  it("createCommit commits staged and unstaged changes", async () => {
    repoDir = await createGitRepo();
    process.chdir(repoDir);
    const gitModule = await freshGitModule();
    writeFileSync(resolve(repoDir, "new-file.txt"), "new content", "utf-8");
    await gitModule.createCommit("test commit");
    const git = simpleGit(repoDir);
    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toContain("test commit");
  });

  it("getModifiedFiles returns changed files", async () => {
    repoDir = await createGitRepo();
    process.chdir(repoDir);
    const gitModule = await freshGitModule();
    writeFileSync(resolve(repoDir, "another.txt"), "content", "utf-8");
    const modified = await gitModule.getModifiedFiles();
    expect(modified.length).toBeGreaterThan(0);
  });
});

describe("pipeline.ts — acquireLock / releaseLock", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = resolve(tmpdir(), "loopi-lock-test-" + Math.random().toString(36).slice(2));
    mkdirSync(resolve(tmpDir, ".pi/loopi"), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ok */ }
  });

  it("acquireLock creates lock file with PID", async () => {
    const pipeline = await freshPipelineModule();
    pipeline.acquireLock();
    const lockPath = resolve(tmpDir, ".pi/loopi/.pipeline.lock");
    expect(existsSync(lockPath)).toBe(true);
    const { readFileSync } = await import("fs");
    const pid = readFileSync(lockPath, "utf-8").trim();
    expect(pid).toBe(String(process.pid));
    pipeline.releaseLock();
  });

  it("acquireLock throws if lock already held", async () => {
    const pipeline = await freshPipelineModule();
    pipeline.acquireLock();
    expect(() => pipeline.acquireLock()).toThrow(/Pipeline lock held/);
    pipeline.releaseLock();
  });

  it("releaseLock removes lock file", async () => {
    const pipeline = await freshPipelineModule();
    pipeline.acquireLock();
    pipeline.releaseLock();
    const lockPath = resolve(tmpDir, ".pi/loopi/.pipeline.lock");
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("pipeline.ts — readVision / saveVision (integration)", () => {
  let repoDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repoDir = await createGitRepo();
    mkdirSync(resolve(repoDir, ".pi/loopi"), { recursive: true });
    writeFileSync(resolve(repoDir, ".pi/loopi/config.json"), JSON.stringify({
      projectName: "test",
    }));
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(resolve(repoDir, ".pi"), { recursive: true, force: true });
    } catch { /* ok */ }
    destroyRepo(repoDir);
  });

  it("readVision returns null when no file exists", async () => {
    const pipeline = await freshPipelineModule();
    expect(pipeline.readVision()).toBeNull();
  });

  it("saveVision + readVision roundtrip", async () => {
    const pipeline = await freshPipelineModule();
    const vision = {
      version: 1,
      projectDescription: "My project",
      businessGoals: ["goal 1"],
      technicalPriorities: [],
      userPersonas: [],
      constraints: [],
    };
    pipeline.saveVision(vision);
    const loaded = pipeline.readVision();
    expect(loaded).not.toBeNull();
    expect(loaded!.projectDescription).toBe("My project");
  });
});

describe("pipeline.ts — opportunity history (integration)", () => {
  let repoDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repoDir = await createGitRepo();
    mkdirSync(resolve(repoDir, ".pi/loopi"), { recursive: true });
    writeFileSync(resolve(repoDir, ".pi/loopi/config.json"), JSON.stringify({
      projectName: "test",
    }));
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(resolve(repoDir, ".pi"), { recursive: true, force: true });
    } catch { /* ok */ }
    destroyRepo(repoDir);
  });

  it("readOpportunityHistory returns empty array when no file", async () => {
    const pipeline = await freshPipelineModule();
    expect(pipeline.readOpportunityHistory()).toEqual([]);
  });

  it("saveOpportunity + readOpportunityHistory roundtrip", async () => {
    const pipeline = await freshPipelineModule();
    const opp = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: Date.now(),
      title: "Test opportunity",
      description: "Description",
      category: "feature" as const,
      estimatedValue: "medium" as const,
      estimatedEffort: "small" as const,
      affectedAreas: ["src/"],
      status: "suggested" as const,
    };
    pipeline.saveOpportunity(opp);
    const history = pipeline.readOpportunityHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.title).toBe("Test opportunity");
  });

  it("saveOpportunity updates existing entry", async () => {
    const pipeline = await freshPipelineModule();
    const id = "550e8400-e29b-41d4-a716-446655440000";
    pipeline.saveOpportunity({
      id,
      createdAt: Date.now(),
      title: "Original",
      description: "desc",
      category: "feature",
      estimatedValue: "medium",
      estimatedEffort: "small",
      affectedAreas: [],
      status: "suggested",
    });
    pipeline.saveOpportunity({
      id,
      createdAt: Date.now(),
      title: "Updated",
      description: "desc",
      category: "feature",
      estimatedValue: "high",
      estimatedEffort: "small",
      affectedAreas: [],
      status: "accepted",
    });
    const history = pipeline.readOpportunityHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.title).toBe("Updated");
    expect(history[0]!.status).toBe("accepted");
  });
});

describe("pipeline.ts — rejectPending", () => {
  let repoDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repoDir = await createGitRepo();
    mkdirSync(resolve(repoDir, ".pi/loopi/workflows/pending"), { recursive: true });
    mkdirSync(resolve(repoDir, ".pi/loopi/workflows/approved"), { recursive: true });
    writeFileSync(resolve(repoDir, ".pi/loopi/config.json"), JSON.stringify({
      projectName: "test",
    }));
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(resolve(repoDir, ".pi"), { recursive: true, force: true });
    } catch { /* ok */ }
    destroyRepo(repoDir);
  });

  it("rejectPending removes the latest pending diff", async () => {
    const pipeline = await freshPipelineModule();
    const { writePendingPR, setPrDirs } = await import("../src/actions/pr.js");
    const pendingDir = resolve(repoDir, ".pi/loopi/workflows/pending");
    const approvedDir = resolve(repoDir, ".pi/loopi/workflows/approved");
    setPrDirs(pendingDir, approvedDir);

    writePendingPR({
      id: "test-reject",
      diff: "--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n",
      files: ["test.ts"],
      size: 50,
      status: "pending",
    });

    expect(pipeline.getLatestPending()).not.toBeNull();
    const result = await pipeline.rejectPending();
    expect(result).toBe(true);
    expect(pipeline.getLatestPending()).toBeNull();
  });

  it("rejectPending returns false when no pending diffs", async () => {
    const pipeline = await freshPipelineModule();
    const result = await pipeline.rejectPending();
    expect(result).toBe(false);
  });
});
