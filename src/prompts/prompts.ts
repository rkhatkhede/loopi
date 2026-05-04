/**
 * loopi — Prompt Templates
 *
 * Structured prompts for each stage of the autonomous improvement pipeline.
 * Each function compiles context (vision, goals, findings, etc.) into a
 * prompt that a pi.dev agent can process.
 *
 * The pi agent receives these as user messages and uses its tools
 * (bash, read, grep, find, ls, edit, write) to explore the codebase
 * and produce structured JSON output.
 */

import type { VisionDocument, Opportunity, Pattern } from "../types/index.js";

// ─── Helpers ───

function formatMilestones(vision: VisionDocument): string {
  if (!vision.milestones || vision.milestones.length === 0) return "(none defined)";
  return vision.milestones
    .map((m) => `  - ${m.name} [${m.status}]${m.description ? ` — ${m.description}` : ""}`)
    .join("\n");
}

function formatGoals(vision: VisionDocument): string {
  const goals = [...vision.businessGoals];
  if (vision.technicalPriorities?.length) {
    goals.push(...vision.technicalPriorities.map((t) => `[tech] ${t}`));
  }
  return goals.map((g) => `  - ${g}`).join("\n");
}

function formatConstraints(vision: VisionDocument): string {
  if (!vision.constraints || vision.constraints.length === 0) return "(no constraints)";
  return vision.constraints.map((c) => `  - ${c}`).join("\n");
}

/**
 * Describe the codebase structure using available information.
 * The agent will do its own exploration — this gives a starting point.
 */
function codebaseContext(): string {
  return `
The agent will explore the codebase directly using bash, ls, find, grep, and read tools.
Key areas to examine:
  - package.json for project metadata, scripts, dependencies
  - tsconfig.json for TypeScript configuration
  - src/ directory for source code
  - tests/ directory for test files
  - Any config files (.eslintrc, vitest.config, etc.)
`;
}

// ─── Stage 1: SCAN ───

/**
 * Compile a prompt for the RepoScanAgent.
 *
 * Given the project vision, active goal, and repo context,
 * the agent scans the codebase for patterns, issues, and
 * opportunities related to the active milestone.
 */
export function compileScanPrompt(vision: VisionDocument): string {
  return `You are loopi's **RepoScanAgent**. Your job is to scan the codebase and identify everything relevant to the active milestone.

## Context

### Project Vision
${vision.northStar ? `North Star: ${vision.northStar}` : ""}
${vision.projectDescription}

### Active Goal / Milestones
${formatMilestones(vision)}

### Business Goals & Technical Priorities
${formatGoals(vision)}

### Constraints
${formatConstraints(vision)}

### Codebase
${codebaseContext()}

## Your Task

1. **Explore the codebase** — Use \`ls\`, \`find\`, \`grep\`, \`read\`, \`bash\` to understand the project structure and find relevant patterns.
2. **Focus on the active milestones** — What code changes are needed to advance them?
3. **Scan for issues in the context of these goals** — Look for:
   - Code that doesn't align with the vision
   - Missing features or gaps
   - Technical debt areas relevant to the milestones
   - Test gaps
   - Lint/type errors related to the goals
   - TODO/FIXME comments in relevant areas
   - Architectural mismatches
4. **Be thorough** — Read key files, check tests, run \`tsc --noEmit\` and lint if applicable.

## Output Format

Return a JSON block inside a fenced code block:

\`\`\`json
{
  "type": "scan_result",
  "data": {
    "summary": "Brief overview of what you found",
    "findings": [
      {
        "file": "relative/path/to/file.ts",
        "line": 42,
        "message": "Description of the finding",
        "severity": "critical|high|medium|low",
        "category": "bug|tech-debt|test-gap|docs|architecture|performance|security|missing-feature"
      }
    ],
    "codebaseHealth": {
      "structure": "good|needs-improvement|poor",
      "testCoverage": "good|needs-improvement|poor|unknown",
      "typeSafety": "good|needs-improvement|poor|unknown"
    },
    "milestoneProgress": "What progress exists toward each milestone",
    "recommendations": [
      "Specific, actionable recommendation"
    ]
  }
}
\`\`\`

**Important**: Output ONLY the JSON block. No extra text.`;
}

