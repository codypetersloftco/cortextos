import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';

// Analyst platform-change audit, 2026-07-07 (sealed criterion 5): the earlier
// tests for resolveClaudeConfigBaseDir() only proved the HELPER honors
// CLAUDE_CONFIG_DIR in isolation -- they say nothing about whether
// shouldContinue() actually WIRES that helper into its projects-dir lookup.
// A regression that keeps the helper correct but reverts (or breaks) the
// wiring -- e.g. mis-dashing launchDir, or falling back to a hardcoded path
// again -- would pass those tests while reintroducing the exact landmine
// this fix closes (same class as reference_unit_test_hides_caller_wiring_bug).
//
// Mocks 'os' so the "old default ~/.claude" path in these tests points at an
// isolated temp dir, never the real ~/.claude/projects on this machine.
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'cortextos-fakehome-'));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => FAKE_HOME };
});

const { hasClaudeConversationHistory } = await import('../../../src/daemon/agent-process.js');

// 2026-07-07 re-audit finding (analyst, criterion b): the ORIGINAL version of
// this test built its "expected" dashed dir with
// `launchDir.split(sep).join('-')` -- the EXACT SAME mangle the code-under-
// test used. That made the oracle self-consistently wrong: both sides agreed
// on a mangled path that only dashes path separators and leaves the Windows
// drive-colon intact (e.g. "C:-Users-..."), so the test stayed green even
// though the real on-disk Claude Code convention dashes EVERY non-alphanumeric
// character (e.g. "C--Users-..."). The real fleet directories under
// ~/.claude-test/projects/ are the actual oracle -- this constant reproduces
// that convention independently of src/daemon/agent-process.ts, so a
// regression back to split(sep).join('-') fails this test instead of passing it.
function realClaudeCodeMangle(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
}

