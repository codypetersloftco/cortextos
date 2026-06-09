import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Prism red-team 2026-06-09 (procedure-fix-loophole-redteam): the live agents
// carry the capture-as-task / backlog-drain / verify-before-surfacing rules,
// but templates and community copies encoded the older behavior — so every
// newly scaffolded agent silently reintroduced the old failure modes. These
// tests pin the canonical language into EVERY template so drift is caught at
// test time, not after a new agent drops work on the floor.
//
// Discovery is glob-based on purpose: a future template added under
// templates/ or community/agents/ is covered automatically, with no test edit.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function findTemplateFiles(filename: string): string[] {
  const results: string[] = [];
  for (const base of [join(repoRoot, 'templates'), join(repoRoot, 'community', 'agents')]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(base, entry.name, filename);
      if (existsSync(candidate)) results.push(candidate);
    }
  }
  return results;
}

function findTasksSkillFiles(): string[] {
  // tasks SKILL.md lives at varying depths: .claude/skills/tasks/,
  // plugins/*/skills/tasks/, and community/skills/tasks/.
  const results: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tasks' && dir.endsWith('skills')) {
          const skill = join(p, 'SKILL.md');
          if (existsSync(skill)) results.push(skill);
        } else {
          walk(p, depth + 1);
        }
      }
    }
  };
  walk(join(repoRoot, 'templates'), 0);
  walk(join(repoRoot, 'community'), 0);
  return results;
}

// Canonical markers — substrings of the required language. Matching on
// distinctive fragments (not full rows) lets each template keep its own
// surrounding idiom while guaranteeing the rule itself is present.
const GUARDRAIL_MARKERS: Record<string, string> = {
  'capture-as-task (finding 1)': 'Create a TASK for it immediately',
  'canonical task threshold (finding 2)': 'survive the current turn',
  'backlog-drain (finding 1)': 'failure state, not a rest state',
  'verify-before-surfacing (finding 5)': 'Verify the LIVE state',
};

const HEARTBEAT_MARKERS: Record<string, string> = {
  'backlog-drain rule (finding 1)': 'FAILURE STATE, not a rest state',
  'lane-scoped global backlog check (finding 3a)': 'global backlog check',
};

describe('template parity: GUARDRAILS.md carries the canonical rules', () => {
  const files = findTemplateFiles('GUARDRAILS.md');

  it('discovers the template guardrail files', () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1).replace(/\\/g, '/');
    describe(rel, () => {
      for (const [rule, marker] of Object.entries(GUARDRAIL_MARKERS)) {
        it(`has ${rule}`, () => {
          expect(readFileSync(file, 'utf-8')).toContain(marker);
        });
      }
    });
  }
});

describe('template parity: HEARTBEAT.md carries backlog-drain + global check', () => {
  const files = findTemplateFiles('HEARTBEAT.md');

  it('discovers the template heartbeat files', () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1).replace(/\\/g, '/');
    describe(rel, () => {
      for (const [rule, marker] of Object.entries(HEARTBEAT_MARKERS)) {
        it(`has ${rule}`, () => {
          expect(readFileSync(file, 'utf-8')).toContain(marker);
        });
      }
    });
  }
});

describe('template parity: tasks SKILL.md leads with the canonical threshold', () => {
  const files = findTasksSkillFiles();

  it('discovers the tasks skill files', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1).replace(/\\/g, '/');
    it(`${rel} has the canonical capture rule (finding 2)`, () => {
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('survive the current turn');
      expect(content).toContain('one parent task');
    });
  }
});
