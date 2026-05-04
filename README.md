# loopi

**Local Autonomous Improvement Agent** — a self-improving bot that continuously steers a codebase toward a strategic vision.

loopi is available as a pnpm package. Run it in any repository:

```bash
pnpx @rkhatkhede/loopi              # Auto-init + print pipeline spec (default)
pnpx @rkhatkhede/loopi dashboard   # Open the live TUI dashboard
pnpx @rkhatkhede/loopi install     # Install loopi agents globally
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
- `loopi promote` merges `dev → main` to finalize a session
- `main` stays clean until explicitly promoted

## How It Works

1. **Install** (one-time): `loopi install` copies 8 agent `.md` files to `~/.pi/agent/agents/`
2. **Run**: `loopi` (no args) auto-inits if needed, then prints the pipeline spec for pi to execute
3. **Dashboard**: `loopi dashboard` — TUI with approve/reject/promote built in via keybindings

The pipeline runs inside your pi coding assistant. The pi agent reads
`src/pipeline.ts` and executes each step using `subagent()` and `bash`.

## Getting Started

```bash
# Install globally (one time)
pnpm install -g @rkhatkhede/loopi

# Or run without installing (pnpx auto-downloads)
cd your-project
pnpx @rkhatkhede/loopi              # Auto-inits + prints pipeline spec
pnpx @rkhatkhede/loopi dashboard   # Open the live TUI dashboard
```

## Configuration

`.pi/loopi/config.json` (auto-created by `loopi init`):

```json
{
  "projectName": "loopi",
  "runFrequencyMinutes": 30,
  "humanGate": {
    "enabled": true,
    "timeoutMinutes": 60,
    "autoRejectOnTimeout": true
  },
  "constraints": {
    "maxFilesPerPatch": 3,
    "maxPatchSizeLines": 500,
    "forbiddenDirectories": ["node_modules", "dist", "build", ".git"]
  }
}
```

Config is optional — loopi uses sensible defaults if no file exists.

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
.pi/agents/          → 8 pi.dev agent definitions (self-targeting)
agents/              → Bundled agent files (for `loopi install`)
src/
├── cli.ts           → CLI entry point
├── pipeline.ts      → Orchestration spec + utility functions
├── actions/         → Git, config, logger, PR workflow, install, init
├── tui/             → TUI dashboard
├── types/           → Zod schemas for runtime validation
tests/               → Vitest test suite
.pi/loopi/           → Per-repo state (auto-created by `loopi init`)
  ├── config.json
  ├── vision.json
  ├── opportunity-history.json
  └── workflows/
```

## License

MIT
