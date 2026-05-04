import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod/v3";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "../types/index.js";

let _config: Config | null = null;

export function loadConfig(configPath?: string): Config {
  if (_config) return _config;

  const path = configPath ?? resolve(process.cwd(), ".pi/loopi/config.json");
  if (!existsSync(path)) {
    // Return defaults when no config file exists
    _config = DEFAULT_CONFIG;
    return _config;
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
