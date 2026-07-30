import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Approval, ApprovalCategory, ApprovalStatus, BusPaths, Task } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { parseEnvFile } from '../utils/env.js';
import { randomString } from '../utils/random.js';
import { validateApprovalCategory } from '../utils/validate.js';
import { TelegramAPI } from '../telegram/api.js';
import { sendMessage } from './message.js';
import { postActivity } from './system.js';

/**
 * Build the inline keyboard posted to the activity channel alongside a
 * newly-created approval. Two buttons (Approve / Deny) with callback_data
 * keyed on the approval id so fast-checker's activity-channel callback
 * handler can route them to updateApproval.
 */
function buildApprovalKeyboard(approvalId: string): object {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `appr_allow_${approvalId}` },
      { text: '❌ Deny', callback_data: `appr_deny_${approvalId}` },
    ]],
  };
}

/**
 * Post a newly-created approval to the org's activity channel with
 * Approve/Deny inline buttons. Returns a promise that resolves once the
 * post attempt has settled.
 *
 * Path resolution: activity-channel.env lives under the FRAMEWORK root
 * (frameworkRoot/orgs/<org>/activity-channel.env), NOT the runtime state
 * dir (ctxRoot/orgs/<org>/). The earlier version of this helper used
 * paths.ctxRoot to derive orgDir, which silently resolved to the wrong
 * filesystem root and caused every activity-channel post to fail as
 * "not configured" — a bug that hid for hours because of the silent
 * .catch below. Fallback chain is now: explicit frameworkRoot arg →
 * process.env.CTX_FRAMEWORK_ROOT → SKIP WITH WARN (no further fallback;
 * the paths.ctxRoot fallback that caused the original bug was removed
 * deliberately per post-incident review — silently using a known-wrong
 * path is worse than skipping loudly).
 *
 * Errors from postActivity (thrown rejections) are suppressed so
 * activity-channel unreachability does not block approval creation. The
 * "not configured" signal (postActivity returns false) is now logged as
 * a visible warn — preserves the best-effort behavior but surfaces
 * misconfiguration immediately instead of debugging it silently.
 *
 * The returned promise MUST be awaited by the caller in short-lived
 * contexts (CLI action handlers) or the process may exit before the
 * underlying fetch completes and the post silently never sends.
 */
