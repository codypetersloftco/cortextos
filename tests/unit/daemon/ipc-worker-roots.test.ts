import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getAdditionalWorkerRoots } from '../../../src/daemon/ipc-server.js';

// Covers the spawn-worker allowlist extension: additional_worker_roots read
// from orgs/<CTX_ORG>/context.json. Must fail CLOSED (return []) on every
// malformed-input shape — a broken config can only fail to widen the
// spawn-worker allowlist, never accidentally widen it to something unintended.
describe('getAdditionalWorkerRoots', () => {
  let testDir: string;
  let savedFrameworkRoot: string | undefined;
  let savedOrg: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-worker-roots-'));
    savedFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    savedOrg = process.env.CTX_ORG;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (savedFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = savedFrameworkRoot;
    if (savedOrg === undefined) delete process.env.CTX_ORG;
    else process.env.CTX_ORG = savedOrg;
  });

  function writeContext(org: string, contents: unknown): void {
    const orgDir = join(testDir, 'orgs', org);
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'context.json'), JSON.stringify(contents), 'utf-8');
  }

  it('returns resolved roots when additional_worker_roots is a valid string array', () => {
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    process.env.CTX_ORG = 'acme';
    const extraRoot = join(testDir, 'ExternalWorkspace');
    writeContext('acme', { additional_worker_roots: [extraRoot] });

    expect(getAdditionalWorkerRoots()).toEqual([extraRoot]);
  });

  it('returns [] when CTX_FRAMEWORK_ROOT is unset', () => {
    delete process.env.CTX_FRAMEWORK_ROOT;
    process.env.CTX_ORG = 'acme';
    expect(getAdditionalWorkerRoots()).toEqual([]);
  });

  it('returns [] when CTX_ORG is unset', () => {
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    delete process.env.CTX_ORG;
    expect(getAdditionalWorkerRoots()).toEqual([]);
  });

  it('returns [] when context.json does not exist', () => {
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    process.env.CTX_ORG = 'ghost-org';
    expect(getAdditionalWorkerRoots()).toEqual([]);
  });

  it('returns [] when context.json is malformed JSON (fails closed, not throws)', () => {
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    process.env.CTX_ORG = 'acme';
    const orgDir = join(testDir, 'orgs', 'acme');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'context.json'), '{ not valid json', 'utf-8');

    expect(getAdditionalWorkerRoots()).toEqual([]);
  });

  it('returns [] when additional_worker_roots is missing entirely', () => {
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    process.env.CTX_ORG = 'acme';
    writeContext('acme', { name: 'acme', timezone: 'UTC' });

    expect(getAdditionalWorkerRoots()).toEqual([]);
  });

  it('returns [] when additional_worker_roots is not an array (e.g. a single string)', () => {
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    process.env.CTX_ORG = 'acme';
    writeContext('acme', { additional_worker_roots: join(testDir, 'Solo') });

    expect(getAdditionalWorkerRoots()).toEqual([]);
  });

  it('filters out non-string / empty entries but keeps valid ones', () => {
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    process.env.CTX_ORG = 'acme';
    const validRoot = join(testDir, 'Valid');
    writeContext('acme', { additional_worker_roots: [validRoot, 42, null, '', {}, ['nested']] });

    expect(getAdditionalWorkerRoots()).toEqual([validRoot]);
  });

  it('resolves relative paths against cwd (consistent with the rest of the allowlist)', () => {
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    process.env.CTX_ORG = 'acme';
    writeContext('acme', { additional_worker_roots: ['relative-workspace'] });

    const result = getAdditionalWorkerRoots();
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('relative-workspace');
    expect(result[0]).not.toBe('relative-workspace'); // must be resolved to absolute
  });

  it('reads per-org, not global — a sibling org context.json is not consulted', () => {
    process.env.CTX_FRAMEWORK_ROOT = testDir;
    process.env.CTX_ORG = 'acme';
    writeContext('other-org', { additional_worker_roots: [join(testDir, 'ShouldNotLeak')] });
    // 'acme' has no context.json at all.

    expect(getAdditionalWorkerRoots()).toEqual([]);
  });
});
