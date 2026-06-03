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

/**
 * Root-cause coverage for the worker-hang v3 fix: an ephemeral worker must launch
 * HEADLESS (`--print`) so the claude process exits when the one-shot task finishes.
 * Interactive sessions never emit a process exit, and WorkerProcess detects worker
 * completion ONLY via pty.onExit — so an interactive worker idles until the 45min
 * watchdog. Persistent agents must stay interactive (no --print) so they keep
 * running and accept injected messages.
 */
describe('AgentPTY — ephemeral-worker headless gate', () => {
  it('passes --print --output-format text when isEphemeralWorker=true', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeSpawnCapture();
    const pty = new AgentPTY(env as never, {}, undefined, undefined, true);
    (pty as unknown as { spawnFn: unknown }).spawnFn = fn;
    await pty.spawn('fresh', 'do the task');
    const args = calls[0].args;
    expect(args).toContain('--print');
    const ofIdx = args.indexOf('--output-format');
    expect(ofIdx).toBeGreaterThanOrEqual(0);
    expect(args[ofIdx + 1]).toBe('text');
    // The prompt must remain the final positional arg after the flags.
    expect(args[args.length - 1]).toBe('do the task');
  });

  it('does NOT pass --print for a normal persistent agent (stays interactive)', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeSpawnCapture();
    const pty = new AgentPTY(env as never, {}, undefined, undefined, false);
    (pty as unknown as { spawnFn: unknown }).spawnFn = fn;
    await pty.spawn('fresh', 'do the task');
    const args = calls[0].args;
    expect(args).not.toContain('--print');
    expect(args).not.toContain('--output-format');
  });

  it('keeps --print alongside --continue for a resumed worker', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeSpawnCapture();
    const pty = new AgentPTY(env as never, {}, undefined, undefined, true);
    (pty as unknown as { spawnFn: unknown }).spawnFn = fn;
    await pty.spawn('continue', 'resume the task');
    const args = calls[0].args;
    expect(args).toContain('--continue');
    expect(args).toContain('--print');
    expect(args[args.length - 1]).toBe('resume the task');
  });
});