// ─── Stage 2: ANALYZE ───

/**
 * Compile a prompt for the AnalyzerAgent.
 *
 * Given the scan findings and vision, prioritize tasks
 * that would have the most impact on the active milestone.
 */
export function compileAnalyzePrompt(
  vision: VisionDocument,
  scanResult: string
): string {
  return `You are loopi's **AnalyzerAgent**. Your job is to analyze scan findings and produce a prioritized list of concrete improvement tasks.

## Context

### Project Vision
${vision.northStar ? `North Star: ${vision.northStar}` : ""}
${vision.projectDescription}

### Active Milestones
${formatMilestones(vision)}

### Business Goals
${formatGoals(vision)}

### Scan Findings
Below is the raw scan result from the RepoScanAgent. Analyze it carefully.

\`\`\`
${scanResult}
\`\`\`

## Your Task

1. **Review the scan findings** and understand the codebase state
2. **Prioritize by impact on the active milestone** — What changes would most advance the milestone?
3. **Group related findings** into coherent tasks
4. **Consider effort vs value** — Quick wins that advance the milestone should rank higher
5. **Produce 1-5 concrete tasks** that can be executed independently

## Output Format

\`\`\`json
{
  "type": "analyze_result",
  "data": {
    "summary": "Analysis overview",
    "tasks": [
      {
        "title": "Brief task title",
        "description": "What needs to be done and why",
        "impact": "high|medium|low",
        "effort": "small|medium|large",
        "category": "bug|feature|tech-debt|test|docs|refactor",
        "filesLikelyAffected": [
          "src/file-that-may-change.ts"
        ],
        "dependsOnTask": null
      }
    ],
    "recommendedOrder": ["task-title-1", "task-title-2"]
  }
}
\`\`\`

**Important**: Output ONLY the JSON block. No extra text.`;
}

// ─── Stage 3: PLAN ───

/**
 * Compile a prompt for the PlannerAgent.
 *
 * Given one task, produce a detailed step-by-step plan
 * with file-level changes and test requirements.
 */
export function compilePlanPrompt(
  vision: VisionDocument,
  task: string
): string {
  return `You are loopi's **PlannerAgent**. Your job is to create a detailed, step-by-step plan for implementing one specific improvement task.

## Context

### Project Vision
${vision.northStar ? `North Star: ${vision.northStar}` : ""}
${vision.projectDescription}

### Task
${task}

### Codebase
${codebaseContext()}

## Your Task

1. **Explore the relevant code** — Read the files that will need to change
2. **Design the solution** — Plan the exact changes needed
3. **Consider edge cases** — What could go wrong?
4. **Specify test requirements** — What tests need to be added/modified?
5. **Estimate risk** — How risky is this change?

## Output Format

\`\`\`json
{
  "type": "plan_result",
  "data": {
    "summary": "Plan summary",
    "rationale": "Why this approach was chosen",
    "risk": "low|medium|high",
    "steps": [
      "Step 1: ...",
      "Step 2: ..."
    ],
    "filesToModify": [
      {
        "path": "relative/path/to/file.ts",
        "operation": "modify|create|delete",
        "description": "What to change in this file"
      }
    ],
    "testRequirements": [
      "What tests need to be added or updated"
    ],
    "estimatedComplexity": "trivial|simple|moderate|complex"
  }
}
\`\`\`

**Important**: Output ONLY the JSON block. No extra text.`;
}

// ─── Stage 4: EXECUTE ───

/**
 * Compile a prompt for the ExecutorAgent.
 *
 * Given a plan, produce the actual code changes as a unified diff
 * that can be applied with \`git apply\`.
 */
