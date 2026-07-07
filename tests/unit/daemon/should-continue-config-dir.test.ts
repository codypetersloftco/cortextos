import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { resolveClaudeConfigBaseDir } from '../../../src/daemon/agent-process.js';

// 2026-07-07: shouldContinue()'s Claude-runtime continuity check previously
// hardcoded homedir()+'.claude' regardless of CLAUDE_CONFIG_DIR, so the
// continue/fresh decision was based on a DIFFERENT directory than the one the
// actual spawned `claude --continue` process resolves against. Currently
// masked fleet-wide by stale leftover .jsonl files sitting in the wrong
// default directory from before the CLAUDE_CONFIG_DIR=.claude-test
// convention -- a brand-new agent with no such stale files would get
// shouldContinue()=false even with real history under CLAUDE_CONFIG_DIR,
// forcing an incorrect fresh restart.
describe('resolveClaudeConfigBaseDir', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it('uses CLAUDE_CONFIG_DIR when set', () => {
    process.env.CLAUDE_CONFIG_DIR = 'C:/Users/cody/.claude-test';
    expect(resolveClaudeConfigBaseDir()).toBe('C:/Users/cody/.claude-test');
  });

  it('falls back to homedir()/.claude when unset', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(resolveClaudeConfigBaseDir()).toBe(join(homedir(), '.claude'));
  });

  it('falls back to homedir()/.claude when set to an empty string', () => {
    process.env.CLAUDE_CONFIG_DIR = '';
    expect(resolveClaudeConfigBaseDir()).toBe(join(homedir(), '.claude'));
  });

  it('falls back to homedir()/.claude when set to whitespace only', () => {
    process.env.CLAUDE_CONFIG_DIR = '   ';
    expect(resolveClaudeConfigBaseDir()).toBe(join(homedir(), '.claude'));
  });
});
