import { appendFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { getConfig } from "./config.js";

const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_NUM: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  fatal: "\x1b[35m", // magenta
};
const RESET = "\x1b[0m";

let _minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  _minLevel = level;
}

function getLogDir(): string {
  return resolve(process.cwd(), ".pi/loopi/logs");
}

function ensureLogDir(): void {
  const dir = getLogDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function writeLog(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_NUM[level] < LEVEL_NUM[_minLevel]) return;

  const timestamp = formatTimestamp();
  const metaStr = meta !== undefined ? ` ${JSON.stringify(meta)}` : "";
  const plainLine = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;

  // Console output with colors
  const color = COLORS[level];
  const coloredLine = `${color}[${timestamp}] [${level.toUpperCase()}]${RESET} ${message}${metaStr}`;

  if (level === "error" || level === "fatal") {
    console.error(coloredLine);
  } else {
    console.log(coloredLine);
  }

  // File output
  try {
    ensureLogDir();
    const logFile = resolve(getLogDir(), `${new Date().toISOString().slice(0, 10)}.log`);
    appendFileSync(logFile, plainLine, "utf-8");
  } catch {
    // Silently fail on log write errors
  }
}

export const logger = {
  debug: (msg: string, meta?: unknown) => writeLog("debug", msg, meta),
  info: (msg: string, meta?: unknown) => writeLog("info", msg, meta),
  warn: (msg: string, meta?: unknown) => writeLog("warn", msg, meta),
  error: (msg: string, meta?: unknown) => writeLog("error", msg, meta),
  fatal: (msg: string, meta?: unknown) => writeLog("fatal", msg, meta),
};