export function compileExecutePrompt(plan: string): string {
  return `You are loopi's **ExecutorAgent**. Your job is to implement the planned changes by producing a git diff.

## The Plan
\`\`\`
${plan}
\`\`\`

## Your Task

1. **Read the current files** that need to be modified
2. **Implement the changes** following the plan exactly
3. **Generate a unified diff** (\`git diff\` format) showing before and after
4. **Ensure the diff is valid** — it should apply cleanly with \`git apply\`
5. **Verify** the changes compile and make sense

## Guidelines

- Follow the plan exactly — do not add scope creep
- Keep changes focused and minimal
- Ensure proper error handling
- Maintain existing code style
- If creating a new file, the diff should show the full file content as added lines

## Output Format

\`\`\`json
{
  "type": "execute_result",
  "data": {
    "summary": "What was implemented",
    "diff": "Full unified diff here (git diff format)",
    "filesChanged": ["relative/path/to/file.ts"],
    "testChanges": "Any test changes needed",
    "verificationNotes": [
      "Notes on what was verified"
    ]
  }
}
\`\`\`

**Important**: Output ONLY the JSON block. No extra text. The \`diff\` field must contain a valid unified diff.`;
}

// ─── Stage 5: IMPROVE ───

/**
 * Compile a prompt for the SelfImproveAgent.
 *
 * Given metrics from the completed cycle, suggest improvements
 * to prompts, strategies, and weights for future cycles.
 */
export function compileImprovePrompt(
  vision: VisionDocument,
  cycleMetrics: {
    opportunitiesFound: number;
    tasksCreated: number;
    tasksCompleted: number;
    tasksRejected: number;
    totalChanges: number;
    cycleDurationMs: number;
  },
  patternHistory: Pattern[]
): string {
  const successRate =
    cycleMetrics.tasksCreated > 0
      ? Math.round(
          (cycleMetrics.tasksCompleted / cycleMetrics.tasksCreated) * 100
        )
      : 0;

  const patternSummary =
    patternHistory.length > 0
      ? patternHistory
          .slice(-5)
          .map((p) => `  - ${p.summary} (${p.category}, outcome: ${p.outcome ?? "unknown"})`)
          .join("\n")
      : "(no patterns recorded yet)";

  return `You are loopi's **SelfImproveAgent**. Your job is to analyze the latest improvement cycle and suggest improvements to the pipeline itself.

## Cycle Metrics
- Opportunities found: ${cycleMetrics.opportunitiesFound}
- Tasks created: ${cycleMetrics.tasksCreated}
- Tasks completed: ${cycleMetrics.tasksCompleted}
- Tasks rejected: ${cycleMetrics.tasksRejected}
- Total changes applied: ${cycleMetrics.totalChanges}
- Success rate: ${successRate}%
- Cycle duration: ${Math.round(cycleMetrics.cycleDurationMs / 1000)}s

## Pattern History (Last 5)
${patternSummary}

## Active Vision
${vision.northStar ? `North Star: ${vision.northStar}` : ""}

## Your Task

Analyze the cycle results and suggest improvements:

1. **Prompt quality** — Were the scan/analyze/plan/execute prompts effective? What should change?
2. **Strategy adjustments** — What should the pipeline prioritize differently?
3. **Pattern recognition** — What patterns emerged that should be recorded?
4. **Goal progression** — How well did this cycle advance the current milestone?
5. **Next focus** — What should the next cycle focus on?

## Output Format

\`\`\`json
{
  "type": "improve_result",
  "data": {
    "summary": "Overall assessment of the cycle",
    "promptImprovements": [
      "Specific improvement to a prompt template"
    ],
    "strategyAdjustments": [
      "What the pipeline should do differently"
    ],
    "newPatterns": [
      {
        "summary": "Pattern description",
        "category": "quality|tech-debt|architecture|feature|test|docs",
        "tags": ["relevant", "tags"]
      }
    ],
    "milestoneProgress": "Assessment of milestone progress",
    "nextFocus": "What the next cycle should focus on"
  }
}
\`\`\`

**Important**: Output ONLY the JSON block. No extra text.`;
}
