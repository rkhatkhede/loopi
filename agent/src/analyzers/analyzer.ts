import { readFileSync } from "fs";
import { extname } from "path";
import type { AnalysisReport, CodeSmell, TodoItem, ComplexityReport, ErrorPattern, Signal } from "../types/index.js";
import { getConfig } from "../actions/config.js";
import { logger } from "../actions/logger.js";

const TODO_PATTERNS = /\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b/g;
const TRY_CATCH = /\btry\s*\{/g;
const ASYNC_FN = /\b(async\s+)?function\s+\w+/g;
const RETURN_TYPE = /\)\s*:\s*\w+/g;
const ANY_TYPE = /\bany\b/g;
const PROMISE_RE = /\.(then|catch)\s*\(/g;

export interface AnalyzerInput {
  files: string[];
  signals: Signal[];
}

export function analyzeFile(filePath: string): {
  smells: CodeSmell[];
  todos: TodoItem[];
  complexity: ComplexityReport[];
  errors: ErrorPattern[];
  lines: number;
} {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const smells: CodeSmell[] = [];
  const todos: TodoItem[] = [];
  const complexity: ComplexityReport[] = [];
  const errors: ErrorPattern[] = [];

  let nestingDepth = 0;
  let currentFn = "";
  let fnStartLine = 0;
  let fnComplexity = 0;
  let tryCount = 0;
  let catchCount = 0;
  let anyCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Track TODO/FIXME/HACK
    const todoMatch = line.match(TODO_PATTERNS);
    if (todoMatch) {
      todos.push({
        file: filePath,
        line: lineNum,
        pattern: todoMatch[0],
        text: line.trim(),
      });
    }

    // Track any usage
    const anyMatches = line.match(ANY_TYPE);
    if (anyMatches) {
      anyCount += anyMatches.length;
    }

    // Track try/catch
    if (TRY_CATCH.test(line)) {
      tryCount++;
    }
    if (/\bcatch\s*\(/.test(line)) {
      catchCount++;
    }

    // Track function complexity
    const fnMatch = line.match(/(?:async\s+)?function\s+(\w+)/);
    if (fnMatch) {
      if (currentFn && fnComplexity > getConfig().constraints.minComplexityThreshold) {
        complexity.push({
          file: filePath,
          functionName: currentFn,
          line: fnStartLine,
          complexity: fnComplexity,
          risk: fnComplexity > 20 ? "high" : fnComplexity > 10 ? "medium" : "low",
        });
      }
      currentFn = fnMatch[1] ?? "anonymous";
      fnStartLine = lineNum;
      fnComplexity = 1;
    }

    // Heuristic: count conditionals for complexity
    const conditionals = (line.match(/\b(if|else\s+if|for|while|case\s+\w+|catch|&&|\|\|)\b/g) || []).length;
    fnComplexity += conditionals;

    // Track nesting depth
    const openers = (line.match(/\{/g) || []).length;
    const closers = (line.match(/\}/g) || []).length;
    nestingDepth += openers - closers;

    // Detect deep nesting as smell
    if (openers > 0 && nestingDepth > 4 && line.trim()) {
      smells.push({
        file: filePath,
        line: lineNum,
        type: "deep-nesting",
        description: `Deep nesting (depth ${nestingDepth})`,
        severity: nestingDepth > 6 ? "high" : "medium",
        suggestion: "Consider extracting inner logic to a separate function",
      });
    }

    // Long line
    if (line.length > 120 && line.trim()) {
      smells.push({
        file: filePath,
        line: lineNum,
        type: "long-line",
        description: `Line is ${line.length} characters (max 120)`,
        severity: "low",
        suggestion: "Break line into multiple lines",
      });
    }

    // Detect missing return types on functions (simple heuristic)
    if (fnMatch && i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      if (!nextLine.includes(":") && !line.includes(":")) {
        smells.push({
          file: filePath,
          line: lineNum,
          type: "missing-return-type",
          description: `Function '${currentFn}' appears to lack explicit return type`,
          severity: "low",
          suggestion: "Add explicit return type annotation",
        });
      }
    }
  }

  // Finalize last function
  if (currentFn && fnComplexity > getConfig().constraints.minComplexityThreshold) {
    complexity.push({
      file: filePath,
      functionName: currentFn,
      line: fnStartLine,
      complexity: fnComplexity,
      risk: fnComplexity > 20 ? "high" : fnComplexity > 10 ? "medium" : "low",
    });
  }

  // Error patterns
  if (tryCount > catchCount) {
    errors.push({
      file: filePath,
      pattern: `try-without-catch`,
      count: tryCount - catchCount,
      severity: "medium",
      example: `Missing catch blocks (${tryCount} try, ${catchCount} catch)`,
    });
  }

  if (anyCount > 5) {
    errors.push({
      file: filePath,
      pattern: `excessive-any`,
      count: anyCount,
      severity: "medium",
      example: `${anyCount} uses of 'any' type`,
    });
  }

  return { smells, todos, complexity, errors, lines: lines.length };
}

export function analyzeCodebase(input: AnalyzerInput): AnalysisReport {
  logger.info(`Analyzing ${input.files.length} files...`);

  const allSmells: CodeSmell[] = [];
  const allTodos: TodoItem[] = [];
  const allComplexity: ComplexityReport[] = [];
  const allErrors: ErrorPattern[] = [];
  let totalLines = 0;
  let smellCount = 0;
  let highSeverityIssues = 0;

  const maxFiles = getConfig().constraints.maxFilesPerAnalysis;
  const filesToAnalyze = input.files.slice(0, maxFiles);

  for (const file of filesToAnalyze) {
    try {
      if (!file.endsWith(".ts")) continue;
      const result = analyzeFile(file);
      allSmells.push(...result.smells);
      allTodos.push(...result.todos);
      allComplexity.push(...result.complexity);
      allErrors.push(...result.errors);
      totalLines += result.lines;
      smellCount += result.smells.length;
      highSeverityIssues += result.smells.filter((s) => s.severity === "high").length;
    } catch (err) {
      logger.debug(`Skipping unreadable file: ${file}`);
    }
  }

  // Sort by severity
  allComplexity.sort((a, b) => b.complexity - a.complexity);
  allErrors.sort((a, b) => b.count - a.count);

  // Calculate health score (0-100)
  const severityPenalty = highSeverityIssues * 15 + smellCount * 3;
  const todoPenalty = allTodos.length * 2;
  const complexityPenalty = allComplexity.filter((c) => c.risk === "high").length * 10;
  const totalPenalty = severityPenalty + todoPenalty + complexityPenalty;
  const healthScore = Math.max(0, Math.min(100, 100 - totalPenalty));

  const summary =
    `Analyzed ${filesToAnalyze.length} files (${totalLines} lines). ` +
    `Found ${allSmells.length} code smells, ${allTodos.length} TODOs, ` +
    `${allComplexity.filter((c) => c.risk === "high" || c.risk === "critical").length} high-complexity functions, ` +
    `${allErrors.length} error patterns. Health score: ${healthScore}/100.`;

  logger.info(summary);

  return {
    timestamp: Date.now(),
    signals: input.signals,
    filesAnalyzed: filesToAnalyze,
    smells: allSmells.slice(0, 50), // cap
    todos: allTodos.slice(0, 30),
    complexity: allComplexity.slice(0, 20),
    errors: allErrors.slice(0, 10),
    healthScore,
    summary,
  };
}
