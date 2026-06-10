import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverSkills, parseSkillFrontmatter, resolveTemplate } from '../../../src/bus/skill-discovery.js';

// Regression for "prism list-skills returns Total: 0": bus list-skills only
// scanned the Claude layout (.claude/skills) and only scanned a template dir
// when config.template was set — but codex agents keep skills under
// plugins/<plugin>/skills and config.template is null for every live agent,
// so BOTH scan paths were dead and codex agents always saw zero skills.

function writeSkill(dir: string, slug: string, name = slug, description = `${slug} desc`): void {
  const d = join(dir, slug);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf-8');
}

describe('resolveTemplate', () => {
  it('explicit template always wins', () => {
    expect(resolveTemplate('analyst', 'codex-app-server')).toBe('analyst');
  });
  it('codex runtime defaults to agent-codex (mirrors add-agent effectiveTemplate)', () => {
    expect(resolveTemplate(null, 'codex-app-server')).toBe('agent-codex');
    expect(resolveTemplate(undefined, 'codex-app-server')).toBe('agent-codex');
    expect(resolveTemplate('', 'codex-app-server')).toBe('agent-codex');
  });
  it('claude runtime (and unknown/missing) defaults to agent', () => {
    expect(resolveTemplate(null, 'claude-code')).toBe('agent');
    expect(resolveTemplate(null, null)).toBe('agent');
  });
});

describe('parseSkillFrontmatter', () => {
  it('extracts name and description', () => {
    expect(parseSkillFrontmatter('---\nname: foo\ndescription: bar\n---\nbody')).toEqual({
      name: 'foo',
      description: 'bar',
    });
  });
  it('returns null without a name', () => {
    expect(parseSkillFrontmatter('---\ndescription: bar\n---\n')).toBeNull();
  });
});

describe('discoverSkills', () => {
  let root: string;
  let frameworkRoot: string;
  let agentDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skilldisc-'));
    frameworkRoot = join(root, 'framework');
    agentDir = join(root, 'agent');
    mkdirSync(frameworkRoot, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds codex-layout agent skills (plugins/<plugin>/skills) — the prism Total:0 repro', () => {
    writeSkill(join(agentDir, 'plugins', 'cortextos-agent-skills', 'skills'), 'tasks');
    writeSkill(join(agentDir, 'plugins', 'cortextos-agent-skills', 'skills'), 'comms');
    const skills = discoverSkills({ agentDir, frameworkRoot, template: null, runtime: 'codex-app-server' });
    expect(skills.map((s) => s.name)).toEqual(['comms', 'tasks']);
    expect(skills[0].source).toBe('agent');
  });

  it('still finds claude-layout agent skills (.claude/skills) — no regression', () => {
    writeSkill(join(agentDir, '.claude', 'skills'), 'memory');
    const skills = discoverSkills({ agentDir, frameworkRoot, template: null, runtime: 'claude-code' });
    expect(skills.map((s) => s.name)).toEqual(['memory']);
  });

  it('null template + codex runtime scans the agent-codex template dir (both layouts)', () => {
    writeSkill(join(frameworkRoot, 'templates', 'agent-codex', 'plugins', 'cortextos-agent-skills', 'skills'), 'heartbeat');
    const skills = discoverSkills({ agentDir, frameworkRoot, template: null, runtime: 'codex-app-server' });
    expect(skills.map((s) => s.name)).toEqual(['heartbeat']);
    expect(skills[0].source).toBe('template:agent-codex');
  });

  it('null template + claude runtime scans the agent template dir', () => {
    writeSkill(join(frameworkRoot, 'templates', 'agent', '.claude', 'skills'), 'memory');
    const skills = discoverSkills({ agentDir, frameworkRoot, template: null, runtime: 'claude-code' });
    expect(skills.map((s) => s.name)).toEqual(['memory']);
    expect(skills[0].source).toBe('template:agent');
  });

  it('agent-level skill overrides template and framework skills of the same name', () => {
    writeSkill(join(frameworkRoot, '.claude', 'skills'), 'tasks', 'tasks', 'framework version');
    writeSkill(join(frameworkRoot, 'templates', 'agent', '.claude', 'skills'), 'tasks', 'tasks', 'template version');
    writeSkill(join(agentDir, '.claude', 'skills'), 'tasks', 'tasks', 'agent version');
    const skills = discoverSkills({ agentDir, frameworkRoot, template: 'agent', runtime: 'claude-code' });
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('agent version');
    expect(skills[0].source).toBe('agent');
  });

  it('within one level, .claude wins over plugins on a name collision', () => {
    writeSkill(join(agentDir, 'plugins', 'p1', 'skills'), 'tasks', 'tasks', 'plugins version');
    writeSkill(join(agentDir, '.claude', 'skills'), 'tasks', 'tasks', 'claude version');
    const skills = discoverSkills({ agentDir, frameworkRoot, template: null, runtime: 'claude-code' });
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('claude version');
  });

  it('returns empty (not an error) when nothing exists anywhere', () => {
    expect(discoverSkills({ agentDir, frameworkRoot, template: null, runtime: null })).toEqual([]);
  });

  it('skips skill dirs whose SKILL.md lacks a name', () => {
    const d = join(agentDir, '.claude', 'skills', 'broken');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), '---\ndescription: nameless\n---\n', 'utf-8');
    expect(discoverSkills({ agentDir, frameworkRoot, template: null, runtime: 'claude-code' })).toEqual([]);
  });
});
