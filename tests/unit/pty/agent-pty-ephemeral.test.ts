import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentPTY } from '../../../src/pty/agent-pty.js';

/**
 * Root-cause coverage for the worker-hang fix: an ephemeral worker's claude
 * session must carry CTX_EPHEMERAL_WORKER=1 in its environment so the global
 * memory-checkpoint Stop hook (mempal_save_hook.sh) gates itself off and does
 * not block the one-shot worker into a long memory-save (the 60-120min hang).
 * A normal persistent agent must NOT carry it (the hook stays active for it).
 */

function fakeSpawnCapture() {
  const calls: Array<{ file: string; args: string[]; opts: { env?: Record<string, string> } }> = [];
  const fn = (file: string, args: string[], opts: { env?: Record<string, string> }) => {
    calls.push({ file, args, opts });
    return {
      pid: 999,
      write() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      kill() {},
      resize() {},
    };
  };
  return { fn, calls };
}

const env = {
  instanceId: 'i',
  ctxRoot: '/tmp/nonexistent-ctx',
  frameworkRoot: '/tmp/nonexistent-fw',
  agentName: 'a',
  agentDir: '/tmp/nonexistent-proj',
  org: 'o',
  projectRoot: '/tmp/nonexistent-fw',
};

afterEach(() => vi.useRealTimers());

describe('AgentPTY — ephemeral-worker env gate', () => {
  it('sets CTX_EPHEMERAL_WORKER=1 when isEphemeralWorker=true', async () => {
    vi.useFakeTimers(); // swallow the trust-prompt setTimeouts cleanly
    const { fn, calls } = fakeSpawnCapture();
    // (env, config, logPath, bootstrapPattern, isEphemeralWorker)
    const pty = new AgentPTY(env as never, {}, undefined, undefined, true);
    (pty as unknown as { spawnFn: unknown }).spawnFn = fn; // bypass native node-pty
    await pty.spawn('fresh', 'do the task');
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.env?.CTX_EPHEMERAL_WORKER).toBe('1');
  });

  it('does NOT set CTX_EPHEMERAL_WORKER for a normal persistent agent', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeSpawnCapture();
    const pty = new AgentPTY(env as never, {}, undefined, undefined, false);
    (pty as unknown as { spawnFn: unknown }).spawnFn = fn;
    await pty.spawn('fresh', 'do the task');
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.env?.CTX_EPHEMERAL_WORKER).toBeUndefined();
  });

  it('defaults to NOT a worker when the flag is omitted', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeSpawnCapture();
    const pty = new AgentPTY(env as never, {}, undefined);
    (pty as unknown as { spawnFn: unknown }).spawnFn = fn;
    await pty.spawn('fresh', 'do the task');
    expect(calls[0].opts.env?.CTX_EPHEMERAL_WORKER).toBeUndefined();
  });
});
