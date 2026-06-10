import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { discoverSkills } from '../bus/skill-discovery.js';

// Standalone `cortextos list-skills`. Shares discovery with
// `cortextos bus list-skills` (src/bus/skill-discovery.ts) — this file
// previously carried its own divergent copy that scanned layouts nothing
// uses (agentDir/skills, templates/<role>/skills), so it found nothing on
// real installs. Same root cause as the codex Total: 0 bug; one module now
// owns the layout knowledge.
export const listSkillsCommand = new Command('list-skills')
  .option('--format <format>', 'Output format (json|text)', 'text')
  .option('--agent-dir <dir>', 'Agent directory to scan')
  .description('List available skills for the current agent')
  .action(async (options: { format: string; agentDir?: string }) => {
    const agentDir = options.agentDir || process.cwd();

    let frameworkRoot: string;
    if (process.env.CTX_FRAMEWORK_ROOT) {
      frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    } else {
      const canonical = join(homedir(), 'cortextos');
      frameworkRoot = existsSync(join(canonical, 'orgs')) ? canonical : process.cwd();
    }

    let template = '';
    let runtime = '';
    const configPath = join(agentDir, 'config.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        template = config.template ?? '';
        runtime = config.runtime ?? '';
      } catch {
        // Ignore config read errors
      }
    }

    const skills = discoverSkills({ agentDir, frameworkRoot, template, runtime });

    if (options.format === 'json') {
      console.log(JSON.stringify(skills, null, 2));
    } else {
      if (skills.length === 0) {
        console.log('No skills found.');
        return;
      }
      console.log('Available skills:\n');
      for (const skill of skills) {
        console.log(`  ${skill.name} (${skill.source})`);
        console.log(`    ${skill.description}`);
        console.log('');
      }
      console.log(`Total: ${skills.length} skills`);
    }
  });
