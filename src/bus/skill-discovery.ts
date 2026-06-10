import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: string;
}

// Parse YAML frontmatter (name/description) from SKILL.md content.
export function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  const lines = content.split('\n');
  let inFrontmatter = false;
  let name = '';
  let description = '';
  for (const line of lines) {
    if (line.trim() === '---') {
      if (inFrontmatter) break;
      inFrontmatter = true;
      continue;
    }
    if (!inFrontmatter) continue;
    const nm = line.match(/^name:\s*['"]?(.+?)['"]?\s*$/);
    if (nm) name = nm[1];
    const dm = line.match(/^description:\s*['"]?(.+?)['"]?\s*$/);
    if (dm) description = dm[1];
  }
  return name ? { name, description } : null;
}

function scanSkillsDir(dir: string, source: string): Map<string, SkillInfo> {
  const map = new Map<string, SkillInfo>();
  if (!existsSync(dir)) return map;
  for (const entry of readdirSync(dir)) {
    const skillFile = join(dir, entry, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    let parsed: { name: string; description: string } | null = null;
    try {
      parsed = parseSkillFrontmatter(readFileSync(skillFile, 'utf-8'));
    } catch {
      // Unreadable skill file — skip it, never abort discovery.
    }
    if (parsed) map.set(parsed.name, { ...parsed, path: skillFile, source });
  }
  return map;
}

// Skills live in TWO layouts: Claude-runtime agents use <root>/.claude/skills,
// codex-runtime agents use <root>/plugins/<plugin>/skills (no .claude dir at
// all — this is why `bus list-skills` returned Total: 0 for prism). Scan both
// at every level; when both exist, .claude wins within the level.
function skillRootsFor(root: string): string[] {
  const roots: string[] = [];
  const pluginsDir = join(root, 'plugins');
  if (existsSync(pluginsDir)) {
    try {
      for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const skillsDir = join(pluginsDir, plugin.name, 'skills');
        if (existsSync(skillsDir)) roots.push(skillsDir);
      }
    } catch {
      // Unreadable plugins dir — fall through to .claude.
    }
  }
  roots.push(join(root, '.claude', 'skills'));
  return roots;
}

// config.template is null for every live agent (add-agent prints the template
// but never persists it), so a template-only scan would be dead fleet-wide.
// Mirror add-agent's effectiveTemplate resolution: codex runtime defaults to
// the agent-codex template, anything else to agent. An explicit template wins.
export function resolveTemplate(template: string | undefined | null, runtime: string | undefined | null): string {
  if (template) return template;
  return runtime === 'codex-app-server' ? 'agent-codex' : 'agent';
}

export interface DiscoverOptions {
  agentDir: string;
  frameworkRoot: string;
  template?: string | null;
  runtime?: string | null;
}

// Merge priority: framework < template < agent (agent wins on name collision).
export function discoverSkills(opts: DiscoverOptions): SkillInfo[] {
  const template = resolveTemplate(opts.template, opts.runtime);
  const merged = new Map<string, SkillInfo>();

  for (const dir of skillRootsFor(opts.frameworkRoot)) {
    for (const [k, v] of scanSkillsDir(dir, 'framework')) merged.set(k, v);
  }
  for (const dir of skillRootsFor(join(opts.frameworkRoot, 'templates', template))) {
    for (const [k, v] of scanSkillsDir(dir, `template:${template}`)) merged.set(k, v);
  }
  for (const dir of skillRootsFor(opts.agentDir)) {
    for (const [k, v] of scanSkillsDir(dir, 'agent')) merged.set(k, v);
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}
