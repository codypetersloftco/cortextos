import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCodexPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(13579),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
  setTelegramHandle: vi.fn(),
};

const mockAgentPty = {
  ...mockCodexPty,
  setTelegramHandle: undefined,
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-pty.js', () => ({
  CodexPTY: function CodexPTY() { return mockCodexPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const childProcessMocks = {
  execFileSync: vi.fn(),
};

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    get execFileSync() { return childProcessMocks.execFileSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  mockCodexPty.spawn.mockClear();
  mockCodexPty.kill.mockClear();
  mockCodexPty.write.mockClear();
  mockCodexPty.getPid.mockClear();
  mockCodexPty.isAlive.mockReset().mockReturnValue(true);
  mockCodexPty.onExit.mockClear();
  mockCodexPty.getOutputBuffer.mockClear();
  mockCodexPty.setTelegramHandle.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  childProcessMocks.execFileSync.mockReset();
});

describe('AgentProcess codex runtime shouldContinue', () => {
  it('spawns in fresh mode when Codex state DB does not exist', async () => {
    fsMocks.existsSync.mockReturnValue(false);

    const ap = new AgentProcess('codex-agent', mockEnv, { runtime: 'codex' });
    await ap.start();

    expect(mockCodexPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();
  });

  it('spawns in continue mode when Codex has a cwd-matched thread', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path.endsWith('state_5.sqlite'));
    childProcessMocks.execFileSync.mockReturnValue('thread-id\n');

    const ap = new AgentProcess('codex-agent', mockEnv, { runtime: 'codex' });
    await ap.start();

    expect(mockCodexPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      'sqlite3',
      [
        expect.stringContaining('state_5.sqlite'),
        expect.stringContaining("cwd = '/tmp/fw/orgs/acme/agents/codex-agent'"),
      ],
      expect.objectContaining({ encoding: 'utf-8', timeout: 3000 }),
    );
  });

  it('spawns in fresh mode when the Codex SQLite lookup returns no rows', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path.endsWith('state_5.sqlite'));
    childProcessMocks.execFileSync.mockReturnValue('\n');

    const ap = new AgentProcess('codex-agent', mockEnv, { runtime: 'codex' });
    await ap.start();

    expect(mockCodexPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
  });
});
