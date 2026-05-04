# loopi

**Local Autonomous Improvement Agent** — a self-improving bot that continuously steers a codebase toward a strategic vision.

```
pnpm loopi                → Print pipeline spec for pi agent to execute
pnpm loopi status         → Show current system state
pnpm loopi dashboard      → Open the live TUI dashboard
pnpm loopi approve        → Apply the latest pending diff (merges into dev)
pnpm loopi reject         → Discard the latest pending diff
pnpm loopi init           → Initialize the vision document
pnpm loopi promote        → Merge dev → main (end of session)
pnpm loopi --target ../.. → Target a sibling repository
```

## Architecture

loopi uses **pi.dev agents** for all intelligent work and **TypeScript** for
orchestration + mechanical operations.

```
┌──────────────────────────────────────────────────┐
│                    PIPELINE                       │
│                                                    │
│  Vision ─→ Opportunity ─→ Scout ─→ Analyze        │
│     ↑                              ↓              │
│     │                         Planner             │
│     │                              ↓              │
│     │                         Patch Agent         │
│     │                              ↓              │
│     │                         Reviewer            │
│     │                              ↓              │
│     │                    ╔═══════════════╗        │
│     │                    ║  Human Gate   ║        │
│     │                    ╚═══════════════╝        │
│     │                        ↓                    │
│     │                    Apply → Docs             │
│     └────────────────────┘                        │
└──────────────────────────────────────────────────┘
```

### The 8 Agents

| Agent | Role |
|-------|------|
| **vision-agent** | Establishes strategic direction — purpose, goals, north star |
| **opportunity-agent** | Identifies concrete opportunities (features, revenue, growth) |
| **scout-agent** | Deep codebase reconnaissance for a chosen opportunity |
| **analysis-agent** | Focused deep-dive analysis of specific code areas |
| **planner-agent** | Creates step-by-step improvement plans |
| **patch-agent** | Generates actual code changes from plans |
| **reviewer-agent** | Reviews diffs for safety, correctness, test impact |
| **docs-agent** | Syncs README, changelog after patches |

### Branch Workflow

```
main ─── A ── B ── B'  (promote → main when session is done)
          \
           dev ── D1 ── D2 ── D3  (all approved patches)
                    │         ↑
                    │         │ (merge --ff-only)
                    │         │
                    └─ loopi/fix-xyz ── commit ──┘
                              ← apply diff here →
```

- All approved patches merge into `dev` via ephemeral feature branches
- `pnpm loopi promote` merges `dev → main` to finalize a session
- `main` stays clean until explicitly promoted

## Getting Started

```bash
# Clone the repo
git clone <repo-url>
cd loopi

# Install dependencies
pnpm install

# Build
pnpm build

# Initialize vision document
pnpm loopi init

# Check status
pnpm loopi status

# Open the TUI dashboard
pnpm loopi dashboard
```

The pipeline runs inside your pi coding assistant. The pi agent reads
`agent/src/pipeline.ts` and executes each step using `subagent()` and `bash`.

## Configuration

`agent/agent.config.json`:

```json
{
  "projectName": "loopi",
  "runFrequencyMinutes": 30,
  "humanGate": {
    "enabled": true,
    "requireApproval": true,
    "notificationMethod": "contact_supervisor"
  },
  "constraints": {
    "maxFilesPerPatch": 3,
    "maxPatchSizeLines": 500,
    "forbiddenDirectories": ["node_modules", "dist", "build", ".git"]
  }
}
```

## Development

```bash
pnpm build       # Compile TypeScript
pnpm test        # Run tests
pnpm test:watch  # Watch mode
pnpm lint        # Type check only
pnpm clean       # Remove dist/
```

## Project Structure

```
.pi/agents/          → 8 pi.dev agent definitions
agent/
├── index.ts         → CLI entry point
├── agent.config.json→ Configuration
├── src/
│   ├── actions/     → Git, config, logger, PR workflow
│   ├── tui/         → TUI dashboard
│   ├── types/       → Zod schemas for runtime validation
│   ├── workers/     → Mechanical helpers (patch generation)
│   └── pipeline.ts  → Orchestration spec + utility functions
├── tests/           → Vitest test suite
└── workflows/       → Pending / approved diffs
```

## License

MIT
