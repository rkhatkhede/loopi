import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { analyzeFile } from "../src/analyzers/analyzer.js";
import { planImprovement } from "../src/planners/planner.js";
import { generateDiffString, generatePatch } from "../src/workers/patch-generator.js";
import { reviewPatchLocally } from "../src/reviewers/reviewer.js";
import { loadConfig, getConfig } from "../src/actions/config.js";
import type { AnalysisReport, Signal, Patch, ImprovementPlan } from "../src/types/index.js";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// Helper to create a temp dir for test files
function createTempFile(content: string, ext = ".ts"): string {
  const dir = resolve(tmpdir(), "piloop-test", randomUUID());
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `test${ext}`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("Config", () => {
  it("should load config from default path", () => {
    const config = loadConfig(resolve(process.cwd(), "agent/agent.config.json"));
    expect(config.projectName).toBe("piloop");
    expect(config.constraints.maxFilesPerPatch).toBe(3);
    expect(config.constraints.allowedOperations).toContain("refactor");
  });
});

describe("Analyzer", () => {
  it("should detect TODO comments", () => {
    const file = createTempFile(`
      // TODO: implement this
      const x = 1;
      // FIXME: this is broken
      const y = 2;
    `);

    const result = analyzeFile(file);
    expect(result.todos).toHaveLength(2);
    expect(result.todos[0]?.pattern).toBe("TODO");
    expect(result.todos[1]?.pattern).toBe("FIXME");
  });

  it("should detect long lines", () => {
    const file = createTempFile(`
      const shortLine = 1;
      ${"a".repeat(200)}
    `);

    const result = analyzeFile(file);
    const longLineSmells = result.smells.filter((s) => s.type === "long-line");
    expect(longLineSmells.length).toBeGreaterThan(0);
  });

  it("should detect excessive any usage", () => {
    const file = createTempFile(`
      function foo(a: any, b: any, c: any, d: any, e: any, f: any): void {
        return;
      }
    `);

    const result = analyzeFile(file);
    const anyErrors = result.errors.filter((e) => e.pattern === "excessive-any");
    expect(anyErrors.length).toBeGreaterThan(0);
  });

  it("should analyze codebase and produce report", async () => {
    const file = createTempFile(`const x: number = 1;`);
    const { analyzeCodebase } = await import("../src/analyzers/analyzer.js");

    const result = analyzeFile(file);
    expect(typeof result.lines).toBe("number");
    expect(result.smells).toBeDefined();
    expect(result.todos).toBeDefined();
  });
});

describe("Planner", () => {
  it("should plan improvements from analysis with complex functions", () => {
    const analysis: AnalysisReport = {
      timestamp: Date.now(),
      signals: [],
      filesAnalyzed: ["test.ts"],
      smells: [],
      todos: [],
      complexity: [
        {
          file: "test.ts",
          functionName: "complexFn",
          line: 1,
          complexity: 25,
          risk: "high",
        },
      ],
      errors: [],
      healthScore: 50,
      summary: "Test analysis",
    };

    const plan = planImprovement(analysis);
    expect(plan.operation).toBe("refactor");
    expect(plan.risk).toBe("low");
    expect(plan.affectedFiles).toContain("test.ts");
    expect(plan.summary).toContain("complexFn");
  });

  it("should throw on empty analysis", () => {
    const analysis: AnalysisReport = {
      timestamp: Date.now(),
      signals: [],
      filesAnalyzed: [],
      smells: [],
      todos: [],
      complexity: [],
      errors: [],
      healthScore: 100,
      summary: "Clean analysis",
    };

    expect(() => planImprovement(analysis)).toThrow("No actionable improvements");
  });
});

describe("Patch Generator", () => {
  it("should generate diff string for changed content", () => {
    const file = createTempFile("line1\nline2\nline3\nline4\nline5\n");
    const newContent = "line1\nline2\nmodified\nline4\nline5\n";

    const diff = generateDiffString(file, newContent);
    expect(diff).toContain("--- a");
    expect(diff).toContain("+++ b");
    expect(diff).toContain("@@");
    expect(diff).toContain("-line3");
    expect(diff).toContain("+modified");
  });
});

describe("Reviewer", () => {
  it("should approve clean patches", () => {
    const patch: Patch = {
      id: "test-123",
      planId: "plan-123",
      diff: "--- a/test.ts\n+++ b/test.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      timestamp: Date.now(),
      files: ["test.ts"],
      size: 100,
      status: "pending",
    };

    const plan: ImprovementPlan = {
      id: "plan-123",
      timestamp: Date.now(),
      summary: "Test improvement",
      rationale: "Testing",
      affectedFiles: ["test.ts"],
      expectedPatchSize: 50,
      requiredTests: [],
      risk: "low",
      operation: "fix",
      details: "A test",
    };

    const result = reviewPatchLocally(patch, plan);
    expect(result.approved).toBe(true);
    expect(result.risk).toBe("low");
  });

  it("should reject patches touching forbidden directories", () => {
    const patch: Patch = {
      id: "test-456",
      planId: "plan-456",
      diff: "--- a/node_modules/pkg/index.ts\n+++ b/node_modules/pkg/index.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      timestamp: Date.now(),
      files: ["node_modules/pkg/index.ts"],
      size: 50,
      status: "pending",
    };

    const plan: ImprovementPlan = {
      id: "plan-456",
      timestamp: Date.now(),
      summary: "Bad patch",
      rationale: "Should be rejected",
      affectedFiles: ["node_modules/pkg/index.ts"],
      expectedPatchSize: 50,
      requiredTests: [],
      risk: "high",
      operation: "fix",
      details: "Bad",
    };

    const result = reviewPatchLocally(patch, plan);
    expect(result.approved).toBe(false);
    expect(result.risk).toBe("high");
  });
});
