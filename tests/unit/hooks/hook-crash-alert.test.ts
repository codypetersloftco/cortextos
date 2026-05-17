import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { readMaxCrashesPerDay, notifyAgents, checkAndRecordSession } from '../../../src/hooks/hook-crash-alert';

describe('readMaxCrashesPerDay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when agentDir is undefined', () => {
    expect(readMaxCrashesPerDay(undefined)).toBeNull();
  });

  it('returns null when config.json is missing', () => {
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{ not valid json', 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when max_crashes_per_day is missing', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'x' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns the configured number when present', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 10 }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBe(10);
  });

  it('returns null when max_crashes_per_day is not a number', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 'ten' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });
});

describe('notifyAgents', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('sends one bus send-message per recipient', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'uncaught exception',
      lastTask: 'building hooks',
      crashCount: 2,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses cortextos bus send-message with priority high', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
  });

  it('body includes all required fields', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'daemon-crashed',
      reason: 'PTY null write',
      lastTask: 'idle',
      crashCount: 3,
      restartAttempted: false,
      recipients: ['analyst'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('agent=dev');
    expect(body).toContain('type=daemon-crashed');
    expect(body).toContain('reason: PTY null write');
    expect(body).toContain('last status: idle');
    expect(body).toContain('crashes today: 3');
    expect(body).toContain('restart attempted: no');
  });

  it('marks restart attempted yes when crashCount under limit', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    expect(execFileMock.mock.calls[0][1][4]).toContain('restart attempted: yes');
  });

  it('uses fallback strings when reason and lastTask are empty', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('reason: none');
    expect(body).toContain('last status: unknown');
  });

  it('does not throw when execFile throws synchronously', () => {
    execFileMock.mockImplementationOnce(() => { throw new Error('exec failed'); });
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    })).not.toThrow();
    // Second recipient still attempted
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('checkAndRecordSession', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-session-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('first sighting of a session_id is not a duplicate', () => {
    expect(checkAndRecordSession(tmp, 'sess-aaa').duplicate).toBe(false);
  });

  it('second firing for the SAME session_id is a duplicate', () => {
    // First firing — the dying PTY's SessionEnd.
    expect(checkAndRecordSession(tmp, 'sess-aaa').duplicate).toBe(false);
    // Second firing — the next PTY's fresh-launch cleanup, same session-end.
    expect(checkAndRecordSession(tmp, 'sess-aaa').duplicate).toBe(true);
  });

  it('a new session_id after one was recorded is not a duplicate (real crash path)', () => {
    checkAndRecordSession(tmp, 'sess-aaa');
    // A genuine later crash is a different session — must always be processed.
    expect(checkAndRecordSession(tmp, 'sess-bbb').duplicate).toBe(false);
  });

  it('empty session_id is never a duplicate (cannot dedup → FP-safe fall-through)', () => {
    expect(checkAndRecordSession(tmp, '').duplicate).toBe(false);
    // An empty id must not be recorded, so it cannot later swallow a real end.
    expect(checkAndRecordSession(tmp, '').duplicate).toBe(false);
  });

  it('records the session_id to .crash_last_session for cross-process dedup', () => {
    checkAndRecordSession(tmp, 'sess-ccc');
    expect(readFileSync(join(tmp, '.crash_last_session'), 'utf-8').trim()).toBe('sess-ccc');
  });
});
