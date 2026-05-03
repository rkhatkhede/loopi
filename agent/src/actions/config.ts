import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import type { AgentConfig } from "../types/index.js";

let _config: AgentConfig | null = null;

export function loadConfig(configPath?: string): AgentConfig {
  if (_config) return _config;

  const path = configPath ?? resolve(process.cwd(), "agent/agent.config.json");
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  _config = JSON.parse(raw) as AgentConfig;
  return _config;
}

export function getConfig(): AgentConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function reloadConfig(): AgentConfig {
  _config = null;
  return loadConfig();
}

// TODO: Add schema validation for agent.config.json
// TODO: Add env variable override support
