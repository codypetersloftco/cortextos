import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseDashboardModeFromDump, resolveDashboardMode } from '../../../src/cli/ecosystem.js';

// The generator must preserve the LIVE dashboard run-mode (dev vs start) when
// regenerating ecosystem.config.js. The live mode is read from PM2's dump file
// (~/.pm2/dump.pm2) — a file read, never a pm2 spawn (Node 24 won't spawn the
// pm2 .cmd shim without a shell). Regenerating with a hardcoded 'start' while
// the live dashboard runs `next dev` silently reverts the run-mode on the next
// `pm2 start ecosystem.config.js` — next-start needs a fresh build and has
// historically 404'd /api/auth/session.

const dumpWith = (entry: Record<string, unknown>) => JSON.stringify([entry]);

describe('parseDashboardModeFromDump', () => {
  it('detects dev from an array-args dashboard entry (real dump shape)', () => {
    const dump = dumpWith({
      name: 'cortextos-dashboard',
      args: ['dev'],
      pm_exec_path: 'C:/x/dashboard/node_modules/next/dist/bin/next',
    });
    expect(parseDashboardModeFromDump(dump)).toBe('dev');
  });

  it('detects start from an array-args dashboard entry', () => {
    expect(parseDashboardModeFromDump(dumpWith({ name: 'cortextos-dashboard', args: ['start'] }))).toBe('start');
  });

  it('detects mode from string args', () => {
    expect(parseDashboardModeFromDump(dumpWith({ name: 'cortextos-dashboard', args: 'dev' }))).toBe('dev');
  });

  it('falls back to pm2_env.args when top-level args is absent', () => {
    const dump = dumpWith({ name: 'cortextos-dashboard', pm2_env: { args: ['dev'] } });
    expect(parseDashboardModeFromDump(dump)).toBe('dev');
  });

  it('ignores other processes', () => {
    const dump = JSON.stringify([
      { name: 'cortextos-daemon', args: ['--instance', 'default'] },
      { name: 'ai-admin-backend', args: ['dev'] },
    ]);
    expect(parseDashboardModeFromDump(dump)).toBeNull();
  });

  it('returns null for a dashboard entry with unrecognizable args', () => {
    expect(parseDashboardModeFromDump(dumpWith({ name: 'cortextos-dashboard', args: [] }))).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseDashboardModeFromDump('not json {')).toBeNull();
  });

  it('returns null on non-array JSON', () => {
    expect(parseDashboardModeFromDump('{"apps":[]}')).toBeNull();
  });
});

describe('resolveDashboardMode', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const writeDump = (content: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'eco-dump-'));
    const p = join(dir, 'dump.pm2');
    writeFileSync(p, content, 'utf-8');
    return p;
  };

  it('explicit flag wins over a contradicting dump', () => {
    const dumpPath = writeDump(dumpWith({ name: 'cortextos-dashboard', args: ['dev'] }));
    expect(resolveDashboardMode('start', dumpPath)).toBe('start');
  });

  it('no flag: preserves the live mode from the dump', () => {
    const dumpPath = writeDump(dumpWith({ name: 'cortextos-dashboard', args: ['dev'] }));
    expect(resolveDashboardMode(undefined, dumpPath)).toBe('dev');
  });

  it('no flag, no dump file: defaults to start (fresh-install behavior)', () => {
    expect(resolveDashboardMode(undefined, join(tmpdir(), 'eco-no-such-dir', 'dump.pm2'))).toBe('start');
  });

  it('no flag, dump without a dashboard entry: defaults to start', () => {
    const dumpPath = writeDump(JSON.stringify([{ name: 'cortextos-daemon', args: [] }]));
    expect(resolveDashboardMode(undefined, dumpPath)).toBe('start');
  });

  it('no flag, dump path exists but is unreadable: defaults to start, never throws', () => {
    // A directory at the dump path makes readFileSync throw (EISDIR) — stands
    // in for any unreadable-dump condition (permissions, corruption mid-write).
    dir = mkdtempSync(join(tmpdir(), 'eco-dump-'));
    expect(resolveDashboardMode(undefined, dir)).toBe('start');
  });
});
