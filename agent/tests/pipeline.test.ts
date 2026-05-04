/**
 * Tests for the critical loopi utility functions.
 *
 * Run with: pnpm test
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

import type { VisionDocument, Opportunity, Patch } from "../src/types/index.js";

function makeVision(overrides: Partial<VisionDocument> = {}): VisionDocument {
  return {
    version: 1,
    projectDescription: "A test project",
    businessGoals: ["test goal"],
    technicalPriorities: [],
    userPersonas: [],
    constraints: [],
    ...overrides,
  };
}

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    createdAt: Date.now(),
    title: "Test opportunity",
    description: "A test opportunity description",
    category: "feature",
    estimatedValue: "medium",
    estimatedEffort: "small",
    affectedAreas: ["src/"],
    status: "suggested",
    ...overrides,
  };
}

const AGENT_CFG = {
  projectName: "test-project",
  runFrequencyMinutes: 30,
};

function withTestDir(fn: (dir: string) => void) {
  const tmp = resolve(tmpdir(), "loopi-" + Math.random().toString(36).slice(2));
  const agentDir = resolve(tmp, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(resolve(agentDir, "agent.config.json"), JSON.stringify(AGENT_CFG), "utf-8");
  fn(tmp);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// ─── Tests ───

describe("parseAgentOutput", () => {
  let pipeline: typeof import("../src/pipeline.js");
  let z: typeof import("zod/v3");

  beforeEach(async () => {
    vi.resetModules();
    pipeline = await import("../src/pipeline.js");
    z = await import("zod/v3");
  });

  it("extracts JSON from fenced block", () => {
    const output = `Analysis:

\`\`\`json
{
  "type": "analysis",
  "data": { "summary": "test", "findings": [], "smells": [], "healthScore": 50, "recommendations": [], "criticalBlockers": [] }
}
\`\`\`

Done.`;
    const result = pipeline.parseAgentData(
      output,
      z.object({
        summary: z.string(),
        findings: z.array(z.string()),
        smells: z.array(z.any()),
        healthScore: z.number(),
        recommendations: z.array(z.string()),
        criticalBlockers: z.array(z.string()),
      }),
      "analysis"
    );
    expect(result.summary).toBe("test");
    expect(result.healthScore).toBe(50);
  });

  it("parses plain JSON output without fences", () => {
    const output = JSON.stringify({
      type: "vision",
      data: makeVision({ projectDescription: "A test project", northStar: "Test north star" }),
    });
    const result = pipeline.parseAgentData(
      output,
      z.object({
        projectDescription: z.string(),
        businessGoals: z.array(z.string()),
        northStar: z.string().optional(),
      }),
      "vision"
    );
    expect(result.projectDescription).toBe("A test project");
    expect(result.northStar).toBe("Test north star");
  });

  it("throws on invalid schema", () => {
    const output = "```json\n{ \"type\": \"test\", \"data\": { \"name\": \"hello\" } }\n```";
    expect(() =>
      pipeline.parseAgentData(output, z.object({ requiredField: z.string() }), "test")
    ).toThrow();
  });

  it("throws on no JSON found", () => {
    expect(() =>
      pipeline.parseAgentOutput("This is just plain text with no JSON", z.any())
    ).toThrow(/no valid JSON/);
  });
});

describe("readVision / saveVision", () => {
  let pipeline: typeof import("../src/pipeline.js");
  let originalCwd: string;
  let tmp: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = resolve(tmpdir(), "loopi-vision-" + Math.random().toString(36).slice(2));
    mkdirSync(resolve(tmp, "agent"), { recursive: true });
    writeFileSync(resolve(tmp, "agent/agent.config.json"), JSON.stringify(AGENT_CFG), "utf-8");
    process.chdir(tmp);
    vi.resetModules();
    pipeline = await import("../src/pipeline.js");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("returns null when no vision file exists", () => {
    expect(pipeline.readVision()).toBeNull();
  });

  it("saves and reads back a vision document", () => {
    pipeline.saveVision(makeVision({ projectDescription: "My test project", northStar: "Be the best" }));
    const loaded = pipeline.readVision();
    expect(loaded).not.toBeNull();
    expect(loaded!.projectDescription).toBe("My test project");
    expect(loaded!.northStar).toBe("Be the best");
  });

  it("overwrites existing vision on save", () => {
    pipeline.saveVision(makeVision({ projectDescription: "v1", version: 1 }));
    pipeline.saveVision(makeVision({ projectDescription: "v2", version: 2 }));
    expect(pipeline.readVision()!.projectDescription).toBe("v2");
  });
});

describe("opportunity history", () => {
  let pipeline: typeof import("../src/pipeline.js");
  let originalCwd: string;
  let tmp: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = resolve(tmpdir(), "loopi-opp-" + Math.random().toString(36).slice(2));
    mkdirSync(resolve(tmp, "agent"), { recursive: true });
    writeFileSync(resolve(tmp, "agent/agent.config.json"), JSON.stringify(AGENT_CFG), "utf-8");
    process.chdir(tmp);
    vi.resetModules();
    pipeline = await import("../src/pipeline.js");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("returns empty array when no history exists", () => {
    expect(pipeline.readOpportunityHistory()).toEqual([]);
  });

  it("saves and reads back opportunities", () => {
    pipeline.saveOpportunity(makeOpportunity({ title: "Add login feature" }));
    expect(pipeline.readOpportunityHistory()).toHaveLength(1);
  });

  it("updates existing opportunity by id", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    pipeline.saveOpportunity(makeOpportunity({ id, title: "Original", status: "suggested" }));
    pipeline.saveOpportunity(makeOpportunity({ id, title: "Updated", status: "accepted" }));
    const history = pipeline.readOpportunityHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.title).toBe("Updated");
  });
});

describe("writePending / getLatestPending", () => {
  let pipeline: typeof import("../src/pipeline.js");
  let originalCwd: string;
  let tmp: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = resolve(tmpdir(), "loopi-pr-" + Math.random().toString(36).slice(2));
    mkdirSync(resolve(tmp, "agent"), { recursive: true });
    writeFileSync(resolve(tmp, "agent/agent.config.json"), JSON.stringify(AGENT_CFG), "utf-8");
    process.chdir(tmp);
    vi.resetModules();
    pipeline = await import("../src/pipeline.js");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("writes a pending diff and retrieves it", () => {
    const patch: Patch = {
      id: "patch-001",
      diff: "--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n",
      files: ["test.ts"],
      size: 50,
      status: "pending",
    };
    pipeline.writePending(patch);
    const filename = pipeline.getLatestPending();
    // Filename format: timestamp-patchIDfirst8chars.diff
    expect(filename).not.toBeNull();
    expect(filename).toContain("patch-00");
  });

  it("returns null when no pending diffs exist", () => {
    expect(pipeline.getLatestPending()).toBeNull();
  });
});

describe("patch-generator", () => {
  let pg: typeof import("../src/workers/patch-generator.js");
  let tmp: string;

  beforeEach(async () => {
    tmp = resolve(tmpdir(), "loopi-diff-" + Math.random().toString(36).slice(2));
    mkdirSync(tmp, { recursive: true });
    vi.resetModules();
    pg = await import("../src/workers/patch-generator.js");
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("generates a valid unified diff for a new file", () => {
    const filePath = resolve(tmp, "new-file.ts");
    const content = "const x = 1;\nconsole.log(x);\n";
    const diff = pg.generateDiffString(filePath, content);
    expect(diff).toContain("---");
    expect(diff).toContain("+++");
    expect(diff).toContain("+const x = 1;");
    expect(diff).toContain("+console.log(x);");
    expect(diff).toMatch(/^---/m);
    expect(diff).toMatch(/^\+\+\+/m);
    expect(diff.endsWith("\n")).toBe(true);
  });

  it("generates a valid unified diff for an existing file", () => {
    const filePath = resolve(tmp, "existing-file.ts");
    writeFileSync(filePath, "const a = 1;\n", "utf-8");
    const diff = pg.generateDiffString(filePath, "const a = 2;\n");
    expect(diff).toContain("-const a = 1;");
    expect(diff).toContain("+const a = 2;");
  });

  it("normalizes CRLF to LF", () => {
    const filePath = resolve(tmp, "crlf-file.ts");
    writeFileSync(filePath, "line1\r\nline2\r\n", "utf-8");
    const diff = pg.generateDiffString(filePath, "line1\nline2\nline3\n");
    expect(diff).toContain("+line3");
    expect(diff).not.toContain("\r");
  });
});
