import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod/v3";
import { ConfigSchema, type Config } from "../types/index.js";

let _config: Config | null = null;

export function loadConfig(configPath?: string): Config {
  if (_config) return _config;

  const path = configPath ?? resolve(process.cwd(), "agent/agent.config.json");
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = ConfigSchema.parse(JSON.parse(raw));
  _config = parsed;
  return _config;
}

export function getConfig(): Config {
  if (!_config) return loadConfig();
  return _config;
}

export function reloadConfig(configPath?: string): Config {
  _config = null;
  return loadConfig(configPath);
}

export function resetConfig(): void {
  _config = null;
}