describe('hasClaudeConversationHistory (shouldContinue wiring seam)', () => {
  let configuredHome: string;
  let savedConfigDir: string | undefined;
  const launchDir = join(sep, 'Users', 'cody', 'agents', 'testagent');
  const dashedDir = realClaudeCodeMangle(launchDir);

  // The drive-colon case boss/analyst's first audit missed entirely: on
  // Windows, join(sep, ...) never produces a drive letter (sep is just '\'),
  // so no prior test exercised a REAL absolute Windows path like
  // "C:\Users\cody\agents\testagent". This is the exact shape that broke on
  // the 2026-07-07 leg-2 bounce (dist still had the split(sep).join('-') bug,
  // colon survived as literal "C:", readdirSync ENOENT'd, every Claude agent
  // was forced fresh).
  const winLaunchDir = 'C:\\Users\\cody\\agents\\testagent';
  const winDashedDir = realClaudeCodeMangle(winLaunchDir);

  beforeEach(() => {
    configuredHome = mkdtempSync(join(tmpdir(), 'cortextos-configdir-'));
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    rmSync(configuredHome, { recursive: true, force: true });
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  it('POSITIVE: finds history under CLAUDE_CONFIG_DIR when the default dir has none', () => {
    process.env.CLAUDE_CONFIG_DIR = configuredHome;

    const configuredProjectsDir = join(configuredHome, 'projects', dashedDir);
    mkdirSync(configuredProjectsDir, { recursive: true });
    writeFileSync(join(configuredProjectsDir, 'session.jsonl'), '{}');

    // Default ~/.claude/projects/<dashed> (FAKE_HOME) deliberately does NOT exist.

    expect(hasClaudeConversationHistory(launchDir)).toBe(true);
  });

  it('INVERSE (the killer case): stale jsonl in the OLD default dir must NOT count once CLAUDE_CONFIG_DIR is set -- proves the coincidence path is severed', () => {
    process.env.CLAUDE_CONFIG_DIR = configuredHome;

    // The REAL configured dir's projects folder exists but is genuinely empty.
    const configuredProjectsDir = join(configuredHome, 'projects', dashedDir);
    mkdirSync(configuredProjectsDir, { recursive: true });

    // Stale leftover jsonl sitting in the OLD default ~/.claude/projects/<dashed>
    // (FAKE_HOME here) -- exactly the fleet-wide coincidence found in the
    // 2026-07-07 audit (every checked agent has leftover files there from
    // before the .claude-test convention).
    const staleDefaultProjectsDir = join(FAKE_HOME, '.claude', 'projects', dashedDir);
    mkdirSync(staleDefaultProjectsDir, { recursive: true });
    writeFileSync(join(staleDefaultProjectsDir, 'old-session.jsonl'), '{}');

    // On the PRE-FIX hardcoded-homedir() code, this would find the stale
    // file and return true. On the fix, it must return false -- the
    // configured (real, empty) dir governs, not the stale default one.
    expect(hasClaudeConversationHistory(launchDir)).toBe(false);
  });

  it('falls back to the default dir correctly when CLAUDE_CONFIG_DIR is unset', () => {
    delete process.env.CLAUDE_CONFIG_DIR;

    const defaultProjectsDir = join(FAKE_HOME, '.claude', 'projects', dashedDir);
    mkdirSync(defaultProjectsDir, { recursive: true });
    writeFileSync(join(defaultProjectsDir, 'session.jsonl'), '{}');

    expect(hasClaudeConversationHistory(launchDir)).toBe(true);
  });

  it('returns false when neither directory has any jsonl files', () => {
    process.env.CLAUDE_CONFIG_DIR = configuredHome;
    expect(hasClaudeConversationHistory(launchDir)).toBe(false);
  });

  describe('Windows drive-colon case (2026-07-07 leg-2 bounce failure)', () => {
    it('finds history under a real absolute Windows path including the drive letter', () => {
      process.env.CLAUDE_CONFIG_DIR = configuredHome;

      const configuredProjectsDir = join(configuredHome, 'projects', winDashedDir);
      mkdirSync(configuredProjectsDir, { recursive: true });
      writeFileSync(join(configuredProjectsDir, 'session.jsonl'), '{}');

      expect(hasClaudeConversationHistory(winLaunchDir)).toBe(true);
    });

    // Criterion (c) from the re-audit gate: a leg that FAILS under real
    // pre-fix conditions. This reproduces the OLD buggy mangle
    // (`.split(sep).join('-')`, which leaves the drive-colon as literal
    // "C:") directly -- proving it points somewhere history is NOT found,
    // i.e. proving the pre-fix code would have returned false here even
    // with real history present. If a future regression reintroduces the
    // old mangle inside hasClaudeConversationHistory, this test's second
    // assertion (the real function call) starts returning false and fails.
    it('the pre-fix drive-colon mangle would have missed real history (regression guard)', () => {
      process.env.CLAUDE_CONFIG_DIR = configuredHome;

      const preFixBuggyDir = winLaunchDir.split(sep).join('-'); // "C:-Users-..."
      expect(preFixBuggyDir).not.toBe(winDashedDir); // sanity: the two mangles genuinely differ

      const configuredProjectsDir = join(configuredHome, 'projects', winDashedDir);
      mkdirSync(configuredProjectsDir, { recursive: true });
      writeFileSync(join(configuredProjectsDir, 'session.jsonl'), '{}');

      // The pre-fix path (built with the old buggy mangle) has nothing under it.
      const preFixDir = join(configuredHome, 'projects', preFixBuggyDir);
      expect(() => require('fs').readdirSync(preFixDir)).toThrow();

      // The real function, post-fix, correctly finds the real dir.
      expect(hasClaudeConversationHistory(winLaunchDir)).toBe(true);
    });
  });

  // Analyst re-audit GO note (2026-07-07): realClaudeCodeMangle() above is
  // still a REGEX duplicated from the source's own formula -- if the SOURCE
  // regex were subtly wrong, a test oracle built from the identical regex
  // could share that exact mistake and never catch it (weaker independence
  // than criterion (b) intends). This block uses LITERAL hardcoded strings
  // copied directly from real `~/.claude-test/projects/` directory names
  // observed on this box -- zero regex, zero shared formula with the code
  // under test. A regression in the mangle logic (wrong regex, collapsed
  // dashes, missed character class) fails these on pure string comparison.
  describe('real fixture-dir oracle (hardcoded literal strings, zero shared formula with source)', () => {
    it('matches the real engineer agent project dir name observed on this box', () => {
      process.env.CLAUDE_CONFIG_DIR = configuredHome;

      const realLaunchDir = 'C:\\Users\\cody\\cortextos\\orgs\\loftco-autopilot\\agents\\engineer';
      // Literal, copied from `ls ~/.claude-test/projects/` -- not computed.
      const realObservedDirName = 'C--Users-cody-cortextos-orgs-loftco-autopilot-agents-engineer';

      const configuredProjectsDir = join(configuredHome, 'projects', realObservedDirName);
      mkdirSync(configuredProjectsDir, { recursive: true });
      writeFileSync(join(configuredProjectsDir, 'session.jsonl'), '{}');

      expect(hasClaudeConversationHistory(realLaunchDir)).toBe(true);
    });

    it('matches the real OneDrive-space-dash-space project dir name (proves per-char, non-collapsing dash rule)', () => {
      process.env.CLAUDE_CONFIG_DIR = configuredHome;

      const realLaunchDir = 'C:\\Users\\cody\\OneDrive - Loftco Inc\\Claude Workspace\\AI Admin';
      // Literal, copied from `ls ~/.claude-test/projects/` -- "OneDrive - Loftco Inc"
      // has 3 consecutive non-alnum chars (space,dash,space) -> 3 dashes, not 1.
      const realObservedDirName = 'C--Users-cody-OneDrive---Loftco-Inc-Claude-Workspace-AI-Admin';

      const configuredProjectsDir = join(configuredHome, 'projects', realObservedDirName);
      mkdirSync(configuredProjectsDir, { recursive: true });
      writeFileSync(join(configuredProjectsDir, 'session.jsonl'), '{}');

      expect(hasClaudeConversationHistory(realLaunchDir)).toBe(true);
    });
  });
});
