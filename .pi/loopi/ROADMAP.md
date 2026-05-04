# loopi Roadmap

> Based on codebase audit (2026-05-04) + ruflo analysis (2026-05-04)

---

## Phase 1 — Pattern Memory (Tiny, high-impact)

**Problem:** Every improvement cycle starts from scratch. The opportunity agent doesn't know what worked before, so it may repeat failed approaches or miss patterns that succeeded.

**Solution:** Add a lightweight `patterns.json` — a simple JSON array of successful improvement records. The docs agent (or reviewer) writes to it after each approved patch. The opportunity agent reads it to prioritize similar opportunities.

**Changes needed:**
- `src/pipeline.ts` — Add `savePattern()` / `readPatterns()` (analogous to `saveVision`/`readVision`, ~10 lines each)
- Update docs agent prompt (`agents/docs-agent.md`) to append to patterns after a patch
- Update opportunity agent prompt (`agents/opportunity-agent.md`) to query patterns when scoring opportunities
- Types: Add `Pattern` interface to `src/types/index.ts`

**Files touched:** 4  
**Estimate:** ~1 hour  
**Risk:** None — purely additive, no behavior changes

---

## Phase 2 — Cross-Session Horizon Tracking (Medium)

**Problem:** The vision doc is static. After 10 improvement cycles, the opportunity agent can't tell what's been done vs what remains toward the north star.

**Solution:** Add milestone checkpoints to the vision doc. When a patch is approved, the docs agent marks the relevant milestone as partially/fully complete. The opportunity agent uses this to deprioritize completed goals.

**Changes needed:**
- Update `VisionDocument` type in `src/types/index.ts` — add optional `milestones: { name, status, doneAt? }[]`
- Update docs agent prompt to update milestone status on approved patches
- Update opportunity agent prompt to skip or deprioritize completed milestones
- Small tweak to `readVision`/`saveVision` — no new functions needed

**Files touched:** 3 (types, two agent prompts)  
**Estimate:** ~1.5 hours  
**Risk:** Low — backward compatible (milestones field is optional)

---

## Phase 3 — Polish & Hardening (Small fixes)

**Problem:** A few rough edges remain from the audit.

**Solution:** Fix the remaining minor issues:

- **H1 (retry guidance):** The PIPELINE_SPEC template literal already has a comment about retries, but make it actionable — add a concrete retry strategy (3 attempts with exponential backoff).
- **Dashboard startup:** `loopi dashboard` currently loads config and reads files synchronously. Show a spinner or "Loading..." state if there's a delay.
- **Error messages:** Make error messages more user-friendly (hide stack traces from end users, show them only in debug mode).

**Files touched:** 2 (pipeline spec in `src/pipeline.ts`, dashboard in `src/tui/dashboard.ts`)  
**Estimate:** ~1 hour  
**Risk:** None

---

## Phase 4 — Feedback Loop Demo (Nice-to-have)

**Problem:** Hard to tell if loopi is working without watching the TUI.

**Solution:** Add a `summary` sub-command (or just have the default `loopi` output a brief status after printing the pipeline spec):

```
loopi status summary:
  ✓ Vision set (updated 2 days ago)
  ✓ 3 opportunities pending
  ⚠ 1 patch awaiting approval (dashboard to review)
  ✓ Last cycle: 2 hours ago → success (fixed ESLint warnings)
```

**Changes needed:**
- Add `showSummary()` to `src/cli.ts` — reads vision, pending count, last pattern
- Called at the end of the default `loopi` command

**Files touched:** 1 (`src/cli.ts`)  
**Estimate:** ~30 min  
**Risk:** None

---

## Not Doing (Rejected from ruflo analysis)

| Feature | Why not |
|---------|---------|
| Plugin system | Loopi should stay monolithic. Plugins add complexity without benefit for a single-purpose tool. |

## Status

- **Phase 1 ✅** — Pattern memory added (2026-05-04)
- **Phase 2** — ❌ Not started
- **Phase 3** — ❌ Not started
- **Phase 4** — ❌ Not started
| More agents | 8 agents is the right number. Each has a clear role. |
| Vector memory / HNSW | A JSON file is sufficient for pattern storage at loopi's scale. |
| Federation / multi-machine | Loopi improves one repo. That's the scope. |
| Worktree isolation | Feature branches already provide isolation. Worktrees add complexity. |
| CLI expansion | 3 commands is a feature, not a limitation. |

---

## Timeline

```
Phase 1 ────────▓ (now — 1hr)
Phase 2 ────────────▓ (after Phase 1 — 1.5hr)
Phase 3 ────────────────▓ (after Phase 2 — 1hr)
Phase 4 ────────────────────▓ (after Phase 3 — 0.5hr)
```

Total: ~4 hours of work. Each phase is independent — can stop anytime.
