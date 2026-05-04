/**
 * loopi TUI Dashboard
 *
 * A real-time terminal dashboard showing the system overview.
 * Uses ANSI escape codes and picocolors — zero additional dependencies.
 *
 * Launched via: loopi
 *
 * Controls:
 *   q        — Quit dashboard
 *   r        — Force refresh
 *   Space    — Toggle auto-refresh
 *   a        — Approve latest pending patch
 *   R (shift) — Reject latest pending patch
 *   p        — Promote dev → main
 *   ?        — Show pipeline spec (any key to dismiss)
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { loadConfig } from "../actions/config.js";
import { listPending, listApproved } from "../actions/pr.js";
import { readVision, readOpportunityHistory, approvePending, rejectPending, promoteToMain, readPatterns, PIPELINE_SPEC } from "../pipeline.js";
import { logger } from "../actions/logger.js";
import pc from "picocolors";

// ─── Terminal control ───

const ESC = "\x1b";
const CSI = `${ESC}[`;

function cursorTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}
function clearScreen(): string {
  return `${CSI}2J`;
}
function hideCursor(): string {
  return `${CSI}?25l`;
}
function showCursor(): string {
  return `${CSI}?25h`;
}
function clearLine(): string {
  return `${CSI}2K`;
}
function clearBelow(): string {
  return `${CSI}J`;
}

// ─── Layout ───

interface Layout {
  cols: number;
  rows: number;
  header: { row: number; height: number };
  workflows: { row: number; height: number; col: number; width: number };
  cycle: { row: number; height: number; col: number; width: number };
  log: { row: number; height: number };
  footer: { row: number; height: number };
  logLineCount: number;
}

function computeLayout(rows: number, cols: number): Layout {
  const headerH = 2;
  const footerH = 2;
  const bodyH = rows - headerH - footerH;
  const leftW = Math.floor(cols / 2);
  const rightW = cols - leftW;
  const panelH = Math.floor(bodyH / 3) * 2; // top panels take 2/3
  const logH = Math.max(bodyH - panelH, 1);

  return {
    cols,
    rows,
    header: { row: 1, height: headerH },
    workflows: { row: headerH + 1, height: panelH, col: 1, width: leftW },
    cycle: { row: headerH + 1, height: panelH, col: leftW + 1, width: rightW },
    log: { row: headerH + 1 + panelH, height: logH },
    footer: { row: rows - footerH + 1, height: footerH },
    logLineCount: Math.max(logH - 2, 3),
  };
}

// ─── Data model ───

interface DashboardState {
  status: "idle" | "running" | "waiting-human" | "completed" | "failed";
  cycleNumber: number;
  currentStep: string;
  currentAgent: string;
  lastResult: string;
  currentOpportunity: string;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  logs: string[];
  error?: string;
}

function collectState(layout: Layout): DashboardState {
  const cwd = process.cwd();
  const logLines: string[] = [];

  // Read log file
  const logDir = resolve(cwd, ".pi/loopi/logs");
  if (existsSync(logDir)) {
    const files = readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse();
    if (files.length > 0) {
      const content = readFileSync(resolve(logDir, files[0]!), "utf-8")
        .trim()
        .split("\n");
      const slice = content.slice(-layout.logLineCount);
      for (const line of slice) {
        logLines.push(line.length > layout.cols ? line.slice(0, layout.cols - 4) + "…" : line);
      }
    }
  }

  // Workflow counts
  const pending = listPending().length;
  const approved = listApproved().length;

  // Vision / opportunities
  let opp = "";
  try {
    const history = readOpportunityHistory();
    const active = history.find(
      (o) => o.status === "accepted" || o.status === "suggested"
    );
    if (active) {
      opp = `${active.title.slice(0, 40)}${active.title.length > 40 ? "…" : ""}`;
    }
  } catch {
    opp = "(error reading history)";
  }

  return {
    status: "idle",
    cycleNumber: 0,
    currentStep: "—",
    currentAgent: "—",
    lastResult: "—",
    currentOpportunity: opp || "—",
    pendingCount: pending,
    approvedCount: approved,
    rejectedCount: 0,
    logs: logLines,
  };
}

// ─── Render ───

const BORDER_H = "─";
const BORDER_V = "│";
const BORDER_TL = "┌";
const BORDER_TR = "┐";
const BORDER_BL = "└";
const BORDER_BR = "┘";
const BORDER_LT = "├";
const BORDER_RT = "┤";
const BORDER_CR = "┬";
const BORDER_CB = "┴";

function repeat(char: string, n: number): string {
  return char.repeat(Math.max(0, n));
}

function boxTop(width: number): string {
  return BORDER_TL + repeat(BORDER_H, width - 2) + BORDER_TR;
}
function boxMid(width: number): string {
  return BORDER_LT + repeat(BORDER_H, width - 2) + BORDER_RT;
}
function boxBot(width: number): string {
  return BORDER_BL + repeat(BORDER_H, width - 2) + BORDER_BR;
}
function boxLine(content: string, width: number): string {
  const inner = content.padEnd(width - 2);
  return BORDER_V + inner.slice(0, width - 2) + BORDER_V;
}

function statusDot(status: DashboardState["status"]): string {
  switch (status) {
    case "idle":
      return pc.yellow("● IDLE");
    case "running":
      return pc.green("● RUNNING");
    case "waiting-human":
      return pc.cyan("● WAITING");
    case "completed":
      return pc.green("● COMPLETED");
    case "failed":
      return pc.red("● FAILED");
  }
}

function logColor(line: string): string {
  if (line.includes("[ERROR]")) return pc.red(line);
  if (line.includes("[WARN]")) return pc.yellow(line);
  if (line.includes("[INFO]")) return pc.green(line);
  return line;
}

function render(state: DashboardState, layout: Layout): string {
  const { cols, rows } = layout;
  if (cols < 50 || rows < 15) {
    return hideCursor() + cursorTo(1, 1) + clearScreen() +
      pc.red("Terminal too small. Need at least 50x15.") + showCursor();
  }

  const lines: string[] = [];

  // ── Header ──
  const title = pc.bold(pc.cyan(" ⚡ loopi — Local Autonomous Improvement Agent "));
  const headerLine = title.padEnd(cols - 1).slice(0, cols - 1);
  lines.push(boxTop(cols));
  lines.push(BORDER_V + " " + statusDot(state.status) + repeat(" ", cols - 16) + pc.dim(`Cycle #${state.cycleNumber}`) + "  " + BORDER_V.slice(0, 1));
  lines.push(BORDER_LT + repeat(BORDER_H, cols - 2) + BORDER_RT);

  // ── Body: Workflows (left) + Cycle (right) ──

  const leftW = layout.workflows.width;
  const rightW = layout.cycle.width;
  const panelH = layout.workflows.height;

  // Title row
  const leftTitle = pc.bold(" WORKFLOWS ").padEnd(leftW - 2).slice(0, leftW - 2);
  const rightTitle = pc.bold(" CURRENT CYCLE ").padEnd(rightW - 2).slice(0, rightW - 2);
  lines.push(BORDER_V + leftTitle + BORDER_V + rightTitle + BORDER_V);

  // Workflows content
  const wfLines = [
    ` Pending:  ${pc.yellow(String(state.pendingCount))} diff(s)`,
    ` Approved: ${pc.green(String(state.approvedCount))} diff(s)`,
    ` Rejected: ${state.rejectedCount > 0 ? pc.red(String(state.rejectedCount)) : "0"} diff(s)`,
    "",
  ];

  // Cycle content
  const cycleLines = [
    ` Step:       ${pc.cyan(state.currentStep)}`,
    ` Agent:      ${pc.dim(state.currentAgent)}`,
    ` Result:     ${state.lastResult}`,
    ` Opportunity:${pc.yellow(state.currentOpportunity)}`,
  ];

  const maxPanelLines = Math.max(wfLines.length, cycleLines.length);
  for (let i = 0; i < panelH - 1; i++) {
    const left = i < wfLines.length ? wfLines[i]! : "";
    const right = i < cycleLines.length ? cycleLines[i]! : "";
    const paddedLeft = left.padEnd(leftW - 2).slice(0, leftW - 2);
    const paddedRight = right.padEnd(rightW - 2).slice(0, rightW - 2);
    lines.push(BORDER_V + paddedLeft + BORDER_V + paddedRight + BORDER_V);
  }

  // Separator before log
  lines.push(BORDER_LT + repeat(BORDER_H, cols - 2) + BORDER_RT);

  // ── Log panel ──
  const logTitle = pc.dim(" LOG ");
  const logHeader = logTitle.padEnd(cols - 2).slice(0, cols - 2);
  lines.push(BORDER_V + logHeader + BORDER_V);

  const maxLogLines = layout.log.height - 2; // title + bottom border
  const logSlice = state.logs.slice(-maxLogLines);

  for (const logLine of logSlice) {
    // Truncate to fit
    const display = logLine.length > cols - 4
      ? logLine.slice(0, cols - 7) + "…"
      : logLine;
    lines.push(BORDER_V + " " + logColor(display).padEnd(cols - 3).slice(0, cols - 3) + BORDER_V);
  }

  // Fill remaining log space
  const remaining = maxLogLines - logSlice.length;
  for (let i = 0; i < remaining; i++) {
    lines.push(BORDER_V + repeat(" ", cols - 2) + BORDER_V);
  }

  // Footer
  lines.push(BORDER_BL + repeat(BORDER_H, cols - 2) + BORDER_BR);

  // Help bar
  const help = pc.dim(" [q] quit  [r] refresh  [Space] toggle auto  [a] approve  [R] reject  [p] promote  [?] spec ");
  const helpLine = help.padEnd(cols).slice(0, cols);
  lines.push(" " + helpLine);

  // ── Assemble ──
  const output = hideCursor() + cursorTo(1, 1) + "\n" + lines.join("\n");
  return output;
}

// ─── Overlay: pipeline spec ───

function renderSpecOverlay(cols: number, rows: number): string {
  const spec = PIPELINE_SPEC.trim();
  const specLines = spec.split("\n");

  // Calculate overlay dimensions
  const overlayW = Math.min(cols - 4, 80);
  const overlayH = Math.min(rows - 4, specLines.length + 8);
  const startRow = Math.floor((rows - overlayH) / 2);
  const startCol = Math.floor((cols - overlayW) / 2);

  const output: string[] = [];

  // Push cursor to overlay position
  output.push(cursorTo(startRow, startCol));

  // Top border
  output.push(pc.cyan(boxTop(overlayW)));

  // Welcome header
  const welcome = pc.bold(pc.green(" ⚡ loopi — Local Autonomous Improvement Agent "));
  output.push(pc.cyan(BORDER_V) + welcome.padEnd(overlayW - 2).slice(0, overlayW - 2) + pc.cyan(BORDER_V));

  output.push(pc.cyan(BORDER_V) + " This dashboard monitors the pipeline. The pi agent   " + pc.cyan(BORDER_V));
  output.push(pc.cyan(BORDER_V) + " runs the steps below via subagent() calls.          " + pc.cyan(BORDER_V));

  // Divider
  output.push(pc.cyan(BORDER_LT) + repeat(pc.cyan(BORDER_H), overlayW - 2) + pc.cyan(BORDER_RT));

  // Title
  const title = pc.bold(" PIPELINE SPECIFICATION ");
  output.push(pc.cyan(BORDER_V) + title.padEnd(overlayW - 2).slice(0, overlayW - 2) + pc.cyan(BORDER_V));

  // Divider
  output.push(pc.cyan(BORDER_LT) + repeat(pc.cyan(BORDER_H), overlayW - 2) + pc.cyan(BORDER_RT));

  // Content (scrollable — show what fits)
  const contentH = overlayH - 4;
  const visible = specLines.slice(0, contentH);
  for (const line of visible) {
    const truncated = line.length > overlayW - 4 ? line.slice(0, overlayW - 4) + "…" : line;
    output.push(pc.cyan(BORDER_V) + " " + pc.dim(truncated).padEnd(overlayW - 3).slice(0, overlayW - 3) + pc.cyan(BORDER_V));
  }

  // Fill remaining
  for (let i = visible.length; i < contentH; i++) {
    output.push(pc.cyan(BORDER_V) + repeat(" ", overlayW - 2) + pc.cyan(BORDER_V));
  }

  // Bottom border
  output.push(pc.cyan(boxBot(overlayW)));

  // Status summary line below the box
  const summary = buildSummaryLine();
  output.push(cursorTo(startRow + overlayH, startCol) + " " + summary);

  // Dismiss hint
  output.push(cursorTo(startRow + overlayH + 1, startCol) + pc.dim(" Press any key to close this screen and open the dashboard "));

  return hideCursor() + clearScreen() + output.join("\n");
}

/**
 * Build a one-line status summary (vision, pending patches, patterns).
 */
