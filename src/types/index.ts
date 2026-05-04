import { z } from "zod/v3";

// ──────────────────────────────────────────────
// Agent output protocol
// Every agent returns a block like:
// ```json
// { "type": "vision", "data": { ... } }
// ```
// ──────────────────────────────────────────────

export const AgentOutputSchema = z.object({
  type: z.string(),
  data: z.record(z.unknown()),
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

// ──────────────────────────────────────────────
// Vision
// ──────────────────────────────────────────────

export const VisionSchema = z.object({
  version: z.number().default(1),
  lastUpdated: z.string().datetime({ offset: true }).optional(),
  projectDescription: z.string().min(1),
  businessGoals: z.array(z.string()).min(1),
  technicalPriorities: z.array(z.string()).default([]),
  userPersonas: z.array(z.string()).default([]),
  competitiveContext: z.string().optional(),
  revenueModel: z.string().optional(),
  constraints: z.array(z.string()).default([]),

  /**
   * The "north star" — a one-sentence definition of what
   * a successful version of this project looks like.
   * Agents use this to evaluate whether a change aligns
   * with the vision.
   */
  northStar: z.string().optional(),
});
export type VisionDocument = z.infer<typeof VisionSchema>;

// ──────────────────────────────────────────────
// Opportunity
// ──────────────────────────────────────────────

export const OpportunityStatusSchema = z.enum([
  "suggested",
  "accepted",
  "rejected",
  "applied",
]);
export type OpportunityStatus = z.infer<typeof OpportunityStatusSchema>;

export const OpportunitySchema = z.object({
  id: z.string().uuid(),
  createdAt: z.number().int().positive(),
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  category: z.enum([
    "feature",
    "revenue",
    "growth",
    "tech-debt",
    "security",
    "performance",
    "quality",
    "docs",
    "architecture",
  ]),
  estimatedValue: z.enum(["low", "medium", "high", "critical"]),
  estimatedEffort: z.enum(["trivial", "small", "medium", "large", "epic"]),
  affectedAreas: z.array(z.string()).default([]),
  status: OpportunityStatusSchema.default("suggested"),
  statusChangedAt: z.number().int().positive().optional(),

  /** Human's note when rejecting */
  rejectionReason: z.string().optional(),

  /** Reference to the cycle that applied this opportunity */
  appliedInCycle: z.string().optional(),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

// ──────────────────────────────────────────────
// Scout report
// ──────────────────────────────────────────────

export const ScoutFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  imports: z.array(z.string()).default([]),
  exports: z.array(z.string()).default([]),
  isTest: z.boolean().default(false),
  lastModified: z.string().optional(),
});

export const ScoutReportSchema = z.object({
  opportunityId: z.string().uuid(),
  summary: z.string(),
  files: z.array(ScoutFileSchema),
  dependencies: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
});
export type ScoutReport = z.infer<typeof ScoutReportSchema>;

// ──────────────────────────────────────────────
// Analysis (from analysis-agent)
// Lightweight — the agent does deep reasoning,
// this is just the structured output shape.
// ──────────────────────────────────────────────

export const CodeSmellSchema = z.object({
  file: z.string(),
  line: z.number().int().positive().optional(),
  type: z.string(),
  description: z.string(),
  severity: z.enum(["low", "medium", "high"]).default("medium"),
  suggestion: z.string().optional(),
});
export type CodeSmell = z.infer<typeof CodeSmellSchema>;

export const AnalysisReportSchema = z.object({
  opportunityId: z.string().uuid().optional(),
  summary: z.string().min(1),
  findings: z.array(z.string()).default([]),
  smells: z.array(CodeSmellSchema).default([]),
  healthScore: z.number().int().min(0).max(100).default(50),
  recommendations: z.array(z.string()).default([]),
  criticalBlockers: z.array(z.string()).default([]),
});
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;

// ──────────────────────────────────────────────
// Improvement plan (from planner-agent)
// ──────────────────────────────────────────────

export const OperationTypeSchema = z.enum([
  "refactor",
  "fix",
  "improve-tests",
  "dedupe",
  "optimize",
  "typing",
]);
export type OperationType = z.infer<typeof OperationTypeSchema>;

export const ImprovementPlanSchema = z.object({
  summary: z.string().min(1).max(200),
  rationale: z.string().min(1),
  affectedFiles: z.array(z.string()).min(1).max(3),
  expectedPatchSize: z.number().int().positive().max(500).optional(),
  requiredTests: z.array(z.string()).default([]),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  operation: OperationTypeSchema,
  details: z.string().min(1),
  steps: z.array(z.string()).default([]),

  /**
   * Optional: the actual new content of each affected file.
   * If provided, passes this to the patch-agent for diff generation.
   */
  fileContents: z.record(z.string()).optional(),
});
export type ImprovementPlan = z.infer<typeof ImprovementPlanSchema>;

// ──────────────────────────────────────────────
// Patch (from patch-agent)
// ──────────────────────────────────────────────

export const PatchSchema = z.object({
  id: z.string(),
  planId: z.string().optional(),
  diff: z.string().min(1),
  files: z.array(z.string()).min(1).max(3).default([]),
  size: z.number().int().nonnegative().default(0),
  status: z
    .enum(["pending", "approved", "applied", "rejected", "failed"])
    .default("pending"),
});
export type Patch = z.infer<typeof PatchSchema>;

// ──────────────────────────────────────────────
// Review result (from reviewer-agent)
// ──────────────────────────────────────────────

export const ReviewResultSchema = z.object({
  approved: z.boolean(),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  riskReport: z.string().default(""),
  regressionChecklist: z.array(z.string()).default([]),
  testImpactSummary: z.string().default(""),
  recommendation: z.string().default(""),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

// ──────────────────────────────────────────────
// Default config (embedded, no file required)
// ──────────────────────────────────────────────

export const DEFAULT_CONFIG: Config = {
  projectName: "loopi",
  vision: {
    autoDetectOnMissing: true,
    askOnInit: true,
  },
  opportunity: {
    maxSuggestionsPerCycle: 3,
    historyFile: ".pi/loopi/opportunity-history.json",
  },
  humanGate: {
    enabled: true,
    timeoutMinutes: 60,
    autoRejectOnTimeout: true,
  },
  constraints: {
    maxFilesPerPatch: 3,
    maxPatchSizeLines: 500,
    maxPatchSizeBytes: 10240,
    allowedOperations: ["refactor", "fix", "improve-tests", "dedupe", "optimize", "typing"],
    forbiddenDirectories: ["node_modules", "dist", "build", ".git"],
  },
  runFrequencyMinutes: 30,
  git: {
    commitPrefix: "feat(loopi):",
    branchPrefix: "loopi/",
    autoPush: false,
  },
};

// ──────────────────────────────────────────────
// Config (Zod schema)
// ──────────────────────────────────────────────

export const ConfigSchema = z.object({
  projectName: z.string().default("loopi"),
  vision: z
    .object({
      autoDetectOnMissing: z.boolean().default(true),
      askOnInit: z.boolean().default(true),
    })
    .default({}),
  opportunity: z
    .object({
      maxSuggestionsPerCycle: z.number().int().positive().default(3),
      historyFile: z.string().default(".pi/loopi/opportunity-history.json"),
    })
    .default({}),
  humanGate: z
    .object({
      /** Always require human approval before applying */
      enabled: z.boolean().default(true),
      /** How long to wait for human response (minutes) */
      timeoutMinutes: z.number().int().positive().default(60),
      /** Auto-reject if human doesn't respond in time */
      autoRejectOnTimeout: z.boolean().default(true),
    })
    .default({}),
  constraints: z.object({
    maxFilesPerPatch: z.number().int().positive().default(3),
    maxPatchSizeLines: z.number().int().positive().default(500),
    maxPatchSizeBytes: z.number().int().positive().default(10240),
    allowedOperations: z
      .array(OperationTypeSchema)
      .default(["refactor", "fix", "improve-tests", "dedupe", "optimize", "typing"]),
    forbiddenDirectories: z
      .array(z.string())
      .default(["node_modules", "dist", "build", ".git"]),
  }).default({}),
  runFrequencyMinutes: z.number().int().positive().default(30),
  git: z
    .object({
      commitPrefix: z.string().default("feat(loopi):"),
      branchPrefix: z.string().default("loopi/"),
      autoPush: z.boolean().default(false),
    })
    .default({}),
  targetRepo: z
    .object({
      path: z.string().optional(),
      branch: z.string().optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

// ──────────────────────────────────────────────
// Pipeline state
// ──────────────────────────────────────────────

export const CycleResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("improved"),
    patchId: z.string(),
    summary: z.string(),
    branch: z.string(),
    opportunityId: z.string().optional(),
  }),
  z.object({
    type: z.literal("nothing"),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("rejected"),
    reason: z.string(),
    patchId: z.string().optional(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);
export type CycleResult = z.infer<typeof CycleResultSchema>;

export const PipelineStatusSchema = z.enum([
  "idle",
  "running",
  "waiting-human",
  "completed",
  "failed",
]);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

// ──────────────────────────────────────────────
// Agent names (constants)
// ──────────────────────────────────────────────

export const AGENTS = {
  VISION: "loopi.vision-agent",
  OPPORTUNITY: "loopi.opportunity-agent",
  SCOUT: "loopi.scout-agent",
  ANALYSIS: "loopi.analysis-agent",
  PLANNER: "loopi.planner-agent",
  PATCH: "loopi.patch-agent",
  REVIEWER: "loopi.reviewer-agent",
  DOCS: "loopi.docs-agent",
} as const;
