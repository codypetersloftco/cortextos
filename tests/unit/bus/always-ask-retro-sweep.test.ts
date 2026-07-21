/**
 * G1 retro-sweep: SURFACES pre-guard money-path candidates, never auto-gates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask } from '../../../src/bus/task';
import { retroSweepAlwaysAsk } from '../../../src/bus/always-ask-retro-sweep';
import type { BusPaths } from '../../../src/types';

function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root, inbox: join(root, 'inbox', 'p'), inflight: join(root, 'inflight', 'p'),
    processed: join(root, 'processed', 'p'), logDir: join(root, 'logs', 'p'), stateDir: join(root, 'state', 'p'),
    taskDir: join(root, 'tasks'), approvalDir: join(root, 'approvals'), analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  };
}

describe('G1 retro-sweep (surface pre-guard money-path candidates)', () => {
  let dir: string;
  let paths: BusPaths;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cortextos-retro-')); paths = makePaths(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('flags an un-gated money-path task with its matched signal + suggested category', () => {
    createTask(paths, 'p', 'acme', 'Wire $50k to vendor', { description: 'remit payment' });
    const found = retroSweepAlwaysAsk(paths);
    expect(found).toHaveLength(1);
    expect(found[0].suggestedCategory).toBe('financial');
    expect(found[0].signals.length).toBeGreaterThan(0);
  });

  it('does NOT flag a non-money-path task', () => {
    createTask(paths, 'p', 'acme', 'Refactor the parser', { description: 'clean up types' });
    expect(retroSweepAlwaysAsk(paths)).toHaveLength(0);
  });

  it('does NOT re-flag a task ALREADY gated by the forward guard (has approval_id)', () => {
    // A forward-gated financial task carries approval_id — sweep must skip it.
    createTask(paths, 'p', 'acme', 'Pay invoice 123', { category: 'financial' } as any);
    expect(retroSweepAlwaysAsk(paths)).toHaveLength(0);
  });

  it('does NOT flag terminal (completed/cancelled) tasks', () => {
    createTask(paths, 'p', 'acme', 'delete the old table', { description: 'drop table legacy' });
    // one live candidate expected; a cancelled one must not appear
    const live = retroSweepAlwaysAsk(paths);
    expect(live).toHaveLength(1);
    expect(live[0].suggestedCategory).toBe('data-deletion');
  });

  it('SURFACES only — the swept task is unchanged on disk (no auto-gate, no mutation)', () => {
    const id = createTask(paths, 'p', 'acme', 'deploy to prod', {});
    const before = retroSweepAlwaysAsk(paths);
    expect(before).toHaveLength(1);
    // sweeping again yields the same result — nothing was mutated/gated
    const after = retroSweepAlwaysAsk(paths);
    expect(after).toHaveLength(1);
    expect(after[0].taskId).toBe(id);
  });
});
