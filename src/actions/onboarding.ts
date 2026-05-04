/**
 * loopi — Interactive Onboarding Wizard
 *
 * Guides the user through first-time setup:
 *   1. Project description & business goals
 *   2. North star vision
 *   3. Initial milestones
 *   4. Confirmation before saving
 */

import { createInterface } from "readline";
import { stdin as processStdin, stdout as processStdout } from "process";
import { saveVision } from "../pipeline.js";
import type { VisionDocument } from "../types/index.js";
import pc from "picocolors";

function ask(query: string, defaultVal = ""): Promise<string> {
  const rl = createInterface({ input: processStdin, output: processStdout });
  const prompt = defaultVal
    ? `${pc.cyan("?")} ${query} ${pc.dim(`(${defaultVal})`)} `
    : `${pc.cyan("?")} ${query} `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

function askMulti(query: string, hint = "Press Enter after each, blank line to finish"): Promise<string[]> {
  const rl = createInterface({ input: processStdin, output: processStdout });
  const results: string[] = [];
  return new Promise((resolve) => {
    console.log(`${pc.cyan("?")} ${query} ${pc.dim(hint)}`);
    rl.on("line", (line) => {
      if (line.trim() === "") {
        rl.close();
        resolve(results);
      } else {
        results.push(line.trim());
      }
    });
  });
}

function confirm(query: string): Promise<boolean> {
  const rl = createInterface({ input: processStdin, output: processStdout });
  return new Promise((resolve) => {
    rl.question(`${pc.cyan("?")} ${query} ${pc.dim("(Y/n)")} `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() !== "n");
    });
  });
}

function showBanner(): void {
  console.log(`
${pc.bold(pc.green("╔═══════════════════════════════════════════╗"))}
${pc.bold(pc.green("║   loopi — First-Time Setup Wizard        ║"))}
${pc.bold(pc.green("╚═══════════════════════════════════════════╝"))}

${pc.dim("Let's set up your project's improvement vision.")}
${pc.dim("This guides loopi's autonomous code scanning and patching.")}
`);
}

export async function runOnboarding(): Promise<VisionDocument> {
  showBanner();

  // Step 1: Project description
  const projectDescription = await ask("What does this project do? (one line)", "A software project");
  console.log();

  // Step 2: Business goals
  const businessGoals = await askMulti("What are the main improvement goals?", "e.g. Fix lint errors, Improve test coverage");
  if (businessGoals.length === 0) businessGoals.push("Improve code quality");
  console.log();

  // Step 3: Technical priorities
  const techInput = await ask("Any technical priorities? (comma-separated, or skip)", "");
  const technicalPriorities = techInput ? techInput.split(",").map(s => s.trim()).filter(Boolean) : [];
  console.log();

  // Step 4: North star
  const northStar = await ask(
    "What's the north star? (one-sentence vision of success)",
    "A clean, well-tested, maintainable codebase"
  );
  console.log();

  // Step 5: Milestones
  const milestoneNames = await askMulti("Any initial milestones?", "e.g. Fix all lint errors, 100% test pass rate");
  const milestones = milestoneNames.map((name) => ({ name, status: "pending" as const }));
  console.log();

  // Step 6: Constraints
  const constraintsInput = await ask("Any constraints? (comma-separated, or skip)", "");
  const constraints = constraintsInput ? constraintsInput.split(",").map(s => s.trim()).filter(Boolean) : [];
  console.log();

  // Build vision
  const vision: VisionDocument = {
    version: 1,
    projectDescription,
    businessGoals,
    technicalPriorities,
    userPersonas: [],
    constraints,
    northStar,
    milestones,
  };

  // Confirm
  console.log(pc.bold("\nHere's your improvement vision:"));
  console.log(`  ${pc.bold("Project:")}    ${projectDescription}`);
  console.log(`  ${pc.bold("Goals:")}       ${businessGoals.map(g => pc.green(g)).join(", ")}`);
  console.log(`  ${pc.bold("North Star:")}  ${northStar}`);
  if (milestones.length > 0) {
    console.log(`  ${pc.bold("Milestones:")}  ${milestones.map(m => pc.yellow(m.name)).join(", ")}`);
  } else {
    console.log(`  ${pc.dim("  Milestones:    (none)")}`);
  }
  console.log();

  const ok = await confirm("Save this vision and start improving?");
  if (!ok) {
    console.log(pc.yellow("\nOnboarding skipped. Run loopi again to restart.\n"));
    process.exit(0);
  }

  saveVision(vision);
  console.log(pc.green("\n✓ Vision saved to .pi/loopi/vision.json\n"));
  return vision;
}
