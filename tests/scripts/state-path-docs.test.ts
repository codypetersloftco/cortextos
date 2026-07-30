import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Contract tests for scripts/check_state_path_docs.py.
 *
 * The script exists because a wrong documented path took FIVE rounds to fix, and every
 * round each searcher was correct about what they had measured. The pattern had three
 * degrees of freedom — form, tree, artifact — and each round censused one and whitelisted
 * the others.
 *
 * So the property under test is not "it finds the known defect". It is that the ARTIFACT
 * AXIS COMES FROM THE FILESYSTEM, so an artifact nobody thought of is still adjudicated.
 * These fixtures therefore invent artifact names the script has never heard of.
 */

const SCRIPT = resolve(__dirname, '../../scripts/check_state_path_docs.py');
const PY = process.platform === 'win32' ? 'python' : 'python3';

const EXIT_OK = 0, EXIT_MISMATCH = 1, EXIT_CANNOT = 2;

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(PY, [SCRIPT, ...args], { encoding: 'utf-8', timeout: 120_000 });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('check_state_path_docs', () => {
  let root: string, ctx: string, docs: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ctx-statedocs-'));
    ctx = join(root, 'instance');
    docs = join(root, 'docs');
    // Ground truth: an artifact in tree A only, and a different one in tree B only.
    // Both names are INVENTED — the script must learn them from disk, not from a list.
    mkdirSync(join(ctx, '.cortextOS', 'state', 'agents', 'alpha'), { recursive: true });
    writeFileSync(join(ctx, '.cortextOS', 'state', 'agents', 'alpha', 'widget.json'), '{}');
    mkdirSync(join(ctx, 'state', 'alpha'), { recursive: true });
    writeFileSync(join(ctx, 'state', 'alpha', '.sprocket'), '');
    mkdirSync(docs, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const doc = (body: string, name = 'GUIDE.md') => writeFileSync(join(docs, name), body);
  const go = (extra: string[] = []) => run(['--ctx-root', ctx, '--docs-root', docs, ...extra]);

  it('correct references on both trees pass', () => {
    doc('A: `${CTX_ROOT}/.cortextOS/state/agents/${CTX_AGENT_NAME}/widget.json`\n' +
        'B: `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.sprocket`\n');
    const r = go();
    expect(r.out).toContain('VERDICT=OK');
    expect(r.code).toBe(EXIT_OK);
  });

  it('THE LOAD-BEARING CASE: it flags an artifact name it has never heard of', () => {
    // `widget.json` is in no hardcoded list anywhere. The verdict must come from disk.
    doc('wrong: `${CTX_ROOT}/state/${CTX_AGENT_NAME}/widget.json`\n');
    const r = go();
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(r.out).toContain('VERDICT=MISMATCH');
    expect(r.out).toContain('widget.json');
    expect(r.out).toMatch(/documented in tree B, exists only in tree A/);
  });

  it('does NOT flag a tree-B artifact documented in tree B — the 56-reference near-miss', () => {
    // A pattern-based sweep called all 56 `.onboarded` references wrong because its
    // known-good test was "contains .cortextOS". Writing from that would have broken
    // onboarding fleet-wide. Ground truth must protect the correct references.
    doc('right: `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.sprocket`\n'.repeat(20));
    const r = go();
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).not.toContain('.sprocket  —');
  });

  it('flags the reverse direction too — tree-B artifact documented under tree A', () => {
    doc('wrong: `${CTX_ROOT}/.cortextOS/state/agents/${CTX_AGENT_NAME}/.sprocket`\n');
    const r = go();
    expect(r.code).toBe(EXIT_MISMATCH);
    expect(r.out).toMatch(/documented in tree A, exists only in tree B/);
  });

  it('handles every agent-name FORM, including the brace form that hid for four rounds', () => {
    for (const form of ['${CTX_AGENT_NAME}', '$CTX_AGENT_NAME', '<agent>', '{agent}']) {
      rmSync(join(docs, 'GUIDE.md'), { force: true });
      doc('x: `${CTX_ROOT}/state/' + form + '/widget.json`\n');
      const r = go();
      expect(r.code, `form ${form} was not adjudicated`).toBe(EXIT_MISMATCH);
    }
  });

  it('a name absent from disk is REPORTED, never counted as clean', () => {
    doc('mystery: `${CTX_ROOT}/state/${CTX_AGENT_NAME}/nothing-like-this.dat`\n');
    const r = go();
    expect(r.out).toContain('do NOT exist on disk');
    expect(r.out).toContain('nothing-like-this.dat');
  });

  it('record files are skipped BY DEFAULT and the skip announces itself', () => {
    mkdirSync(join(docs, 'memory'), { recursive: true });
    writeFileSync(join(docs, 'memory', '2026-01-01.md'),
      'quoting the defect: `${CTX_ROOT}/state/${CTX_AGENT_NAME}/widget.json`\n');
    const r = go();
    expect(r.code).toBe(EXIT_OK);
    // An exclusion nobody can see is indistinguishable from a coverage gap.
    expect(r.out).toContain('record file(s) skipped');
  });

  it('--include-records surfaces them again', () => {
    mkdirSync(join(docs, 'memory'), { recursive: true });
    writeFileSync(join(docs, 'memory', '2026-01-01.md'),
      'quoting: `${CTX_ROOT}/state/${CTX_AGENT_NAME}/widget.json`\n');
    const r = go(['--include-records']);
    expect(r.code).toBe(EXIT_MISMATCH);
  });

  it('a missing state tree is CANNOT_CHECK, never OK', () => {
    const r = run(['--ctx-root', join(root, 'nope'), '--docs-root', docs]);
    expect(r.code).toBe(EXIT_CANNOT);
    expect(r.out).toContain('VERDICT=CANNOT_CHECK');
  });

  it('a bad flag is CANNOT_CHECK with a token — argparse exits before any return', () => {
    const r = run(['--bogus']);
    expect(r.code).toBe(EXIT_CANNOT);
    expect(r.out).toContain('VERDICT=CANNOT_CHECK');
  });

  it('emits exactly ONE verdict line, so a reader cannot grep the wrong one', () => {
    doc('wrong: `${CTX_ROOT}/state/${CTX_AGENT_NAME}/widget.json`\n');
    const r = go();
    expect((r.out.match(/VERDICT=/g) ?? []).length).toBe(1);
  });
});
