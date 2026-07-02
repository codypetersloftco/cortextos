import { Command } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { resolvePaths } from '../utils/paths.js';
import { notifyAgent } from '../bus/agents.js';

export const notifyAgentCommand = new Command('notify-agent')
  .description('Send an urgent notification to an agent')
  .argument('<name>', 'Target agent name')
  .argument('<message>', 'Message to send')
  .option('--from <agent>', 'Sender agent name', 'cli')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--org <org>', 'Org name (scopes the roster check to one org)')
  .action((name: string, message: string, options: { from: string; instance: string; org?: string }) => {
    const paths = resolvePaths(options.from, options.instance);
    const ctxRoot = join(homedir(), '.cortextos', options.instance);

    // notifyAgent() roster-validates before any write (prism re-gate #2,
    // 2026-07-02) — this top-level command was the surface that slipped
    // through the first fix, calling the (then-unguarded) shared helper
    // directly with no validation of its own.
    try {
      const target = notifyAgent(paths, options.from, name, message, ctxRoot, options.org);
      console.log(`Signal sent to ${target}`);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
  });
