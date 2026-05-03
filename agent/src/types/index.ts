export interface AgentConfig {
  projectName: string;
  constraints: Constraints;
  goals: string[];
  runFrequencyMinutes: number;
  signals: SignalConfig;
  review: ReviewConfig;
  git: GitConfig;
}

export interface Constraints {
  maxFilesPerPatch: number;
  maxPatchSizeLines: number;
  maxPatchSizeBytes: number;
  allowedOperations: OperationType[];
  forbiddenDirectories: string[];
  maxFilesPerAnalysis: number;
  minComplexityThreshold: number;
  staleFileDays: number;
  largeFileLines: number;
}

export type OperationType =
  | "refactor"
  | "fix"
  | "improve-tests"
  | "dedupe"
  | "optimize"
  | "typing";

export interface SignalConfig {
  enabled: {
    gitModified: boolean;
    gitUntracked: boolean;
    errorLog: boolean;
    testsFailing: boolean;
    todoPresent: boolean;
    codeSmell: boolean;
    staleFile: boolean;
    largeFile: boolean;
    complexityThreshold: boolean;
  };
  todoPatterns: string[];
  errorLogPath: string;
}

export interface ReviewConfig {
  requireHumanApproval: boolean;
  autoApproveIfTestsPass: boolean;
  maxRiskLevel: "low" | "medium" | "high";
}

export interface GitConfig {
  commitPrefix: string;
  branchPrefix: string;
  autoPush: boolean;
}

export type SignalType =
  | "git.modified"
  | "git.untracked"
  | "runtime.errorLog"
  | "tests.failing"
  | "todo.present"
  | "code.smell"
  | "stale-file"
  | "large-file"
  | "complexity.threshold";

export interface Signal {
  type: SignalType;
  severity: "low" | "medium" | "high" | "critical";
  file?: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AnalysisReport {
  timestamp: number;
  signals: Signal[];
  filesAnalyzed: string[];
  smells: CodeSmell[];
  todos: TodoItem[];
  complexity: ComplexityReport[];
  errors: ErrorPattern[];
  healthScore: number;
  summary: string;
}

export interface CodeSmell {
  file: string;
  line: number;
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
  suggestion?: string;
}

export interface TodoItem {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

export interface ComplexityReport {
  file: string;
  functionName: string;
  line: number;
  complexity: number;
  risk: "low" | "medium" | "high" | "critical";
}

export interface ErrorPattern {
  file: string;
  pattern: string;
  count: number;
  severity: "low" | "medium" | "high" | "critical";
  example?: string;
}

export interface ImprovementPlan {
  id: string;
  timestamp: number;
  summary: string;
  rationale: string;
  affectedFiles: string[];
  expectedPatchSize: number;
  requiredTests: string[];
  risk: "low" | "medium" | "high";
  operation: OperationType;
  details: string;
}

export interface Patch {
  id: string;
  planId: string;
  diff: string;
  timestamp: number;
  files: string[];
  size: number;
  status: "pending" | "approved" | "applied" | "rejected" | "failed";
}

export interface ReviewResult {
  patchId: string;
  approved: boolean;
  risk: "low" | "medium" | "high";
  riskReport: string;
  regressionChecklist: string[];
  testImpactSummary: string;
  recommendation: string;
  reviewer: string;
  timestamp: number;
}

export type PipelineStatus =
  | "idle"
  | "detecting"
  | "analyzing"
  | "planning"
  | "generating"
  | "reviewing"
  | "applying"
  | "completed"
  | "failed";

export interface PipelineState {
  status: PipelineStatus;
  currentStep?: string;
  signals?: Signal[];
  analysis?: AnalysisReport;
  plan?: ImprovementPlan;
  patch?: Patch;
  review?: ReviewResult;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}
