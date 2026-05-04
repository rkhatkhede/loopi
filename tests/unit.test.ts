/**
 * Tests for config loading, PR workflow, Zod schemas, and parseAgentData.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { loadConfig, getConfig, resetConfig } from "../src/actions/config.js";

// ─── Config Tests ───

describe("config", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = resolve(tmpdir(), "loopi-test-config-" + Math.random().toString(36).slice(2));
    mkdirSync(resolve(tmp, ".pi/loopi"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(resolve(tmp, ".pi"), { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("loads and validates a minimal config", () => {
    resetConfig();
    writeFileSync(
      resolve(tmp, ".pi/loopi/config.json"),
      JSON.stringify({ projectName: "test-project" }),
      "utf-8"
    );
    const config = loadConfig(resolve(tmp, ".pi/loopi/config.json"));
    expect(config.projectName).toBe("test-project");
    expect(config.runFrequencyMinutes).toBe(30);
    expect(config.humanGate.enabled).toBe(true);
    expect(config.constraints.maxFilesPerPatch).toBe(3);
  });

  it("loads and validates a full config", () => {
    resetConfig();
    writeFileSync(
      resolve(tmp, ".pi/loopi/config.json"),
      JSON.stringify({
        projectName: "my-project",
        runFrequencyMinutes: 60,
        humanGate: { enabled: true, requireApproval: true, notificationMethod: "contact_supervisor" },
        constraints: { maxFilesPerPatch: 5, maxPatchSizeLines: 1000, maxPatchSizeBytes: 20480 },
      }),
      "utf-8"
    );
    const config = loadConfig(resolve(tmp, ".pi/loopi/config.json"));
    expect(config.projectName).toBe("my-project");
    expect(config.runFrequencyMinutes).toBe(60);
    expect(config.constraints.maxFilesPerPatch).toBe(5);
  });

  it("throws on invalid config (wrong field type)", () => {
    resetConfig();
    writeFileSync(
      resolve(tmp, ".pi/loopi/config.json"),
      JSON.stringify({ projectName: 123 }),
      "utf-8"
    );
    expect(() => loadConfig(resolve(tmp, ".pi/loopi/config.json"))).toThrow();
  });

  it("getConfig returns cached config after loadConfig", () => {
    resetConfig();
    writeFileSync(
      resolve(tmp, ".pi/loopi/config.json"),
      JSON.stringify({ projectName: "cached-test" }),
      "utf-8"
    );
    const config = loadConfig(resolve(tmp, ".pi/loopi/config.json"));
    expect(config.projectName).toBe("cached-test");
    expect(getConfig().projectName).toBe("cached-test");
  });

  it("returns defaults when no config file exists", () => {
    resetConfig();
    const config = loadConfig(resolve(tmp, ".pi/loopi/nonexistent.json"));
    expect(config.projectName).toBe("loopi");
    expect(config.runFrequencyMinutes).toBe(30);
  });
});

// ─── PR Workflow Tests ───

describe("PR workflow", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = resolve(tmpdir(), "loopi-test-pr-" + Math.random().toString(36).slice(2));
    mkdirSync(resolve(tmp, ".pi/loopi/workflows/pending"), { recursive: true });
    mkdirSync(resolve(tmp, ".pi/loopi/workflows/approved"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(resolve(tmp, ".pi"), { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("writePendingPR creates a file and listPending finds it", async () => {
    const { writePendingPR, listPending, setPrDirs } = await import("../src/actions/pr.js");
    setPrDirs(resolve(tmp, ".pi/loopi/workflows/pending"), resolve(tmp, ".pi/loopi/workflows/approved"));
    const patch = {
      id: "test-roundtrip",
      diff: "--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n",
      files: ["test.ts"],
      size: 50,
      status: "pending" as const,
    };
    writePendingPR(patch);
    const pending = listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]).toContain("test-rou");
  });

  it("moveToApproved moves a file from pending to approved", async () => {
    const { writePendingPR, listPending, listApproved, moveToApproved, setPrDirs } =
      await import("../src/actions/pr.js");
    setPrDirs(resolve(tmp, ".pi/loopi/workflows/pending"), resolve(tmp, ".pi/loopi/workflows/approved"));
    const patch = {
      id: "move-test",
      diff: "--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n",
      files: ["test.ts"],
      size: 50,
      status: "pending" as const,
    };
    writePendingPR(patch);
    expect(listPending().length).toBe(1);
    expect(listApproved().length).toBe(0);
    const ok = moveToApproved("move-test");
    expect(ok).toBe(true);
    expect(listPending().length).toBe(0);
    expect(listApproved().length).toBe(1);
  });

  it("readDiffFile strips metadata and returns clean diff with trailing newline", async () => {
    const { readDiffFile, writePendingPR, setPrDirs } = await import("../src/actions/pr.js");
    setPrDirs(resolve(tmp, ".pi/loopi/workflows/pending"), resolve(tmp, ".pi/loopi/workflows/approved"));
    const patch = {
      id: "read-test",
      diff: "--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n",
      files: ["test.ts"],
      size: 50,
      status: "pending" as const,
    };
    const fpath = writePendingPR(patch);
    const fname = fpath.replace(/\\/g, "/").split("/").pop()!;
    const result = readDiffFile(fname);
    expect(result).not.toBeNull();
    expect(result!.metadata["loopi patch"]).toBe("read-test");
    expect(result!.content).toContain("--- a/test.ts");
    expect(result!.content).not.toContain(";;");
    expect(result!.content.endsWith("\n")).toBe(true);
  });
});

// ─── Zod Schema Tests ───

describe("Zod schemas", () => {
  it("validates a valid VisionSchema", async () => {
    const { VisionSchema } = await import("../src/types/index.js");
    const result = VisionSchema.safeParse({
      projectDescription: "A test project",
      businessGoals: ["test goal"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid VisionSchema (missing businessGoals)", async () => {
    const { VisionSchema } = await import("../src/types/index.js");
    const result = VisionSchema.safeParse({
      projectDescription: "A test project",
    });
    expect(result.success).toBe(false);
  });

  it("validates a valid ReviewResultSchema", async () => {
    const { ReviewResultSchema } = await import("../src/types/index.js");
    const result = ReviewResultSchema.safeParse({
      approved: true,
      risk: "low",
      riskReport: "Safe to apply",
      regressionChecklist: ["Run tests"],
      testImpactSummary: "Minimal",
      recommendation: "Approve",
      reviewer: "reviewer-agent",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it("validates a valid PatchSchema", async () => {
    const { PatchSchema } = await import("../src/types/index.js");
    const result = PatchSchema.safeParse({
      id: "patch-001",
      diff: "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new\n",
      files: ["test.txt"],
      size: 50,
      status: "pending",
    });
    expect(result.success).toBe(true);
  });

  it("validates OpportunitySchema", async () => {
    const { OpportunitySchema } = await import("../src/types/index.js");
    const result = OpportunitySchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: Date.now(),
      title: "Add input validation",
      description: "Add runtime input validation",
      category: "feature",
      estimatedValue: "medium",
      estimatedEffort: "small",
      affectedAreas: ["src/"],
      status: "suggested",
    });
    expect(result.success).toBe(true);
  });
});

// ─── parseAgentData Tests ───

describe("parseAgentData", () => {
  it("handles multi-line JSON in fenced code blocks", async () => {
    const { parseAgentData } = await import("../src/pipeline.js");
    const { VisionSchema } = await import("../src/types/index.js");

    const input = [
      "Here is the vision:",
      "",
      '```json',
      JSON.stringify({
        type: "vision",
        data: {
          projectDescription: "my-app",
          businessGoals: ["release v2", "fix bugs"],
        },
      }, null, 2),
      '```',
    ].join("\n");

    const result = parseAgentData(input, VisionSchema, "vision");
    expect(result.projectDescription).toBe("my-app");
    expect(result.businessGoals).toEqual(["release v2", "fix bugs"]);
  });

  it("handles plain JSON without fenced block", async () => {
    const { parseAgentData } = await import("../src/pipeline.js");
    const { VisionSchema } = await import("../src/types/index.js");

    const input = JSON.stringify({
      type: "vision",
      data: {
        projectDescription: "plain-json",
        businessGoals: ["goal1"],
      },
    });

    const result = parseAgentData(input, VisionSchema, "vision");
    expect(result.projectDescription).toBe("plain-json");
  });

  it("retrieves validated data from agent output", async () => {
    const { parseAgentData } = await import("../src/pipeline.js");
    const { z } = await import("zod/v3");

    const schema = z.object({ name: z.string(), count: z.number() });
    const input = [
      '```json',
      JSON.stringify({
        type: "test",
        data: { name: "test", count: 42 },
      }),
      '```',
    ].join("\n");

    const result = parseAgentData(input, schema, "test");
    expect(result.name).toBe("test");
    expect(result.count).toBe(42);
  });
});
