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

describe('hasClaudeConversationHistory (shouldContinue wiring seam)', () => {
  let configuredHome: string;
  let savedConfigDir: string | undefined;
  // Must use the OS-native separator, matching the real code's
  // launchDir.split(sep).join('-') -- a forward-slash test path would not
  // get dashed at all on Windows (sep is backslash there), silently
  // building a directory the function under test never looks in.
  const launchDir = join(sep, 'Users', 'cody', 'agents', 'testagent');
  const dashedDir = launchDir.split(sep).join('-');

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
});
