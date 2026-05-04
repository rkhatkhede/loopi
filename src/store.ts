/**
 * loopi — Shared Conf-based Store
 *
 * Single atomic JSON store replacing all hand-rolled file I/O.
 * Uses `conf` with atomically for safe concurrent writes.
 */
import Conf from "conf";
import { resolve } from "path";

/** Namespaced keys used across the codebase */
export const KEYS = {
  VISION: "vision",
  OPPORTUNITIES: "opportunities",
  PATTERNS: "patterns",
  GOALS: "goals",
  TASKS: "tasks",
  PIPELINE_PROGRESS: "pipelineProgress",
  PENDING_QUESTIONS: "pendingQuestions",
  PENDING_ANSWERS: "pendingAnswers",
} as const;

/** Singleton conf instance — project-local in .pi/loopi */
export const store = new Conf<Record<string, unknown>>({
  projectName: "loopi",
  cwd: resolve(process.cwd(), ".pi/loopi"),
  configName: "store",
});
