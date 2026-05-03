#!/usr/bin/env node
/**
 * CLI to detect and display all signals.
 * Usage: pnpm agent:signal
 */
import { loadConfig } from "../actions/config.js";
import { detectAllSignals } from "./detectors.js";
import { logger } from "../actions/logger.js";

async function main() {
  loadConfig();
  logger.info("Detecting all signals...\n");

  const signals = await detectAllSignals();

  if (signals.length === 0) {
    console.log("No signals detected. Everything looks clean!");
    return;
  }

  // Group by type
  const byType = new Map<string, typeof signals>();
  for (const signal of signals) {
    const arr = byType.get(signal.type) ?? [];
    arr.push(signal);
    byType.set(signal.type, arr);
  }

  console.log(`Found ${signals.length} signal(s):\n`);

  for (const [type, sigs] of byType) {
    console.log(`  ${type} (${sigs.length}):`);
    for (const sig of sigs) {
      const sevIcon =
        sig.severity === "critical"
          ? "🔴"
          : sig.severity === "high"
            ? "🟠"
            : sig.severity === "medium"
              ? "🟡"
              : "⚪";
      console.log(`    ${sevIcon} [${sig.severity}] ${sig.message}`);
      if (sig.file) {
        console.log(`       File: ${sig.file}`);
      }
    }
    console.log();
  }

  // Summary
  const highCount = signals.filter((s) => s.severity === "high" || s.severity === "critical").length;
  if (highCount > 0) {
    console.log(`⚠️  ${highCount} high/critical severity signal(s) require attention.`);
  }
}

main().catch((err) => {
  console.error("Signal detection failed:", err);
  process.exit(1);
});