function buildSummaryLine(): string {
  const parts: string[] = [];

  // Vision
  try {
    const vision = readVision();
    if (vision) {
      const total = vision.milestones?.length ?? 0;
      const done = vision.milestones?.filter((m: any) => m.status === "completed").length ?? 0;
      if (total > 0) {
        parts.push(pc.green(`✓ milestones ${done}/${total}`));
      } else {
        parts.push(pc.green("✓ vision set"));
      }
    } else {
      parts.push(pc.yellow("○ no vision yet"));
    }
  } catch {
    parts.push(pc.yellow("○ no vision yet"));
  }

  // Pending patches
  try {
    const pending = listPending();
    if (pending.length > 0) {
      parts.push(pc.yellow(`⚠ ${pending.length} patch${pending.length > 1 ? "es" : ""} pending`));
    } else {
      parts.push(pc.dim("○ no pending patches"));
    }
  } catch {
    parts.push(pc.dim("○ no pending patches"));
  }

  // Past patterns
  try {
    const patterns = readPatterns();
    if (patterns.length > 0) {
      const last = patterns[patterns.length - 1];
      const ago = msAgo(last.createdAt);
      parts.push(pc.dim(`◈ ${patterns.length} pattern${patterns.length > 1 ? "s" : ""}, latest ${ago}`));
    }
  } catch {
    // ignore
  }

  if (parts.length === 0) return "";
  return parts.join(pc.dim(" · "));
}

function msAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

// ─── Dashboard loop ───

export type DashboardAction =
  | { type: "quit" }
  | { type: "approve" }
  | { type: "reject" }
  | { type: "promote" }
  | { type: "status" }
  | { type: "refresh" };

export type DashboardCallback = (action: DashboardAction) => void;

/**
 * Run the TUI dashboard.
 *
 * @param onAction Optional callback for user actions (approve/reject/status)
 */
export async function runDashboard(onAction?: DashboardCallback): Promise<void> {
  const cwd = process.cwd();

  // Set up terminal
  const stdout = process.stdout;
  const stdin = process.stdin;

  if (!stdout.isTTY || !stdin.isTTY) {
    console.error(pc.yellow("Dashboard requires a TTY terminal."));
    process.exit(1);
  }

  // Save terminal state
  const originalRaw = stdin.isRaw;
  const originalEncoding = stdin.readableEncoding;

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf-8");

  // Handle resize
  function onResize() {
    // The next render will pick up the new size
  }
  stdout.on("resize", onResize);

  let running = true;
  let autoRefresh = true;
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let showingSpec = true; // Welcome: show pipeline spec on first open

  function getDimensions() {
    return { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
  }

  function refresh() {
    if (!running) return;
    const { cols, rows } = getDimensions();

    if (showingSpec) {
      stdout.write(renderSpecOverlay(cols, rows));
      return;
    }

    const layout = computeLayout(rows, cols);
    const state = collectState(layout);
    const output = render(state, layout);
    stdout.write(output);
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshInterval = setInterval(refresh, 2000);
  }

  function stopAutoRefresh() {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  }

  // Handle keyboard input
  function onData(data: string) {
    const char = data.toLowerCase();

    // If showing spec overlay, any key dismisses it
    if (showingSpec) {
      showingSpec = false;
      refresh();
      return;
    }

    if (data === "\u0003" || char === "q") {
      // Ctrl+C or q
      running = false;
      cleanup();
      return;
    }

    if (data === "r") {
      refresh();
      return;
    }

    if (data === " ") {
      autoRefresh = !autoRefresh;
      if (autoRefresh) {
        startAutoRefresh();
      } else {
        stopAutoRefresh();
      }
      refresh();
      return;
    }

    if (data === "?") {
      showingSpec = true;
      stopAutoRefresh();
      refresh();
      return;
    }

    if (char === "a") {
      if (onAction) {
        onAction({ type: "approve" });
      } else {
        approvePending(".").then((ok) => {
          if (ok) logger.info("Patch approved and merged.");
        });
      }
      refresh();
      return;
    }

    if (data === "R") {
      if (onAction) {
        onAction({ type: "reject" });
      } else {
        rejectPending().then((ok) => {
          if (ok) logger.info("Patch rejected.");
        });
      }
      refresh();
      return;
    }

    if (char === "p") {
      if (onAction) {
        onAction({ type: "promote" });
      } else {
        promoteToMain(".").then((ok) => {
          if (ok) logger.info("Promoted dev → main.");
        });
      }
      refresh();
      return;
    }
  }

  stdin.on("data", onData);

  function cleanup() {
    stopAutoRefresh();
    stdout.removeListener("resize", onResize);
    stdin.removeListener("data", onData);
    stdin.setRawMode(originalRaw ?? false);
    stdin.pause();
    stdout.write(showCursor() + clearBelow() + cursorTo(1, 1));
  }

  // Render initial state
  refresh();
  startAutoRefresh();

  // Wait for quit
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  cleanup();
}

// ─── Direct execution support ───

const isMain = process.argv[1] && (process.argv[1].endsWith("dashboard.ts") || process.argv[1].endsWith("dashboard.js"));
if (isMain) {
  runDashboard().catch((err) => {
    console.error(pc.red("Dashboard error:"), err);
    process.exit(1);
  });
}
