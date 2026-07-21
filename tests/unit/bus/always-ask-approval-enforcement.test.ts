/**
 * G1: always_ask categories must route through a REAL approval object.
 *
 * The capability (createApproval/updateApproval) and the task `needs_approval`
 * field both already exist — but nothing CONNECTS them. Enforcing (A), scoped:
 * creating a task in one of the 4 always_ask categories
 * (external-comms / financial / deployment / data-deletion) must, at creation:
 *   1. write a linked PENDING approval object,
 *   2. leave the task BLOCKED (not actionable) until that approval resolves,
 *   3. link the two (task carries approval_id; approval carries the task id),
 * and resolving the approval must UNBLOCK the task. A non-always_ask category
 * (or none) must do NONE of this — blast radius is bounded to the money-path.
 *
 * Chosen (A) enforce-at-creation over (B) link-on-flag because (B) depends on
 * the agent remembering to pass a flag = a-flag-is-not-a-gate / the guard
 * depends on the subject cooperating. (A) is safe-by-construction: a
 * money/deploy/delete task CANNOT be created un-blocked.
 *
 * RED-first: createTask has no `category` option yet, so the always_ask path
 * does not exist — these must FAIL until the enforcement is wired.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, findTaskFile } from '../../../src/bus/task';
import { updateApproval } from '../../../src/bus/approval';
import type { BusPaths, Task, Approval, ApprovalCategory } from '../../../src/types';

function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', 'paul'),
    inflight: join(root, 'inflight', 'paul'),
    processed: join(root, 'processed', 'paul'),
    logDir: join(root, 'logs', 'paul'),
    stateDir: join(root, 'state', 'paul'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  };
}

function readTask(paths: BusPaths, id: string): Task {
  const f = findTaskFile(paths, id)!;
  return JSON.parse(readFileSync(f, 'utf-8'));
}

function pendingApprovals(paths: BusPaths): Approval[] {
  const dir = join(paths.approvalDir, 'pending');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

const ALWAYS_ASK: ApprovalCategory[] = ['external-comms', 'financial', 'deployment', 'data-deletion'];

describe('always_ask approval enforcement (G1, enforce-at-creation, scoped)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-alwaysask-'));
    paths = makePaths(testDir);
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it.each(ALWAYS_ASK)('creating a %s task auto-creates a linked pending approval AND blocks the task', async (category) => {
    const id = await createTask(paths, 'paul', 'acme', `pay vendor`, { category } as any);

    // 1. a pending approval exists, linked to this task
    const approvals = pendingApprovals(paths).filter((a) => (a as any).task_id === id);
    expect(approvals, `${category}: expected exactly one linked pending approval`).toHaveLength(1);
    expect(approvals[0].category).toBe(category);
    expect(approvals[0].status).toBe('pending');

    // 2. the task is blocked and carries the approval id
    const task = readTask(paths, id);
    expect(task.status, `${category}: task must be blocked until approval resolves`).toBe('blocked');
    expect((task as any).approval_id).toBe(approvals[0].id);
  });

  it('APPROVING the approval unblocks the task to an executable state', async () => {
    const id = await createTask(paths, 'paul', 'acme', 'deploy prod', { category: 'deployment' } as any);
    const approvalId = (readTask(paths, id) as any).approval_id as string;
    expect(readTask(paths, id).status).toBe('blocked');

    updateApproval(paths, approvalId, 'approved');

    // approved = the gate is satisfied → executable
    expect(readTask(paths, id).status, 'approved -> pending (executable)').toBe('pending');
  });

  it('REJECTING the approval makes the task NON-EXECUTABLE (cancelled), never pending', async () => {
    // The reject path is the one that matters most: a rejection must PREVENT
    // the action. If a rejected money-path task returned to 'pending' it would
    // be executable again — an agent could pick it up and DEFEAT the gate
    // exactly when it said no. Rejected must be terminal. (boss 1784652695327)
    const id = await createTask(paths, 'paul', 'acme', 'wire $50k', { category: 'financial' } as any);
    const approvalId = (readTask(paths, id) as any).approval_id as string;
    expect(readTask(paths, id).status).toBe('blocked');

    updateApproval(paths, approvalId, 'rejected');

    const status = readTask(paths, id).status;
    expect(status, 'rejected -> cancelled (terminal, non-executable)').toBe('cancelled');
    expect(status, 'rejected must NOT return the task to an executable pending state').not.toBe('pending');
  });

  it('a non-always_ask category ("other") does NOT create an approval or block', async () => {
    const id = await createTask(paths, 'paul', 'acme', 'routine note', { category: 'other' } as any);
    expect(pendingApprovals(paths)).toHaveLength(0);
    expect(readTask(paths, id).status).toBe('pending');
  });

  it('no category at all leaves task creation completely untouched (bounds blast radius)', async () => {
    const id = await createTask(paths, 'paul', 'acme', 'plain task', {});
    expect(pendingApprovals(paths)).toHaveLength(0);
    expect(readTask(paths, id).status).toBe('pending');
    expect((readTask(paths, id) as any).approval_id).toBeUndefined();
  });
});
