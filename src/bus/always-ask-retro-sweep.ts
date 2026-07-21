/**
 * G1 retro-sweep companion (boss 1784652695327). The always_ask enforcement is
 * a FORWARD guard — it gates tasks created AFTER it ships. A forward guard is
 * not retro remediation: money-path tasks that predate it were never gated.
 *
 * This sweep SURFACES those candidates; it does NOT auto-gate them. Why not
 * auto-gate: pre-guard tasks carry no `category` field (category is a
 * create-time parameter, not stored), so the sweep can only guess a category
 * from title/description signals. Auto-assigning a gate from a keyword match
 * would (a) false-positive gate innocent tasks and (b) false-negative miss
 * euphemistically-worded ones — and picking a category from a heuristic IS the
 * guess that refuse-the-unlisted forbids. So the sweep reports candidates for a
 * HUMAN to categorize (or dismiss), the same shape as "unclassifiable goes UP,
 * never silently disposed."
 *
 * Read-only: reads the task dir, writes nothing.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths, Task, ApprovalCategory } from '../types/index.js';

export interface RetroSweepCandidate {
  taskId: string;
  title: string;
  status: string;
  createdBy: string;
  createdAt: string;
  /** The money-path signal words that matched, so a human can judge quickly. */
  signals: string[];
  /** The category the signals SUGGEST — a hint for the human, never applied. */
  suggestedCategory: ApprovalCategory;
}

/**
 * Money-path signal words per category. Deliberately conservative and
 * transparent — a human reads the matched signals and decides. Not exhaustive
 * (euphemisms and novel phrasings will slip past keyword matching); that
 * limitation is exactly why the output is a candidate list for review, not an
 * auto-gate.
 */
const SIGNALS: ReadonlyArray<[ApprovalCategory, RegExp]> = [
  ['financial', /\b(pay(ment|out|able)?|wire|transfer|invoice|remit|refund|\$\d|deposit|disburse|voucher)\b/i],
  ['deployment', /\b(deploy|release|ship\s+to\s+prod|push\s+to\s+prod|production\s+(cut|rollout)|go\s*live)\b/i],
  ['data-deletion', /\b(delete|drop\s+table|truncate|purge|wipe|destroy|remove\s+(all|the)\b|hard[- ]delete)\b/i],
  ['external-comms', /\b(email|send\s+(to|the)\b|telegram\s+(cody|the\s+customer|vendor)|reply\s+to\s+the\s+(customer|vendor|client)|outbound)\b/i],
];

function scoreTask(title: string, description: string): { signals: string[]; category: ApprovalCategory } | null {
  const hay = `${title}\n${description}`;
  for (const [category, re] of SIGNALS) {
    const m = hay.match(re);
    if (m) return { signals: [m[0]], category };
  }
  return null;
}

/**
 * Scan open (non-terminal, non-gated) tasks for money-path candidates that
 * predate the guard. Returns a review list; writes nothing.
 */
export function retroSweepAlwaysAsk(paths: BusPaths): RetroSweepCandidate[] {
  if (!existsSync(paths.taskDir)) return [];
  const out: RetroSweepCandidate[] = [];
  for (const file of readdirSync(paths.taskDir)) {
    if (!file.endsWith('.json')) continue;
    let task: Task;
    try {
      task = JSON.parse(readFileSync(join(paths.taskDir, file), 'utf-8'));
    } catch {
      continue; // corrupt — skip, surfaced elsewhere
    }
    // Skip terminal tasks and anything already gated (has an approval linked).
    if (task.status === 'completed' || task.status === 'cancelled' || task.archived) continue;
    if (task.approval_id) continue; // already gated by the forward guard
    const hit = scoreTask(task.title || '', task.description || '');
    if (!hit) continue;
    out.push({
      taskId: task.id,
      title: task.title,
      status: task.status,
      createdBy: task.created_by,
      createdAt: task.created_at,
      signals: hit.signals,
      suggestedCategory: hit.category,
    });
  }
  return out;
}
