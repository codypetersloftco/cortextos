import { describe, it, expect, vi } from 'vitest';
import {
  IPCClient,
  classifyIpcError,
  isTransientHealthState,
  type DaemonHealthState,
} from '../../../src/daemon/ipc-server.js';
import { statusFailureMessage } from '../../../src/cli/status.js';

describe('classifyIpcError', () => {
  it('maps ENOENT to no_pipe (daemon genuinely not running)', () => {
    expect(classifyIpcError('ENOENT')).toBe('no_pipe');
  });

  it('maps refused-class codes to refused', () => {
    expect(classifyIpcError('ECONNREFUSED')).toBe('refused');
    expect(classifyIpcError('EBUSY')).toBe('refused');
    expect(classifyIpcError('EAGAIN')).toBe('refused');
  });

  it('maps ETIMEDOUT to timeout', () => {
    expect(classifyIpcError('ETIMEDOUT')).toBe('timeout');
  });

  it('maps EPERM/EACCES to permission_denied (Session-0 pipe-ACL discriminator)', () => {
    expect(classifyIpcError('EPERM')).toBe('permission_denied');
    expect(classifyIpcError('EACCES')).toBe('permission_denied');
  });

  it('maps unknown codes to error', () => {
    expect(classifyIpcError('EWHATEVER')).toBe('error');
    expect(classifyIpcError(undefined)).toBe('error');
  });
});

describe('isTransientHealthState', () => {
  it('only timeout and refused are retryable', () => {
    const all: DaemonHealthState[] = ['running', 'no_pipe', 'refused', 'timeout', 'permission_denied', 'error'];
    const transient = all.filter(isTransientHealthState);
    expect(transient.sort()).toEqual(['refused', 'timeout']);
  });
});

describe('IPCClient.probeDaemon retry policy', () => {
  function clientWithProbeSequence(states: DaemonHealthState[]): { client: IPCClient; probe: ReturnType<typeof vi.fn> } {
    const client = new IPCClient('test-instance');
    let i = 0;
    const probe = vi.fn(async () => {
      const state = states[Math.min(i, states.length - 1)];
      i++;
      return { state };
    });
    (client as unknown as { probeOnce: typeof probe }).probeOnce = probe;
    return { client, probe };
  }

  it('returns immediately on running (1 attempt)', async () => {
    const { client, probe } = clientWithProbeSequence(['running']);
    const health = await client.probeDaemon({ backoffMs: [1, 1] });
    expect(health.state).toBe('running');
    expect(health.attempts).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on no_pipe — a missing pipe is decisive', async () => {
    const { client, probe } = clientWithProbeSequence(['no_pipe']);
    const health = await client.probeDaemon({ backoffMs: [1, 1] });
    expect(health.state).toBe('no_pipe');
    expect(health.attempts).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on permission_denied — retrying cannot fix ACLs', async () => {
    const { client, probe } = clientWithProbeSequence(['permission_denied']);
    const health = await client.probeDaemon({ backoffMs: [1, 1] });
    expect(health.state).toBe('permission_denied');
    expect(health.attempts).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('retries through transient states and succeeds (timeout, timeout, running)', async () => {
    const { client, probe } = clientWithProbeSequence(['timeout', 'timeout', 'running']);
    const health = await client.probeDaemon({ retries: 2, backoffMs: [1, 1] });
    expect(health.state).toBe('running');
    expect(health.attempts).toBe(3);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('exhausts retries on persistent refused and reports refused with attempt count', async () => {
    const { client, probe } = clientWithProbeSequence(['refused', 'refused', 'refused']);
    const health = await client.probeDaemon({ retries: 2, backoffMs: [1, 1] });
    expect(health.state).toBe('refused');
    expect(health.attempts).toBe(3);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('reports onAttempt for each probe', async () => {
    const { client } = clientWithProbeSequence(['timeout', 'running']);
    const seen: Array<[number, DaemonHealthState]> = [];
    await client.probeDaemon({ retries: 2, backoffMs: [1, 1], onAttempt: (n, s) => seen.push([n, s]) });
    expect(seen).toEqual([
      [1, 'timeout'],
      [2, 'running'],
    ]);
  });

  it('includes the pipe path in the health result', async () => {
    const { client } = clientWithProbeSequence(['no_pipe']);
    const health = await client.probeDaemon({ backoffMs: [1] });
    expect(health.pipePath).toBeTruthy();
  });
});

describe('statusFailureMessage honest wording', () => {
  const base = { attempts: 1, pipePath: '\\\\.\\pipe\\cortextos-test' };

  it('no_pipe is the ONLY state allowed to say "not running"', () => {
    expect(statusFailureMessage({ state: 'no_pipe', ...base })).toContain('Daemon is not running');
  });

  it('timeout/refused say "could not reach", never "not running"', () => {
    for (const state of ['timeout', 'refused'] as const) {
      const msg = statusFailureMessage({ state, ...base, attempts: 3 });
      expect(msg).toContain('Could not reach the daemon');
      expect(msg).toContain('3 attempt(s)');
      expect(msg).not.toMatch(/is not running/i);
    }
  });

  it('permission_denied says access denied + another session, never "not running"', () => {
    const msg = statusFailureMessage({ state: 'permission_denied', code: 'EPERM', ...base });
    expect(msg).toContain('access was denied');
    expect(msg).toContain('another session');
    expect(msg).not.toMatch(/is not running/i);
  });

  it('error includes the code and never claims "not running"', () => {
    const msg = statusFailureMessage({ state: 'error', code: 'EWEIRD', ...base });
    expect(msg).toContain('EWEIRD');
    expect(msg).not.toMatch(/is not running/i);
  });
});
