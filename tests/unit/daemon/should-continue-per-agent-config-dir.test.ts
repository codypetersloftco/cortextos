import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// 2026-07-07 leg-2 bounce: shouldContinue() failed a SECOND, independent way
// even after the drive-colon mangle fix. resolveClaudeConfigBaseDir() read
// process.env.CLAUDE_CONFIG_DIR -- but that variable is NOT present in the
// DAEMON's own process.env; it lives only in each agent's own .env file,
// merged into the CHILD's env at PTY spawn time (agent-pty.ts). The daemon-
// side shouldContinue() decision runs BEFORE that child spawn, in the
// daemon's process, so it always saw undefined and silently fell back to the
// wrong default dir. This test proves shouldContinue() resolves the AGENT's
// own .env value directly -- not the daemon process's env -- at the
// daemon-side decision point (analyst re-audit criterion a).
//
// Uses a mocked AgentPTY (never spawns a real process) and REAL temp
// directories for agentDir / ctxRoot / the configured CLAUDE_CONFIG_DIR, so
// the actual fs calls inside hasClaudeConversationHistory /
// resolveAgentClaudeConfigDir run against real paths, same style as
// has-claude-conversation-history-wiring.test.ts.

let capturedSpawnArgs: unknown[] | null = null;
const mockPty = {
  spawn: vi.fn().mockImplementation((...args: unknown[]) => {
    capturedSpawnArgs = args;
    return Promise.resolve(undefined);
  }),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(false) }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

const { AgentProcess, resolveClaudeConfigBaseDir } = await import('../../../src/daemon/agent-process.js');

describe('shouldContinue: per-agent CLAUDE_CONFIG_DIR resolution', () => {
  let ctxRoot: string;
  let agentDir: string;
  let configuredDir: string;
  let savedDaemonConfigDir: string | undefined;

  beforeEach(() => {
    capturedSpawnArgs = null;
    mockPty.spawn.mockClear();
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-ctxroot-'));
    agentDir = mkdtempSync(join(tmpdir(), 'cortextos-agentdir-'));
    configuredDir = mkdtempSync(join(tmpdir(), 'cortextos-configureddir-'));
    // Reproduce the real-world condition: the daemon's OWN process.env has
    // no CLAUDE_CONFIG_DIR (verified absent there by analyst 2026-07-07) --
    // only the agent's .env carries it.
    savedDaemonConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(configuredDir, { recursive: true, force: true });
    if (savedDaemonConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedDaemonConfigDir;
  });

  const mockEnv = () => ({
    instanceId: 'test',
    ctxRoot,
    frameworkRoot: tmpdir(),
    agentName: 'testagent',
    agentDir,
    org: 'acme',
    projectRoot: tmpdir(),
  });

  it('reads CLAUDE_CONFIG_DIR from the AGENT\'s own .env (not the daemon process.env) and spawns continue', async () => {
    // Agent's own .env -- the real source of truth, per agent-pty.ts's loader.
    writeFileSync(join(agentDir, '.env'), `CLAUDE_CONFIG_DIR=${configuredDir}\nBOT_TOKEN=fake\n`);

    // Real conversation history exists ONLY under the agent's configured dir,
    // dashed per the real Claude Code convention.
    const dashedAgentDir = agentDir.replace(/[^a-zA-Z0-9]/g, '-');
    const projectsDir = join(configuredDir, 'projects', dashedAgentDir);
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, 'session.jsonl'), '{}');

    const ap = new AgentProcess('testagent', mockEnv(), {});
    await ap.start();

    // process.env.CLAUDE_CONFIG_DIR is confirmed unset (beforeEach) -- the
    // ONLY way this resolves to 'continue' is if shouldContinue() read the
    // agent's own .env directly, per resolveAgentClaudeConfigDir().
    expect(mockPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });

  it('falls back to fresh when the agent .env has no CLAUDE_CONFIG_DIR and the real default dir has no history', async () => {
    writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=fake\n');
    // No history anywhere the fallback default would look -- can't safely
    // touch the real ~/.claude here, so this just proves no false-positive
    // 'continue' is produced when there is genuinely nothing to find.

    const ap = new AgentProcess('testagent', mockEnv(), {});
    await ap.start();

    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
  });

  it('regression guard: resolveClaudeConfigBaseDir() with no override (the pre-fix call shape) misses the agent-configured dir entirely', () => {
    writeFileSync(join(agentDir, '.env'), `CLAUDE_CONFIG_DIR=${configuredDir}\n`);

    // This is exactly how the pre-fix code called it -- no argument, so it
    // falls through to process.env (confirmed empty in this daemon-side
    // context) and then the hardcoded homedir()/.claude default. Proves the
    // env-scope bug in isolation: the agent's real configured dir is
    // reachable ONLY through the explicit per-agent override parameter.
    const preFixResolved = resolveClaudeConfigBaseDir();
    expect(preFixResolved).not.toBe(configuredDir);

    // The fix's call shape (explicit override, as shouldContinue() now uses
    // via resolveAgentClaudeConfigDir()) correctly reaches it.
    const postFixResolved = resolveClaudeConfigBaseDir(configuredDir);
    expect(postFixResolved).toBe(configuredDir);
  });
});