function postApprovalToActivityChannel(
  paths: BusPaths,
  org: string,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
  frameworkRoot: string | undefined,
): Promise<void> {
  const root = frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT;
  if (!root) {
    console.warn(
      `[approval] No frameworkRoot available for ${approvalId} — skipping activity-channel post. ` +
      `Set CTX_FRAMEWORK_ROOT env var or pass frameworkRoot explicitly.`,
    );
    return Promise.resolve();
  }

  const orgDir = join(root, 'orgs', org);
  const lines = [
    `🔔 Approval request: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  const message = lines.join('\n');

  return postActivity(orgDir, paths.ctxRoot, org, message, buildApprovalKeyboard(approvalId))
    .then((posted) => {
      if (!posted) {
        // postActivity returns false when activity-channel.env is missing
        // or cannot be parsed. Surface this visibly — the silent-false
        // pattern is what hid tonight's path-resolution bug for hours.
        console.warn(
          `[approval] Activity-channel post failed for ${approvalId} — ` +
          `check ${orgDir}/activity-channel.env (must define ACTIVITY_BOT_TOKEN + ACTIVITY_CHAT_ID).`,
        );
      }
    })
    .catch(() => undefined); // Thrown rejections still suppressed — activity-channel unreachable must not fail approval creation.
}

/**
 * Best-effort: ping the requesting agent's own Telegram chat (the operator's
 * 1:1 conversation with the agent's bot) when a new approval is created.
 * The activity-channel post handles "Approve / Deny" inline routing for the
 * operator-via-orchestrator UX, but operators on a per-agent bot would
 * otherwise miss approvals entirely — that's the source of the observed
 * 50h+ Repo-B-style stalls. This pings them on the bot they're actually
 * watching so they can hop to the orchestrator chat or dashboard to act.
 *
 * Reads BOT_TOKEN + CHAT_ID from `<agentDir>/.env`. Skips silently with a
 * single warn line when either is missing — approvals from a bot-less
 * agent (e.g. a hermes runtime, or pre-onboarding) must still succeed.
 *
 * Errors from the network round-trip are suppressed: a Telegram outage
 * must not block approval creation.
 */
function pingAgentChatId(
  agentDir: string | undefined,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
): Promise<void> {
  if (!agentDir) {
    console.warn(
      `[approval] No agentDir available for ${approvalId} — skipping agent-bot Telegram ping.`,
    );
    return Promise.resolve();
  }
  const envPath = join(agentDir, '.env');
  if (!existsSync(envPath)) {
    return Promise.resolve();
  }
  const env = parseEnvFile(envPath);
  const botToken = env.BOT_TOKEN;
  const chatId = env.CHAT_ID;
  if (!botToken || !chatId) {
    console.warn(
      `[approval] BOT_TOKEN or CHAT_ID missing in ${envPath} — skipping agent-bot Telegram ping for ${approvalId}.`,
    );
    return Promise.resolve();
  }

  const lines = [
    `🔔 Approval needed: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  lines.push('', 'Approve via the orchestrator chat (Approve/Deny buttons) or the dashboard.');
  const message = lines.join('\n');

  const api = new TelegramAPI(botToken);
  return api.sendMessage(chatId, message, undefined, { parseMode: null })
    .then(() => undefined)
    .catch(() => undefined); // Telegram outage must not fail approval creation.
}

/**
 * Create an approval request.
 * Identical to bash create-approval.sh format.
 *
 * Returns a Promise that resolves to the approval id AFTER the
 * activity-channel fan-out has settled. Callers in short-lived contexts
 * (CLI action handlers) MUST await — otherwise the process may exit before
 * the Telegram post completes and the post silently never sends.
 *
 * `frameworkRoot` (optional) is the filesystem root where
 * orgs/<org>/activity-channel.env lives. Without it the activity-channel
 * post is skipped with a warn — see postApprovalToActivityChannel for the
 * fallback chain (explicit arg → CTX_FRAMEWORK_ROOT env → skip). CLI call
 * sites should pass env.frameworkRoot explicitly; daemon-side callers
 * may rely on the env var.
 */
/**
 * Synchronous core of createApproval: writes the pending approval object and
 * returns its id, WITHOUT the async Telegram fan-out. Extracted so the
 * always_ask enforcement path in createTask (G1) can create+link an approval
 * inline — keeping createTask synchronous (its many callers stay unchanged)
 * while still enforcing at creation (safe-by-construction, not caller-
 * dependent). `taskId`, when given, links the approval to the task it gates so
 * updateApproval can unblock it on resolve. The async notification fan-out is
 * the caller's responsibility (best-effort; see createApproval).
 */
export function createApprovalObject(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  category: ApprovalCategory,
  context?: string,
  taskId?: string,
): Approval {
  validateApprovalCategory(category);

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const approvalId = `approval_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const approval: Approval = {
    id: approvalId,
    title,
    requesting_agent: agentName,
    org,
    category,
    status: 'pending',
    description: context || '',
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolved_by: null,
    ...(taskId ? { task_id: taskId } : {}),
  };

  const pendingDir = join(paths.approvalDir, 'pending');
  ensureDir(pendingDir);
  atomicWriteSync(join(pendingDir, `${approvalId}.json`), JSON.stringify(approval));

  return approval;
}

export async function createApproval(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  category: ApprovalCategory,
  context?: string,
  frameworkRoot?: string,
  agentDir?: string,
): Promise<string> {
  const approval = createApprovalObject(paths, agentName, org, title, category, context);
  const approvalId = approval.id;

  // Fan-out to the activity channel so the operator can approve/deny from
  // Telegram without opening the dashboard. AWAITED so short-lived CLI callers do
  // not exit before the Telegram post fetch completes. Errors are
  // suppressed inside postApprovalToActivityChannel — activity-channel
  // unreachable must not block approval creation. Callbacks route back
  // via the orchestrator's activity-channel poller (see
  // daemon/agent-manager.ts).
  await postApprovalToActivityChannel(paths, org, approvalId, title, category, agentName, context, frameworkRoot);

  // Best-effort ping to the requesting agent's own Telegram bot (the
  // operator's 1:1 conversation with the agent). Closes the gap where
  // operators not in the activity channel would miss approvals entirely
  // (the 50h+ Repo-B-style stall). Errors suppressed — see helper.
  await pingAgentChatId(agentDir, approvalId, title, category, agentName, context);

  return approvalId;
}

/**
 * Update an approval's status (approve or deny).
 * Notifies the requesting agent via inbox message.
 */
export function updateApproval(
  paths: BusPaths,
  approvalId: string,
  status: ApprovalStatus,
  note?: string,
): void {
  const pendingDir = join(paths.approvalDir, 'pending');
  const filePath = join(pendingDir, `${approvalId}.json`);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const approval: Approval = JSON.parse(content);
    approval.status = status;
    approval.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    approval.resolved_at = approval.updated_at;
    approval.resolved_by = note || null;

    // Move to resolved/ directory (matches bash version)
    const destDir = join(paths.approvalDir, 'resolved');
    ensureDir(destDir);
    atomicWriteSync(join(destDir, `${approvalId}.json`), JSON.stringify(approval));

    // Remove from pending
    const { unlinkSync } = require('fs');
    unlinkSync(filePath);

    // Notify requesting agent via inbox
    if (approval.requesting_agent) {
      const noteText = note ? ` Note: ${note}` : '';
      const msg = `Approval decision: ${status.toUpperCase()}\napproval_id: ${approvalId}\ndecision: ${status}${noteText}`;
      sendMessage(paths, 'system', approval.requesting_agent, 'urgent', msg);
    }

    // G1: if this approval gates a task (always_ask enforcement), the task was
    // created `blocked`. Resolving the approval releases it — approved OR
    // rejected, the gate has done its job and the task should no longer sit
    // `blocked` on a now-decided approval. A rejected decision returns the task
    // to `pending` so the owner can see it and cancel/rework; it does not
    // auto-cancel (that is the owner's call, not the gate's).
    if (approval.task_id) {
      releaseTaskForApproval(paths, approval.task_id, approvalId, status);
    }
  } catch (err) {
    throw new Error(`Approval ${approvalId} not found: ${err}`);
  }
}

/**
 * Release a task that an always_ask approval was gating (G1). Done inline with
 * fs (not via bus/task.ts) so approval.ts does NOT import task.ts — task.ts
 * imports createApprovalObject from here, and a mutual import would be a cycle.
 * Only touches a task that is actually `blocked` on THIS approval; anything
 * else (already progressed, different approval, missing file) is left alone.
 *
 * APPROVED  -> 'pending'   (the gate is satisfied; the task becomes executable).
 * REJECTED  -> 'cancelled' (TERMINAL, non-executable). A rejection must PREVENT
 *   the action — returning a rejected money-path task to 'pending' would make
 *   it executable again and defeat the gate exactly when it matters most. The
 *   rejected approval stays in resolved/ for audit; owner rework = create a NEW
 *   task, which re-gates. (boss 1784652695327)
 */
function releaseTaskForApproval(
  paths: BusPaths,
  taskId: string,
  approvalId: string,
  decision: ApprovalStatus,
): void {
  const filePath = join(paths.taskDir, `${taskId}.json`);
  if (!existsSync(filePath)) return; // task gone — nothing to release
  try {
    const task: Task = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (task.status !== 'blocked' || task.approval_id !== approvalId) return;
    task.status = decision === 'approved' ? 'pending' : 'cancelled';
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch {
    // Corrupt/unreadable task file — do not throw from the approval path;
    // the approval itself already resolved. Surfaced elsewhere on read.
  }
}

/**
 * Is this pending approval moot because the task it gates was already cancelled?
 *
 * Propagation between the two records runs ONE WAY: resolving an approval releases
 * its task (releaseTaskForApproval above), but cancelling a task does nothing to its
 * approval — so a task cancelled for any reason (superseded, rationale withdrawn,
 * duplicate) leaves a pending approval behind with no way to tell it from a live one.
 *
 * Detected on READ rather than repaired on write, and reported rather than resolved:
 * an agent closing an approval that no human decided is precisely the authority the
 * gate exists to withhold. The queue is the thing being protected here — a moot row
 * costs a reader the same attention as a real one, and the real ones are payments.
 *
 * Requires the link to hold in BOTH directions, matching the write path's own check.
 * A cancelled task pointing at some other approval says nothing about this one.
 */
function isOrphanedByCancelledTask(paths: BusPaths, approval: Approval): boolean {
  if (!approval.task_id) return false;
  const filePath = join(paths.taskDir, `${approval.task_id}.json`);
  if (!existsSync(filePath)) return false; // absent is unknown, not decided
  try {
    const task: Task = JSON.parse(readFileSync(filePath, 'utf-8'));
    return task.status === 'cancelled' && task.approval_id === approval.id;
  } catch {
    return false; // corrupt task file must not make a live approval look moot
  }
}

/**
 * List pending approvals, annotating any whose linked task has already been
 * cancelled (see isOrphanedByCancelledTask — flagged, never auto-resolved).
 */
export function listPendingApprovals(paths: BusPaths): Approval[] {
  const pendingDir = join(paths.approvalDir, 'pending');
  let files: string[];
  try {
    files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const approvals: Approval[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(pendingDir, file), 'utf-8');
      const approval: Approval = JSON.parse(content);
      if (isOrphanedByCancelledTask(paths, approval)) {
        approval.orphaned_by_cancelled_task = true;
      }
      approvals.push(approval);
    } catch {
      // Skip corrupt
    }
  }

  return approvals.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
