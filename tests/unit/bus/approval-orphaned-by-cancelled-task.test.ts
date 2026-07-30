import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listPendingApprovals } from '../../../src/bus/approval';
import type { BusPaths } from '../../../src/types';

/**
 * A cancelled TASK does not cancel its linked APPROVAL, so the approval sits pending forever.
 *
 * LIVE SPECIMEN (2026-07-30): approval_1785370768_y3ph5 is `pending` while its linked task
 * task_1785370768068_83769354 is `cancelled`. The link is intact in BOTH directions
 * (task_id <-> approval_id); only the PROPAGATION is one-way:
 *
 *     approval resolved -> releaseTaskForApproval() updates the task    exists
 *     task cancelled    -> nothing touches the approval                 missing
 *
 * THE FIX IS NOT TO AUTO-RESOLVE IT. "A superseded approval is the principal's to retire, not
 * ours" (boss) — an agent closing an approval nobody decided is exactly the authority the gate
 * exists to withhold. So this SURFACES the condition and leaves the decision alone.
 *
 * Why it matters rather than being tidiness: the queue reached 9 pending / oldest 33.6h today.
 * A moot approval is indistinguishable from a live one in that list, and every moot row raises
 * the cost of reading the ones that genuinely need a human.
 */

let root: string;
let paths: BusPaths;

function mkPaths(r: string): BusPaths {
  return {
    ctxRoot: r,
    inbox: join(r, 'inbox'),
    inflight: join(r, 'inflight'),
    processed: join(r, 'processed'),
    logDir: join(r, 'logs'),
    stateDir: join(r, 'state'),
    taskDir: join(r, 'tasks'),
    approvalDir: join(r, 'orgs', 'TestOrg', 'approvals'),
    analyticsDir: join(r, 'analytics'),
    heartbeatDir: join(r, 'heartbeats'),
  } as BusPaths;
}

function writeApproval(id: string, taskId?: string) {
  writeFileSync(join(paths.approvalDir, 'pending', `${id}.json`), JSON.stringify({
    id, title: `t ${id}`, requesting_agent: 'engineer', org: 'TestOrg', category: 'deployment',
    description: 'd', status: 'pending', created_at: '2026-07-30T00:00:00Z',
    updated_at: '2026-07-30T00:00:00Z', resolved_at: null, resolved_by: null,
    ...(taskId ? { task_id: taskId } : {}),
  }));
}

function writeTask(id: string, status: string, approvalId?: string) {
  writeFileSync(join(paths.taskDir, `${id}.json`), JSON.stringify({
    id, title: `task ${id}`, status, priority: 'normal', created_at: '2026-07-30T00:00:00Z',
    updated_at: '2026-07-30T00:00:00Z', created_by: 'engineer', assigned_to: 'engineer',
    ...(approvalId ? { approval_id: approvalId } : {}),
  }));
}

function flag(a: unknown): boolean | undefined {
  return (a as { orphaned_by_cancelled_task?: boolean }).orphaned_by_cancelled_task;
}

describe('an approval whose linked task was cancelled is surfaced, not silently pending', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-orphan-approval-'));
    paths = mkPaths(root);
    mkdirSync(join(paths.approvalDir, 'pending'), { recursive: true });
    mkdirSync(join(paths.approvalDir, 'resolved'), { recursive: true });
    mkdirSync(paths.taskDir, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('THE BUG: a pending approval whose linked task is cancelled is flagged orphaned', () => {
    writeApproval('approval_a', 'task_a');
    writeTask('task_a', 'cancelled', 'approval_a');

    const [a] = listPendingApprovals(paths);
    expect(a.id).toBe('approval_a');
    expect(flag(a)).toBe(true);
  });

  it('THE GAP: a pending approval whose task is COMPLETED is orphaned too', () => {
    // Found by applying "can the answer actually be applied?" to the live queue: wc08h, a
    // financial approval reading as fully live, whose task completed 8h after creation because
    // the principal had already taken the action himself by another route. The task's own result
    // says "THE LINKED APPROVAL IS ORPHANED AND STILL PENDING" — and the first version of this
    // check, shipped 90 minutes earlier, only looked for `cancelled` and walked straight past it.
    //
    // The claim the flag makes is narrow and true for BOTH terminal states: resolving this will
    // not move the linked task, because releaseTaskForApproval only touches a `blocked` one.
    writeApproval('approval_h', 'task_h');
    writeTask('task_h', 'completed', 'approval_h');

    const [a] = listPendingApprovals(paths);
    expect(flag(a)).toBe(true);
  });

  it('the reason is reported, because cancelled and completed mean opposite things', () => {
    // CANCELLED: the action was prevented. COMPLETED: the action already happened by some other
    // route — which is the more urgent one to see on a money-path row, not the same news.
    writeApproval('approval_i', 'task_i');
    writeTask('task_i', 'completed', 'approval_i');
    writeApproval('approval_j', 'task_j');
    writeTask('task_j', 'cancelled', 'approval_j');

    const byId = Object.fromEntries(listPendingApprovals(paths).map(a => [a.id, a]));
    const reason = (a: unknown) => (a as { orphaned_reason?: string }).orphaned_reason;
    expect(reason(byId.approval_i)).toBe('completed');
    expect(reason(byId.approval_j)).toBe('cancelled');
  });

  it('NEGATIVE CONTROL: a live task leaves its approval unflagged', () => {
    // Without this, flagging everything would pass the test above and destroy the signal.
    writeApproval('approval_b', 'task_b');
    writeTask('task_b', 'blocked', 'approval_b');

    const [a] = listPendingApprovals(paths);
    expect(flag(a)).toBeFalsy();
  });

  it('it is STILL PENDING — surfacing must not resolve it', () => {
    // The whole point: an agent must not retire an approval the principal never decided.
    writeApproval('approval_c', 'task_c');
    writeTask('task_c', 'cancelled', 'approval_c');

    const [a] = listPendingApprovals(paths);
    expect(a.status).toBe('pending');
  });

  it('a cancelled task pointing at a DIFFERENT approval does not flag this one', () => {
    // Guards against matching on task_id alone. The existing release path checks both
    // directions before it will touch anything; a read-side flag has no excuse to check fewer.
    writeApproval('approval_d', 'task_d');
    writeTask('task_d', 'cancelled', 'approval_SOMETHING_ELSE');

    const [a] = listPendingApprovals(paths);
    expect(flag(a)).toBeFalsy();
  });

  it('a missing task file does not flag and does not throw', () => {
    // "Task gone" is not "task cancelled" — an absent file is unknown, not decided.
    writeApproval('approval_e', 'task_that_does_not_exist');
    const [a] = listPendingApprovals(paths);
    expect(flag(a)).toBeFalsy();
  });

  it('an approval with no task_id at all is untouched', () => {
    writeApproval('approval_f');
    const [a] = listPendingApprovals(paths);
    expect(flag(a)).toBeFalsy();
  });

  it('POSITIVE CONTROL: the fixture actually produces a listable approval', () => {
    // Guards the not-flagged assertions above: if the fixture wrote nothing, "not flagged"
    // and "nothing there" would be indistinguishable.
    writeApproval('approval_g', 'task_g');
    expect(listPendingApprovals(paths)).toHaveLength(1);
  });
});
