// Locks the "Booting up... one moment" (AGENTS.md step 1) suppression matrix in
// the daemon prompt builders. The agent-driven boot message is suppressed by a
// skip-step-1 directive the daemon injects; this is the correctness guarantee for
// whenever a daemon restart loads the built dist (extends b983ec3, which only
// gated the separate "back online" class). Four branches:
//   - suppressed-fleet cold boot  -> omit step 1  (skip directive present)
//   - solo/unsuppressed cold boot -> KEEP step 1  (no skip directive)
//   - handoff restart             -> omit step 1 + send "back — <state>"
//   - --continue refresh          -> ALWAYS omit step 1 (independent of suppression)
import { describe, it, expect, vi, beforeEach } from 'vitest';

const noopPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(111),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
  setTelegramHandle: vi.fn(),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: function () { return noopPty; } }));
vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({ CodexAppServerPTY: function () { return noopPty; } }));
vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function () { return noopPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));
vi.mock('../../../src/utils/atomic.js', () => ({ ensureDir: vi.fn(), atomicWriteSync: vi.fn() }));
vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));
vi.mock('../../../src/bus/reminders.js', () => ({ getOverdueReminders: vi.fn().mockReturnValue([]) }));
vi.mock('../../../src/utils/paths.js', () => ({ resolvePaths: vi.fn().mockReturnValue({}) }));

// Per-test switches consulted by the path-aware fs mock.
let suppressBootPing = false;
let handoffActive = false;
const HANDOFF_DOC = '/tmp/fw/handoff-resume.md';

const fsMocks = {
  existsSync: vi.fn((p: unknown) => {
    const s = String(p);
    if (s.endsWith('.handoff-doc-path')) return handoffActive;
    if (s.includes('handoff-resume.md')) return handoffActive;
    if (s.includes('context.json')) return true;
    return false; // .onboarded / ONBOARDING.md / heartbeat.json -> absent
  }),
  readFileSync: vi.fn((p: unknown) => {
    const s = String(p);
    if (s.endsWith('.handoff-doc-path')) return HANDOFF_DOC;
    if (s.includes('context.json')) return JSON.stringify({ suppress_boot_ping: suppressBootPing });
    return '';
  }),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'eng',
  agentDir: '/tmp/fw/orgs/acme/agents/eng',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

const STEP1_SKIP = 'skip AGENTS.md step 1';
const BACK_ONLINE = 'you are back online';

function makeAp() {
  return new AgentProcess('eng', mockEnv as any, { runtime: 'claude-code' } as any) as any;
}

beforeEach(() => {
  suppressBootPing = false;
  handoffActive = false;
});

describe('boot-message (AGENTS.md step 1) suppression matrix', () => {
  it('suppressed-fleet cold boot: omits step 1, omits back-online', () => {
    suppressBootPing = true;
    const p = makeAp().buildStartupPrompt();
    expect(p).toContain(STEP1_SKIP);
    expect(p).not.toContain(BACK_ONLINE);
  });

  it('solo/unsuppressed cold boot: KEEPS step 1, sends back-online', () => {
    suppressBootPing = false;
    const p = makeAp().buildStartupPrompt();
    expect(p).not.toContain(STEP1_SKIP);
    expect(p).toContain(BACK_ONLINE);
  });

  it('handoff restart: omits step 1 (via handoff UX) + sends "back —", no back-online', () => {
    handoffActive = true;
    suppressBootPing = false;
    const p = makeAp().buildStartupPrompt();
    expect(p).toContain('HANDOFF UX');
    expect(p).toContain(STEP1_SKIP);
    expect(p).toContain('back —');
    expect(p).not.toContain(BACK_ONLINE);
  });

  it('--continue refresh (suppressed): omits step 1, omits back-online', () => {
    suppressBootPing = true;
    const p = makeAp().buildContinuePrompt();
    expect(p).toContain(STEP1_SKIP);
    expect(p).not.toContain(BACK_ONLINE);
  });

  it('--continue refresh ALWAYS omits step 1, even unsuppressed (still sends back-online)', () => {
    suppressBootPing = false;
    const p = makeAp().buildContinuePrompt();
    expect(p).toContain(STEP1_SKIP); // unconditional on --continue
    expect(p).toContain(BACK_ONLINE); // online clause still present when unsuppressed
  });
});
