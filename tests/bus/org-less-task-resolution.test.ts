import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTaskFile, listTasks } from '../../src/bus/task.js';

/**
 * A task created with NO CTX_ORG lands in <ctxRoot>/tasks, because getBusPaths falls back to
 * ctxRoot when org is undefined. Neither of findTaskFile's candidates reached that directory:
 * the fast path looks in paths.taskDir (the ORG's tasks) and the fallback scans orgs/ * /tasks.
 *
 * Measured impact before the fix: 51 task files in <ctxRoot>/tasks accumulated 2026-07-10..07-29,
 * four still in_progress at up to 378 hours — invisible to every dashboard, every stale-task
 * sweep, and uncloseable by any org-scoped caller.
 *
 * ⚠ THE TEST THAT MATTERS IS NOT "the resolver finds it". It is BOTH of:
 *   (a) an org-less id is REACHABLE from an org-scoped caller, and
 *   (b) a duplicate id across the org-less root and an org is still reported AMBIGUOUS.
 * Adding a third root without (b) trades a visible failure (not found) for an invisible one
 * (silently resolves to whichever root is scanned first).
 */

function makeTask(dir: string, id: string, extra: Record<string, unknown> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id, title: `t ${id}`, status: 'pending', priority: 'normal',
    created_at: '2026-07-20T00:00:00Z', created_by: 'test', assigned_to: 'engineer',
    ...extra,
  }));
}

describe('org-less task root is reachable and unambiguous', () => {
  let root: string, orgTasks: string, orgLessTasks: string, paths: never;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ctx-orgless-'));
    orgTasks = join(root, 'orgs', 'loftco-autopilot', 'tasks');
    orgLessTasks = join(root, 'tasks');
    mkdirSync(orgTasks, { recursive: true });
    mkdirSync(orgLessTasks, { recursive: true });
    paths = { ctxRoot: root, taskDir: orgTasks } as never;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('(a) THE BUG: an org-scoped caller can now reach an org-less task', () => {
    makeTask(orgLessTasks, 'task_1784055676216_13541328');
    const found = findTaskFile(paths, 'task_1784055676216_13541328');
    expect(found).not.toBeNull();
    expect(found).toContain(join('tasks', 'task_1784055676216_13541328.json'));
    // and specifically NOT via an org directory
    expect(found).not.toContain('orgs');
  });

  it('same-org tasks still resolve by the fast path (no regression)', () => {
    makeTask(orgTasks, 'task_1_1');
    expect(findTaskFile(paths, 'task_1_1')).toBe(join(orgTasks, 'task_1_1.json'));
  });

  it('cross-org tasks still resolve (no regression)', () => {
    const other = join(root, 'orgs', 'other-org', 'tasks');
    makeTask(other, 'task_2_2');
    expect(findTaskFile(paths, 'task_2_2')).toBe(join(other, 'task_2_2.json'));
  });

  it('(b) THE LOAD-BEARING ONE: a duplicate across the org-less root and an org WARNS', () => {
    // Without this, a third root silently resolves to whichever is scanned first — trading a
    // loud "not found" for a quiet wrong-file. The warning is the whole reason the org-less
    // root was pushed into `matches` rather than returned early.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    makeTask(join(root, 'orgs', 'other-org', 'tasks'), 'task_dup_1');
    makeTask(orgLessTasks, 'task_dup_1');
    const found = findTaskFile(paths, 'task_dup_1');
    expect(found).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/Ambiguous task id task_dup_1/);
    warn.mockRestore();
  });

  it('a missing orgs/ tree still reaches the org-less root', () => {
    // Previously `catch { return null }` on an unreadable orgs/ — a second unreachability
    // hiding behind the first. A caller with no orgs/ tree can still own org-less tasks.
    rmSync(join(root, 'orgs'), { recursive: true, force: true });
    makeTask(orgLessTasks, 'task_3_3');
    expect(findTaskFile(paths, 'task_3_3')).toBe(join(orgLessTasks, 'task_3_3.json'));
  });

  it('a genuinely absent id is still null — the fix must not manufacture a hit', () => {
    expect(findTaskFile(paths, 'task_nope_0')).toBeNull();
  });

  it('listTasks surfaces BOTH roots — the asymmetry that made these invisible', () => {
    // The WRITE verbs had a cross-root fallback and the LIST verb did not, so nothing that
    // renders a board ever looked at the org-less root. That is why 378h of staleness was
    // invisible rather than merely unfixed.
    makeTask(orgTasks, 'task_in_org_1');
    makeTask(orgLessTasks, 'task_orgless_1', { status: 'in_progress' });
    const ids = listTasks(paths).map(t => t.id);
    expect(ids).toContain('task_in_org_1');
    expect(ids).toContain('task_orgless_1');
  });

  it('listTasks filters still apply across both roots', () => {
    makeTask(orgTasks, 'task_a_1', { status: 'completed' });
    makeTask(orgLessTasks, 'task_b_1', { status: 'in_progress' });
    const stuck = listTasks(paths, { status: 'in_progress' }).map(t => t.id);
    expect(stuck).toEqual(['task_b_1']);
  });

  it('listTasks does not double-count an id present in both roots', () => {
    makeTask(orgTasks, 'task_dup_2');
    makeTask(orgLessTasks, 'task_dup_2');
    const ids = listTasks(paths).map(t => t.id);
    expect(ids.filter(i => i === 'task_dup_2')).toHaveLength(1);
  });

  it('an org-scoped instance with NO org-less root still lists normally', () => {
    rmSync(orgLessTasks, { recursive: true, force: true });
    makeTask(orgTasks, 'task_solo_1');
    expect(listTasks(paths).map(t => t.id)).toEqual(['task_solo_1']);
  });

  it('POSITIVE CONTROL: the fixture actually writes files', () => {
    // Guards every assertion above: if makeTask silently wrote nothing, "not found" and
    // "correctly absent" would be indistinguishable and half this suite would pass vacuously.
    makeTask(orgLessTasks, 'task_ctl_1');
    expect(readdirSync(orgLessTasks)).toContain('task_ctl_1.json');
  });
});
