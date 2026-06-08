import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

// Capture PTY exit handler so tests can simulate worker exit
let capturedOnExit: ((code: number) => void) | null = null;
let capturedPtyConfig: unknown = null;
let capturedPtyArgs: unknown[] = [];
const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  onExit: vi.fn().mockImplementation((cb: (code: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY(...args: unknown[]) {
    capturedPtyArgs = args;
    capturedPtyConfig = args[1];
    return mockPty;
  },
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(), unlinkSync: vi.fn() };
});

const { WorkerProcess } = await import('../../../src/daemon/worker-process.js');
const { writeFileSync: mockWriteFileSync, unlinkSync: mockUnlinkSync } = await import('fs');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'test-worker',
  agentDir: '/tmp/project',
  org: 'testorg',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  capturedPtyConfig = null;
  capturedPtyArgs = [];
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockInjectMessage.mockClear();
  vi.mocked(mockWriteFileSync).mockClear();
  vi.mocked(mockUnlinkSync).mockClear();
});

describe('WorkerProcess', () => {
  describe('construction', () => {
    it('sets name, dir, parent', () => {
      const w = new WorkerProcess('w1', '/tmp/proj', 'parent-agent');
      expect(w.name).toBe('w1');
      expect(w.dir).toBe('/tmp/proj');
      expect(w.parent).toBe('parent-agent');
    });

    it('parent is optional', () => {
      const w = new WorkerProcess('w2', '/tmp/proj', undefined);
      expect(w.parent).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('returns starting status before spawn', () => {
      const w = new WorkerProcess('w3', '/tmp/proj', 'parent');
      const s = w.getStatus();
      expect(s.status).toBe('starting');
      expect(s.name).toBe('w3');
      expect(s.dir).toBe('/tmp/proj');
      expect(s.parent).toBe('parent');
      expect(s.spawnedAt).toBeTruthy();
      expect(s.pid).toBeUndefined();
    });

    it('returns running after spawn', async () => {
      const w = new WorkerProcess('w4', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'do the task');
      expect(w.getStatus().status).toBe('running');
      expect(w.getStatus().pid).toBe(12345);
    });
  });

  describe('isFinished', () => {
    it('is false before spawn', () => {
      const w = new WorkerProcess('w5', '/tmp/proj', undefined);
      expect(w.isFinished()).toBe(false);
    });

    it('is false while running', async () => {
      const w = new WorkerProcess('w6', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(w.isFinished()).toBe(false);
    });

    it('is true after successful exit', async () => {
      const w = new WorkerProcess('w7', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      expect(w.isFinished()).toBe(true);
    });
  });

  describe('inject', () => {
    it('returns false before spawn', () => {
      const w = new WorkerProcess('w8', '/tmp/proj', undefined);
      expect(w.inject('nudge')).toBe(false);
      expect(mockInjectMessage).not.toHaveBeenCalled();
    });

    it('injects text when running', async () => {
      const w = new WorkerProcess('w9', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(w.inject('continue with phase 3')).toBe(true);
      expect(mockInjectMessage).toHaveBeenCalled();
    });

    it('returns false after exit', async () => {
      const w = new WorkerProcess('w10', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      expect(w.inject('too late')).toBe(false);
    });
  });

  describe('onDone callback', () => {
    it('fires with exit code 0 and marks completed', async () => {
      const w = new WorkerProcess('w11', '/tmp/proj', undefined);
      const doneSpy = vi.fn();
      w.onDone(doneSpy);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      expect(doneSpy).toHaveBeenCalledWith('w11', 0);
      expect(w.getStatus().status).toBe('completed');
      expect(w.getStatus().exitCode).toBe(0);
    });

    it('marks status as failed on non-zero exit', async () => {
      const w = new WorkerProcess('w12', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(1);
      expect(w.getStatus().status).toBe('failed');
      expect(w.getStatus().exitCode).toBe(1);
    });
  });

  describe('model config (#283)', () => {
    it('passes empty config to AgentPTY when no model arg is supplied', async () => {
      const w = new WorkerProcess('w-model-default', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(capturedPtyConfig).toEqual({});
    });

    it('threads model into AgentPTY config when supplied', async () => {
      const w = new WorkerProcess('w-model-explicit', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task', { model: 'claude-opus-4-7' });
      expect(capturedPtyConfig).toEqual({ model: 'claude-opus-4-7' });
    });
  });

  describe('terminate', () => {
    it('kills the PTY and marks completed', async () => {
      const w = new WorkerProcess('w13', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      await w.terminate();
      expect(mockPty.kill).toHaveBeenCalled();
      expect(w.getStatus().status).toBe('completed');
    });

    it('is a no-op if not running', async () => {
      const w = new WorkerProcess('w14', '/tmp/proj', undefined);
      await w.terminate(); // should not throw
      expect(mockPty.kill).not.toHaveBeenCalled();
    });
  });

  describe('ephemeral-worker Stop-hook gate (root-cause fix)', () => {
    it('marks the PTY as an ephemeral worker so the memory-save Stop hook skips it', async () => {
      const w = new WorkerProcess('w-eph', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      // AgentPTY(env, config, logPath, bootstrapPattern, isEphemeralWorker)
      expect(capturedPtyArgs[4]).toBe(true);
    });
  });

  describe('ephemeral-worker filesystem marker (Windows-safe Stop-hook gate)', () => {
    it('writes the marker in the worker cwd (dir) before the session starts', async () => {
      const w = new WorkerProcess('w-mark', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(vi.mocked(mockWriteFileSync)).toHaveBeenCalledWith(
        join('/tmp/proj', '.cortextos-ephemeral-worker'),
        expect.stringContaining('w-mark'),
        'utf-8',
      );
      // written before spawn so it exists by the time the Stop hook fires
      const writeOrder = vi.mocked(mockWriteFileSync).mock.invocationCallOrder[0];
      const spawnOrder = mockPty.spawn.mock.invocationCallOrder[0];
      expect(writeOrder).toBeLessThan(spawnOrder);
    });

    it('does NOT remove the marker on normal exit (the SessionEnd hook consumes it — removing here raced the hook and mis-logged clean exits as crashes)', async () => {
      const w = new WorkerProcess('w-mark2', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      // The marker must SURVIVE the daemon's onExit so the SessionEnd crash-alert
      // hook (a separate process firing concurrently) can still read it and
      // classify the exit as worker-complete. The hook is the marker's last
      // reader and now owns its removal. (Race fix: task_1780941278942.)
      expect(vi.mocked(mockUnlinkSync)).not.toHaveBeenCalledWith(
        join('/tmp/proj', '.cortextos-ephemeral-worker'),
      );
    });

    it('removes the marker on terminate (watchdog path)', async () => {
      const w = new WorkerProcess('w-mark3', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      await w.terminate();
      expect(vi.mocked(mockUnlinkSync)).toHaveBeenCalledWith(
        join('/tmp/proj', '.cortextos-ephemeral-worker'),
      );
    });

    it('exposes the marker filename as a constant', () => {
      expect(WorkerProcess.EPHEMERAL_MARKER).toBe('.cortextos-ephemeral-worker');
    });
  });

  describe('watchdog backstop', () => {
    it('force-terminates a worker that exceeds maxRuntimeMs', async () => {
      vi.useFakeTimers();
      try {
        const w = new WorkerProcess('w-wd', '/tmp/proj', undefined);
        await w.spawn(mockEnv, 'task', { maxRuntimeMs: 1000 });
        expect(mockPty.kill).not.toHaveBeenCalled();
        // Fire the watchdog (1000ms) + let terminate()'s internal sleep(500) resolve.
        await vi.advanceTimersByTimeAsync(2000);
        expect(mockPty.kill).toHaveBeenCalled();
        expect(w.getStatus().status).toBe('completed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT fire after the worker exits normally (watchdog cleared)', async () => {
      vi.useFakeTimers();
      try {
        const w = new WorkerProcess('w-wd2', '/tmp/proj', undefined);
        await w.spawn(mockEnv, 'task', { maxRuntimeMs: 1000 });
        capturedOnExit!(0); // normal completion clears the watchdog
        await vi.advanceTimersByTimeAsync(5000);
        expect(mockPty.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('can be disabled with maxRuntimeMs=0', async () => {
      vi.useFakeTimers();
      try {
        const w = new WorkerProcess('w-wd3', '/tmp/proj', undefined);
        await w.spawn(mockEnv, 'task', { maxRuntimeMs: 0 });
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(mockPty.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
