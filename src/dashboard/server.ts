#!/usr/bin/env node
/**
 * loopi — Web Dashboard Server
 *
 * Serves a React-based local dashboard on a random port.
 * API endpoints provide real-time pipeline state and actions.
 *
 * Endpoints:
 *   GET  /api/state     → JSON dashboard state
 *   POST /api/approve   → Approve latest feature branch
 *   POST /api/reject    → Reject latest feature branch
 *   POST /api/promote   → Promote dev → main
 *   GET  /              → Serve the dashboard HTML
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { exec } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { getPipelineProgress } from "../pipeline-runner.js";
import {
  readVision, readOpportunityHistory, readPatterns,
  readGoals, readTasks,
  approveFeatureBranch, rejectFeatureBranch, getActiveFeatureBranches,
  promoteToMain,
} from "../pipeline.js";
import { listPending, listApproved } from "../actions/pr.js";
import { loadConfig } from "../actions/config.js";
import { logger } from "../actions/logger.js";
import { store, KEYS } from "../store.js";

// ─── Dashboard HTML (embedded for zero-build portability) ───

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>loopi — Local Autonomous Improvement Agent</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117; color: #c9d1d9; padding: 20px;
    min-height: 100vh;
  }
  .container { max-width: 1200px; margin: 0 auto; }

  /* Header */
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; background: #161b22; border-radius: 8px;
    border: 1px solid #30363d; margin-bottom: 16px;
  }
  .header h1 { font-size: 20px; font-weight: 700; color: #58a6ff; }
  .header h1 span { color: #8b949e; font-weight: 400; }

  /* Status badge */
  .status {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600;
  }
  .status.idle { background: #1c2128; color: #8b949e; border: 1px solid #30363d; }
  .status.running { background: #0b2e1c; color: #3fb950; border: 1px solid #238636; }
  .status.completed { background: #0b2e1c; color: #3fb950; border: 1px solid #238636; }
  .status.failed { background: #2d1215; color: #f85149; border: 1px solid #da3633; }
  .status.nothing-to-do { background: #1c2128; color: #8b949e; border: 1px solid #30363d; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.idle { background: #8b949e; }
  .dot.running { background: #3fb950; animation: pulse 1.5s infinite; }
  .dot.completed { background: #3fb950; }
  .dot.failed { background: #f85149; }
  .dot.nothing-to-do { background: #8b949e; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Grid */
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }

  /* Panels */
  .panel {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden;
  }
  .panel-title {
    padding: 10px 16px; font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.5px; color: #8b949e; border-bottom: 1px solid #30363d;
    background: #1c2128;
  }
  .panel-body { padding: 12px 16px; }

  /* Info rows */
  .info-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; }
  .info-row .label { color: #8b949e; }
  .info-row .value { color: #c9d1d9; font-weight: 500; }

  /* Branches */
  .branch-list { list-style: none; }
  .branch-list li {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 0; border-bottom: 1px solid #21262d; font-size: 13px;
  }
  .branch-list li:last-child { border-bottom: none; }
  .branch-name { color: #58a6ff; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; }

  /* Log panel */
  .log-panel { max-height: 300px; overflow-y: auto; }
  .log-panel .panel-body { padding: 0; }
  .log-line {
    padding: 3px 16px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px;
    border-bottom: 1px solid #21262d; white-space: pre; line-height: 1.5;
  }
  .log-line:last-child { border-bottom: none; }
  .log-line.info { color: #7ee787; }
  .log-line.warn { color: #d29922; }
  .log-line.error { color: #f85149; }

  /* Action buttons */
  .actions { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 600;
    border: 1px solid #30363d; cursor: pointer; transition: all 0.15s;
    background: #21262d; color: #c9d1d9;
  }
  .btn:hover { background: #30363d; border-color: #8b949e; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: #238636; border-color: #238636; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .btn-danger { background: #da3633; border-color: #da3633; color: #fff; }
  .btn-danger:hover { background: #f85149; }
  .btn-promote { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .btn-promote:hover { background: #388bfd; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }

  /* Summary */
  .summary {
    padding: 12px 16px; background: #1c2128; border-radius: 8px;
    border: 1px solid #30363d; font-size: 13px; color: #8b949e;
    margin-bottom: 16px;
  }
  .summary span { margin-right: 16px; }
  .summary .num { color: #c9d1d9; font-weight: 600; }

  /* Error banner */
  .error-banner {
    padding: 12px 16px; background: #2d1215; border: 1px solid #da3633;
    border-radius: 8px; color: #f85149; font-size: 14px; margin-bottom: 16px;
  }

  /* Empty state */
  .empty { color: #484f58; font-size: 13px; text-align: center; padding: 16px; }

  /* Scrolling log */
  .log-scroll-btn {
    display: block; margin: 4px auto; padding: 2px 8px; font-size: 11px;
    background: #21262d; color: #8b949e; border: 1px solid #30363d;
    border-radius: 4px; cursor: pointer;
  }
  .log-scroll-btn:hover { color: #c9d1d9; }

  /* Timestamp */
  .ts { color: #484f58; font-size: 11px; margin-left: 8px; }

  /* Milestone list */
  .milestone-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 0; font-size: 13px; border-bottom: 1px solid #21262d;
  }
  .milestone-item:last-child { border-bottom: none; }
  .milestone-status { font-size: 11px; padding: 2px 8px; border-radius: 10px; }
  .milestone-status.pending { background: #1c2128; color: #8b949e; }
  .milestone-status.completed { background: #0b2e1c; color: #3fb950; }
</style>
</head>
<body>
<div class="container" id="root"></div>

<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script>
const { createElement: h, useState, useEffect, useRef, useCallback } = React;
const { createRoot } = ReactDOM;

// ─── Helpers ───

function statusClass(s) {
  const m = { idle: 'idle', running: 'running', completed: 'completed', failed: 'failed', 'nothing-to-do': 'nothing-to-do' };
  return m[s] || 'idle';
}

function logClass(line) {
  if (line.includes('[ERROR]')) return 'error';
  if (line.includes('[WARN]')) return 'warn';
  if (line.includes('[INFO]')) return 'info';
  return '';
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Polling hook ───

function usePolling(interval = 2000) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setState(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, interval);
    return () => clearInterval(id);
  }, [fetchState, interval]);

  return { state, loading, error, refetch: fetchState };
}

// ─── Action helper ───

async function postAction(action) {
  try {
    await fetch('/api/' + action, { method: 'POST' });
  } catch (e) {
    console.error('Action failed:', e);
  }
}

// ─── Components ───

function StatusBadge({ status }) {
  const cls = statusClass(status);
  return h('span', { className: 'status ' + cls },
    h('span', { className: 'dot ' + cls }),
    capitalize(status || 'idle')
  );
}

function InfoRow({ label, value, color }) {
  return h('div', { className: 'info-row' },
    h('span', { className: 'label' }, label),
    h('span', { className: 'value', style: color ? { color } : {} }, value ?? '\u2014')
  );
}

function PipelinePanel({ state }) {
  if (!state) return h('div', { className: 'empty' }, 'Waiting for data...');
  const p = state.pipeline || {};
  return h('div', { className: 'panel' },
    h('div', { className: 'panel-title' }, 'Pipeline'),
    h('div', { className: 'panel-body' },
      h(InfoRow, { label: 'Status', value: capitalize(p.status), color: p.status === 'failed' ? '#f85149' : p.status === 'running' ? '#3fb950' : '#c9d1d9' }),
      h(InfoRow, { label: 'Step', value: p.step }),
      h(InfoRow, { label: 'Message', value: p.message }),
      h(InfoRow, { label: 'Findings', value: String(p.findings ?? 0) }),
      h(InfoRow, { label: 'Patches Applied', value: String(p.patches ?? 0) }),
      h(InfoRow, { label: 'Auto-Merged', value: String(p.autoMerged ?? 0), color: '#3fb950' }),
      h(InfoRow, { label: 'Auto-Rejected', value: String(p.autoRejected ?? 0), color: p.autoRejected > 0 ? '#f85149' : '#8b949e' }),
    )
  );
}

function BranchesPanel({ state, onAction }) {
  const branches = state?.branches ?? [];
  const pendingCount = state?.pendingCount ?? 0;
  const approvedCount = state?.approvedCount ?? 0;

  return h('div', { className: 'panel' },
    h('div', { className: 'panel-title' }, 'Feature Branches'),
    h('div', { className: 'panel-body' },
      h(InfoRow, { label: 'Pending patches', value: String(pendingCount) }),
      h(InfoRow, { label: 'Approved patches', value: String(approvedCount) }),
      branches.length === 0
        ? h('div', { className: 'empty' }, 'No feature branches')
        : h('ul', { className: 'branch-list' },
            branches.slice(0, 10).map(b =>
              h('li', { key: b },
                h('span', { className: 'branch-name' }, b),
                h('span', null,
                  h('button', { className: 'btn btn-sm', style: { color: '#3fb950' }, onClick: () => { onAction('approve'); } }, '\u2713 Approve'),
                  ' ',
                  h('button', { className: 'btn btn-sm', style: { color: '#f85149' }, onClick: () => { onAction('reject'); } }, '\u2717 Reject'),
                )
              )
            )
          ),
      branches.length > 10
        ? h('div', { style: { textAlign: 'center', fontSize: 12, color: '#484f58', paddingTop: 8 } },
            '... and ' + (branches.length - 10) + ' more')
        : null,
    )
  );
}

function QuestionsPanel({ questions, onAnswer }) {
  const [answers, setAnswers] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  if (!questions || questions.length === 0) return null;

  return h('div', { className: 'panel', style: { gridColumn: '1 / -1', border: '2px solid #d29922' } },
    h('div', { className: 'panel-title', style: { color: '#d29922' } },
      '\u2753 Agent Needs Clarification'
    ),
    h('div', { className: 'panel-body' },
      h('p', { style: { fontSize: 13, color: '#8b949e', margin: '0 0 12px 0' } },
        'The agent needs more information to generate milestones from your vision:'
      ),
      questions.map((q, i) =>
        h('div', { key: i, style: { marginBottom: 10 } },
          h('label', { style: { display: 'block', fontSize: 13, color: '#c9d1d9', marginBottom: 4 } },
            q
          ),
          h('input', {
            type: 'text',
            placeholder: 'Your answer...',
            style: {
              width: '100%', padding: '6px 10px', fontSize: 13, borderRadius: 4,
              border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9',
              outline: 'none', boxSizing: 'border-box',
            },
            onInput: (e) => {
              const next = [...answers];
              next[i] = e.target.value;
              setAnswers(next);
            },
          })
        )
      ),
      h('button', {
        className: 'btn btn-primary',
        disabled: submitting || answers.length < questions.length || answers.some(a => !a?.trim()),
        onClick: async () => {
          setSubmitting(true);
          await fetch('/api/answer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answers }),
          });
          setSubmitting(false);
        },
      }, submitting ? 'Sending...' : 'Submit Answers'),
    )
  );
}

function OpportunitiesPanel({ state }) {
  const opps = state?.opportunities ?? [];
  if (!opps.length) return null;

  const byStatus = {};
  opps.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });

  const statusColor = { suggested: '#8b949e', accepted: '#58a6ff', applied: '#3fb950', rejected: '#f85149' };

  return h('div', { className: 'panel' },
    h('div', { className: 'panel-title' }, 'Opportunities (' + opps.length + ')'),
    h('div', { className: 'panel-body', style: { maxHeight: 200, overflowY: 'auto' } },
      h('div', { style: { display: 'flex', gap: 12, marginBottom: 8, fontSize: 12 } },
        Object.entries(byStatus).map(([s, c]) =>
          h('span', { key: s, style: { color: statusColor[s] || '#8b949e' } },
            capitalize(s) + ': ' + c
          )
        )
      ),
      opps.slice(0, 15).map(o =>
        h('div', {
          key: o.id || o.title,
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12, borderBottom: '1px solid #21262d' }
        },
          h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: statusColor[o.status] || '#8b949e', flexShrink: 0 } }),
          h('span', { style: { flex: 1, color: '#c9d1d9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            (o.title || '').slice(0, 50)
          ),
          h('span', { style: { fontSize: 10, color: '#484f58' } }, o.status),
        )
      ),
      opps.length > 15
        ? h('div', { style: { textAlign: 'center', fontSize: 11, color: '#484f58', paddingTop: 4 } },
            '... and ' + (opps.length - 15) + ' more')
        : null,
    )
  );
}

function PatternsPanel({ state }) {
  const patterns = state?.patterns ?? [];
  if (!patterns.length) return null;

  const applied = patterns.filter(p => p.outcome === 'applied').length;
  const suggested = patterns.filter(p => p.outcome === 'suggested').length;

  return h('div', { className: 'panel' },
    h('div', { className: 'panel-title' }, 'Patterns (' + patterns.length + ')'),
    h('div', { className: 'panel-body', style: { maxHeight: 200, overflowY: 'auto' } },
      h('div', { style: { fontSize: 12, color: '#8b949e', marginBottom: 6 } },
        'Applied: ' + applied + ' | Suggested: ' + suggested
      ),
      patterns.slice(0, 10).map(p =>
        h('div', {
          key: p.id || p.summary,
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12, borderBottom: '1px solid #21262d' }
        },
          h('span', { style: { color: p.outcome === 'applied' ? '#3fb950' : '#8b949e' } },
            p.outcome === 'applied' ? '\u2713' : '\u25CB'
          ),
          h('span', { style: { flex: 1, color: '#c9d1d9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            (p.summary || '').slice(0, 50)
          ),
          p.tags && p.tags.length
            ? h('span', { style: { fontSize: 10, color: '#484f58' } }, p.tags.slice(0, 2).join(', '))
            : null,
        )
      ),
      patterns.length > 10
        ? h('div', { style: { textAlign: 'center', fontSize: 11, color: '#484f58', paddingTop: 4 } },
            '... and ' + (patterns.length - 10) + ' more')
        : null,
    )
  );
}

function LogPanel({ logs, logRef }) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const innerRef = useRef(null);

  // Scroll to bottom when new logs arrive (if auto-scroll is enabled)
  useEffect(() => {
    if (autoScroll && innerRef.current) {
      innerRef.current.scrollTop = innerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Combine refs
  const setRef = useCallback(el => {
    innerRef.current = el;
    if (logRef) logRef.current = el;
  }, [logRef]);

  const filteredLogs = searchTerm
    ? (logs || []).filter(l => l.toLowerCase().includes(searchTerm.toLowerCase()))
    : logs || [];

  return h('div', { className: 'panel', style: { gridColumn: '1 / -1' } },
    h('div', { className: 'panel-title', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
      h('span', null, 'Log (' + (logs?.length ?? 0) + ' lines' +
        (searchTerm ? ', showing ' + filteredLogs.length : '') + ')'),
      h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('input', {
          type: 'text',
          placeholder: 'Filter logs...',
          value: searchTerm,
          onInput: (e) => setSearchTerm(e.target.value),
          style: {
            padding: '2px 8px', fontSize: 12, borderRadius: 4, border: '1px solid #30363d',
            background: '#0d1117', color: '#c9d1d9', width: 140, outline: 'none',
          }
        }),
        h('button', {
          className: 'log-scroll-btn',
          onClick: () => setAutoScroll(!autoScroll)
        }, autoScroll ? 'Auto ON' : 'Auto OFF'),
      ),
    ),
    h('div', {
      className: 'log-panel panel-body', ref: setRef,
      style: { maxHeight: '400px', overflowY: 'auto' }
    },
      (!filteredLogs || filteredLogs.length === 0)
        ? h('div', { className: 'empty' }, searchTerm ? 'No logs match filter' : 'No log entries yet')
        : filteredLogs.map((line, i) =>
            h('div', { key: i, className: 'log-line ' + logClass(line) }, line)
          ),
    )
  );
}

function VisionPanel({ state }) {
  const v = state?.vision;
  if (!v) return null;
  return h('div', { className: 'panel', style: { gridColumn: '1 / -1' } },
    h('div', { className: 'panel-title' }, '\uD83C\uDF0D Vision'),
    h('div', { className: 'panel-body' },
      v.northStar
        ? h('div', { className: 'info-row' },
            h('span', { className: 'label' }, 'North Star'),
            h('span', { className: 'value', style: { color: '#58a6ff', fontStyle: 'italic' } }, v.northStar)
          )
        : null,
      h('div', { className: 'info-row' },
        h('span', { className: 'label' }, 'Description'),
        h('span', { className: 'value' }, v.projectDescription || '')
      ),
      v.businessGoals && v.businessGoals.length > 0
        ? h('div', { style: { paddingTop: 4, fontSize: 13, color: '#8b949e' } },
            'Goals: ' + v.businessGoals.join(', ')
          )
        : null,
    )
  );
}

function HierarchyPanel({ state }) {
  const milestones = state?.milestones ?? [];
  const goals = state?.goals ?? [];
  const tasks = state?.tasks ?? [];
  if (!milestones.length && !goals.length && !tasks.length) return null;

  const activeMilestone = milestones.find(m => m.status === 'in_progress' || m.status === 'pending');
  const activeMilestoneIdx = milestones.indexOf(activeMilestone || milestones[0]);

  return h('div', { className: 'panel', style: { gridColumn: '1 / -1' } },
    h('div', { className: 'panel-title' },
      '\uD83D\uDCCB Milestones \u2192 Goals \u2192 Tasks'
    ),
    h('div', { className: 'panel-body', style: { maxHeight: 260, overflowY: 'auto' } },
      milestones.length === 0
        ? h('div', { className: 'empty' }, 'No milestones yet \u2014 vision may not be set up')
        : milestones.map((m, mi) => {
            const mGoals = goals.filter(g => g.milestoneIndex === mi);
            const isActive = m.status === 'in_progress';
            const isDone = m.status === 'completed';
            const expanded = isActive || (mi === activeMilestoneIdx);

            return h('div', { key: mi, style: { marginBottom: 8 } },
              h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px', borderRadius: 6,
                  background: isActive ? '#0b2e1c' : isDone ? '#1c2128' : 'transparent',
                  border: isActive ? '1px solid #238636' : '1px solid transparent',
                  fontSize: 14, fontWeight: 600,
                }
              },
                h('span', { style: { color: isDone ? '#3fb950' : isActive ? '#3fb950' : '#58a6ff' } },
                  isDone ? '\u2713' : isActive ? '\u25B6' : '\u25CB'
                ),
                h('span', { style: { flex: 1 } }, m.name || m.id),
                m.status
                  ? h('span', {
                      style: { fontSize: 11, padding: '2px 8px', borderRadius: 10, background: isDone ? '#0b2e1c' : '#1c2128', color: isDone ? '#3fb950' : '#8b949e' }
                    }, isDone ? 'Done' : isActive ? 'In Progress' : 'Pending')
                  : null,
              ),
              expanded && mGoals.length > 0
                ? h('div', { style: { paddingLeft: 24, paddingTop: 4 } },
                    mGoals.map(g => {
                      const gTasks = tasks.filter(t => t.goalId === g.id);
                      const gDone = g.status === 'completed';
                      const gActive = g.status === 'in_progress';
                      return h('div', { key: g.id, style: { marginBottom: 4 } },
                        h('div', {
                          style: {
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '4px 6px', borderRadius: 4,
                            fontSize: 13, color: gDone ? '#8b949e' : gActive ? '#7ee787' : '#c9d1d9',
                          }
                        },
                          h('span', { style: { color: gDone ? '#3fb950' : '#8b949e' } }, gDone ? '\u2713' : '\u25CB'),
                          h('span', { style: { flex: 1 } }, g.name || 'Goal'),
                          g.priority === 'high' ? h('span', { style: { fontSize: 10, color: '#f85149' } }, 'HIGH') : null,
                          h('span', { style: { fontSize: 11, color: gDone ? '#3fb950' : '#8b949e' } },
                            gDone && g.completedAt ? new Date(g.completedAt).toLocaleDateString() : ''
                          ),
                        ),
                        gTasks.length > 0
                          ? h('div', { style: { paddingLeft: 20, paddingTop: 2 } },
                              gTasks.map(t => {
                                const tDone = t.status === 'completed';
                                const tFailed = t.status === 'failed';
                                return h('div', {
                                  key: t.id,
                                  style: {
                                    display: 'flex', alignItems: 'center', gap: 4,
                                    padding: '2px 4px', fontSize: 12,
                                    color: tDone ? '#484f58' : tFailed ? '#f85149' : '#8b949e',
                                  }
                                },
                                  h('span', null, tDone ? '\u2713' : tFailed ? '\u2717' : '\u2022'),
                                  h('span', { style: { flex: 1 } }, (t.name || '').slice(0, 60)),
                                  t.impact === 'high' ? h('span', { style: { fontSize: 10, color: '#f85149' } }, '!') : null,
                                );
                              })
                            )
                          : null,
                      );
                    })
                  )
                : null,
            );
          })
    )
  );
}

// ─── App ───

function App() {
  const { state, loading, error, refetch } = usePolling(2000);
  const logRef = useRef(null);

  const handleAction = useCallback(async (action) => {
    await postAction(action);
    setTimeout(refetch, 500);
  }, [refetch]);

  if (loading && !state) {
    return h('div', { style: { textAlign: 'center', paddingTop: '40vh', color: '#8b949e' } },
      h('div', { style: { fontSize: 24, marginBottom: 8 } }, '\u26A1'),
      h('div', { style: { fontSize: 14 } }, 'Connecting to loopi...'),
    );
  }

  const pipeline = state?.pipeline || {};
  const errorMsg = pipeline?.error;

  return h('div', null,

    // Header
    h('div', { className: 'header' },
      h('h1', null, '\u26A1 loopi', h('span', null, ' \u2014 Local Autonomous Improvement Agent')),
      h(StatusBadge, { status: pipeline?.status || 'idle' }),
    ),

    // Actions
    h('div', { className: 'actions' },
      h('button', { className: 'btn btn-primary', onClick: () => handleAction('approve') }, '\u2713 Approve Latest'),
      h('button', { className: 'btn btn-danger', onClick: () => handleAction('reject') }, '\u2717 Reject Latest'),
      h('button', { className: 'btn btn-promote', onClick: () => handleAction('promote') }, '\u2191 Promote dev \u2192 main'),
      h('button', { className: 'btn', onClick: () => refetch() }, '\u21BB Refresh'),
    ),

    // Error banner
    errorMsg
      ? h('div', { className: 'error-banner' }, '\u26A0\uFE0F ' + errorMsg)
      : null,

    // Summary
    state
      ? h('div', { className: 'summary' },
          h('span', null, 'Cycle: ', h('span', { className: 'num' }, String(state.cycleNumber ?? 0))),
          h('span', null, 'Findings: ', h('span', { className: 'num' }, String(state.pipeline?.findings ?? 0))),
          h('span', null, 'Branches: ', h('span', { className: 'num' }, String(state.branches?.length ?? 0))),
          h('span', null, 'Opportunities: ', h('span', { className: 'num' }, String(state.opportunities?.length ?? 0))),
          h('span', null, 'Patterns: ', h('span', { className: 'num' }, String(state.patterns?.length ?? 0))),
          h('span', null, 'Log lines: ', h('span', { className: 'num' }, String(state.logs?.length ?? 0))),
          state.lastRefresh
            ? h('span', { className: 'ts' }, 'Last updated: ' + new Date(state.lastRefresh).toLocaleTimeString())
            : null,
        )
      : null,

    // Vision
    h(VisionPanel, { state }),

    // Hierarchy: Milestones -> Goals -> Tasks
    h(HierarchyPanel, { state }),

    // Grid
    h('div', { className: 'grid' },
      h(PipelinePanel, { state }),
      h(BranchesPanel, { state, onAction: handleAction }),
      h(OpportunitiesPanel, { state }),
      h(PatternsPanel, { state }),
    ),

    // Questions (full width, only when pending)
    state?.pendingQuestions
      ? h(QuestionsPanel, { questions: state.pendingQuestions, onAnswer: handleAction })
      : null,

    // Log (full width at bottom)
    h(LogPanel, { logs: state?.logs ?? [], logRef }),
  );
}

const root = createRoot(document.getElementById('root'));
root.render(h(App));
</script>
</body>
</html>`;

// ─── State collector ───

function collectApiState(): Record<string, unknown> {
  const prog = getPipelineProgress();

  // Feature branches
  let prefix = "loopi/";
  try {
    const cfg = loadConfig();
    if (cfg?.git?.branchPrefix) prefix = cfg.git.branchPrefix;
  } catch { /* use default */ }
  const branches: string[] = [];
  try {
    const refsDir = resolve(process.cwd(), ".git/refs/heads");
    if (existsSync(refsDir)) {
      const all = readdirSync(refsDir).filter(f => f.startsWith(prefix)).sort().reverse();
      branches.push(...all);
    }
  } catch { /* ignore */ }

  // Logs — send ALL lines (browser handles scrolling)
  const logs: string[] = [];
  try {
    const logDir = resolve(process.cwd(), ".pi/loopi/logs");
    if (existsSync(logDir)) {
      const files = readdirSync(logDir).filter(f => f.endsWith(".log")).sort().reverse();
      if (files.length > 0) {
        const content = readFileSync(resolve(logDir, files[0]!), "utf-8").trim().split("\n");
        logs.push(...content);
      }
    }
  } catch { /* ignore */ }

  // Workflow counts
  let pendingCount = 0;
  let approvedCount = 0;
  try { pendingCount = listPending().length; } catch { /* ignore */ }
  try { approvedCount = listApproved().length; } catch { /* ignore */ }

  // Vision, milestones, goals, tasks
  let visionData: Record<string, unknown> | null = null;
  let milestones: Array<Record<string, unknown>> = [];
  let goals: Array<Record<string, unknown>> = [];
  let tasks: Array<Record<string, unknown>> = [];
  try {
    const v = readVision();
    if (v) {
      visionData = {
        projectDescription: v.projectDescription,
        northStar: v.northStar ?? "",
        businessGoals: v.businessGoals ?? [],
      };
      milestones = (v.milestones ?? []) as Array<Record<string, unknown>>;
    }
  } catch { /* ignore */ }
  try { goals = readGoals() as unknown as Array<Record<string, unknown>>; } catch { /* ignore */ }
  try { tasks = readTasks() as unknown as Array<Record<string, unknown>>; } catch { /* ignore */ }

  // Opportunities (full history)
  let opportunities: Array<Record<string, unknown>> = [];
  let activeOpportunity = "";
  try {
    opportunities = readOpportunityHistory() as unknown as Array<Record<string, unknown>>;
    const active = opportunities.find(o => o.status === "accepted" || o.status === "suggested");
    if (active) activeOpportunity = (active.title as string) || "";
  } catch { /* ignore */ }

  // Patterns (full list)
  let patterns: Array<Record<string, unknown>> = [];
  try { patterns = readPatterns() as unknown as Array<Record<string, unknown>>; } catch { /* ignore */ }

  // Pipeline metrics
  const pipelineMetrics: Record<string, unknown> = {
    status: prog.status,
    step: prog.step || "",
    message: prog.message || "",
    findings: prog.findings ?? 0,
    patches: prog.patches ?? 0,
    autoMerged: prog.autoMerged ?? 0,
    autoRejected: prog.autoRejected ?? 0,
    error: prog.error ?? null,
  };
  if (prog.status === "running" && prog.step) {
    pipelineMetrics.duration = Date.now(); // start time for elapsed calc
  }

  return {
    pipeline: pipelineMetrics,
    cycleNumber: prog.status === "running" || prog.status === "completed" ? 1 : 0,
    branches,
    pendingCount,
    approvedCount,
    logs,
    vision: visionData,
    milestones,
    goals,
    tasks,
    opportunities,
    patterns,
    activeOpportunity: activeOpportunity || null,
    pendingQuestions: store.get(KEYS.PENDING_QUESTIONS) ?? null,
    lastRefresh: Date.now(),
  };
}

// ─── Server ───

export interface DashboardServer {
  port: number;
  close: () => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Start the web dashboard server on a random available port.
 * Auto-opens the browser when ready.
 *
 * @returns The server port and close function.
 */
export async function startDashboard(
  onAction?: (action: string) => void
): Promise<DashboardServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
        const path = url.pathname;

        // ── API routes ──
        if (path === "/api/state" && req.method === "GET") {
          const data = collectApiState();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
          return;
        }

        if (path === "/api/approve" && req.method === "POST") {
          if (onAction) { onAction("approve"); } else {
            const branches = await getActiveFeatureBranches(".");
            if (branches.length > 0) {
              await approveFeatureBranch(branches[0]!, ".");
              logger.info(`Approved: merged ${branches[0]} into dev`);
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (path === "/api/reject" && req.method === "POST") {
          if (onAction) { onAction("reject"); } else {
            const branches = await getActiveFeatureBranches(".");
            if (branches.length > 0) {
              await rejectFeatureBranch(branches[0]!, ".");
              logger.info(`Rejected: deleted ${branches[0]}`);
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (path === "/api/promote" && req.method === "POST") {
          if (onAction) { onAction("promote"); } else {
            await promoteToMain(".");
            logger.info("Promoted dev → main.");
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (path === "/api/answer" && req.method === "POST") {
          // Read body for answers array
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const answers = body.answers as string[];
          if (answers && answers.length > 0) {
            store.set(KEYS.PENDING_ANSWERS, answers);
            logger.info(`Received ${answers.length} answer(s) for pending questions.`);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // ── Root → serve dashboard HTML ──
        if (path === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(DASHBOARD_HTML);
          return;
        }

        // ── 404 ──
        res.writeHead(404);
        res.end("Not found");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    });

    // Listen on port 0 for random available port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      // Auto-open browser
      const url = `http://127.0.0.1:${port}`;
      const cmd =
        process.platform === "win32"
          ? `start "" "${url}"`
          : process.platform === "darwin"
            ? `open "${url}"`
            : `xdg-open "${url}"`;
      exec(cmd, () => { /* best effort */ });

      resolve({ port, close: () => server.close() });
    });

    server.on("error", (err) => {
      reject(new Error(`Dashboard server failed: ${err.message}`));
    });
  });
}
