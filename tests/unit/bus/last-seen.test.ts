import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types';
import { touchLastSeen, shouldRefreshLastSeen, LAST_SEEN_WRITE_OPS } from '../../../src/bus/heartbeat';

// CH3: refresh last_seen on a SESSION-ORIGIN bus WRITE so an active-via-bus agent
// (between heartbeat-cron fires) is not falsely flagged stale. The gate + writer.
describe('CH3 shouldRefreshLastSeen (gate — the 4 acceptance cases)', () => {
  // (1) live-PTY CLI write, not suppressed → REFRESH
  it('write-op + not suppressed → true (normal live agent bus write)', () => {
    for (const op of LAST_SEEN_WRITE_OPS) {
      expect(shouldRefreshLastSeen(op, false)).toBe(true);
    }
  });

  // (2) crash-alert TEARDOWN send-message (suppressed) → STALE (must NOT refresh a dying agent)
  it('write-op + suppressed → false (teardown / on-behalf opt-out)', () => {
    expect(shouldRefreshLastSeen('send-message', true)).toBe(false);
    expect(shouldRefreshLastSeen('log-event', true)).toBe(false);
  });

  // (3) reads → no refresh (they do not prove ongoing work)
  it('read-ops → false even when not suppressed', () => {
    for (const op of ['check-inbox', 'ack-inbox', 'list-tasks', 'recall-facts', 'kb-query', 'list-agents']) {
      expect(shouldRefreshLastSeen(op, false)).toBe(false);
    }
  });

  // (4) surfaceWorkerExit (daemon-DIRECT worker_failed) never reaches the CLI, so it
  // never hits this gate at all → worker last_seen stays stale. Structural, not gated.
  it('unknown/non-CLI command name → false (daemon-direct never reaches the gate)', () => {
    expect(shouldRefreshLastSeen('worker_failed', false)).toBe(false);
    expect(shouldRefreshLastSeen('', false)).toBe(false);
  });
});

describe('CH3 touchLastSeen (writer)', () => {
  let tmp: string;
  let paths: BusPaths;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ch3-lastseen-'));
    paths = { ctxRoot: tmp, stateDir: tmp } as unknown as BusPaths;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('bumps last_heartbeat while PRESERVING all other fields', () => {
    const hbPath = join(tmp, 'heartbeat.json');
    writeFileSync(hbPath, JSON.stringify({
      agent: 'engineer', org: 'loftco', status: 'working on X',
      current_task: 'task_123', mode: 'day', last_heartbeat: '2020-01-01T00:00:00Z',
      loop_interval: '4h',
    }), 'utf-8');
    touchLastSeen(paths, 'engineer');
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
    expect(hb.last_heartbeat).not.toBe('2020-01-01T00:00:00Z'); // refreshed
    expect(hb.last_heartbeat).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(hb.status).toBe('working on X');     // PRESERVED — not clobbered
    expect(hb.current_task).toBe('task_123');   // PRESERVED
    expect(hb.org).toBe('loftco');              // PRESERVED
    expect(hb.mode).toBe('day');                // PRESERVED
  });

  it('creates a minimal heartbeat (agent + last_heartbeat) when absent', () => {
    const hbPath = join(tmp, 'heartbeat.json');
    expect(existsSync(hbPath)).toBe(false);
    touchLastSeen(paths, 'penny');
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
    expect(hb.agent).toBe('penny');
    expect(hb.last_heartbeat).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('never throws on a bad/corrupt state (best-effort)', () => {
    writeFileSync(join(tmp, 'heartbeat.json'), '{ not valid json', 'utf-8');
    expect(() => touchLastSeen(paths, 'engineer')).not.toThrow();
    // corrupt → rewritten minimal, still valid
    const hb = JSON.parse(readFileSync(join(tmp, 'heartbeat.json'), 'utf-8'));
    expect(hb.agent).toBe('engineer');
    expect(hb.last_heartbeat).toBeTruthy();
  });
});
