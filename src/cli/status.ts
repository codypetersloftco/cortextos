import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';
import type { DaemonHealth } from '../daemon/ipc-server.js';
import type { AgentStatus, Heartbeat } from '../types/index.js';

/**
 * Honest failure wording per health state. Only no_pipe may claim the daemon
 * is not running — every other failure is "could not reach", because a CLI
 * shell cannot discriminate a down daemon from an unreachable one (e.g. a
 * Session-0 service whose pipe this session may not access).
 */
export function statusFailureMessage(health: DaemonHealth): string {
  switch (health.state) {
    case 'no_pipe':
      return 'Daemon is not running (no IPC pipe). Showing last known heartbeats:\n';
    case 'timeout':
    case 'refused':
      return (
        `Could not reach the daemon after ${health.attempts} attempt(s) — it may be busy or starting.\n` +
        'Showing last known heartbeats; re-run in a few seconds for live status.\n'
      );
    case 'permission_denied':
      return (
        'Daemon IPC pipe exists but access was denied — the daemon may be running as a service in another session.\n' +
        'Showing last known heartbeats:\n'
      );
    default:
      return (
        `Could not reach the daemon (${health.code || health.message || 'unknown error'}).\n` +
        'Showing last known heartbeats:\n'
      );
  }
}

export const statusCommand = new Command('status')
  .option('--instance <id>', 'Instance ID')
  .option('--debug', 'Show IPC diagnostics (pipe path, probe attempts)')
  .description('Show agent health and status')
  .action(async (options: { instance?: string; debug?: boolean }) => {
    const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';
    const ipc = new IPCClient(instanceId);
    const health = await ipc.probeDaemon({
      onAttempt: options.debug
        ? (attempt, state) => console.log(`  [debug] probe attempt ${attempt}: ${state}`)
        : undefined,
    });
    if (options.debug) {
      console.log(`  [debug] IPC pipe: ${health.pipePath}`);
    }

    if (health.state === 'running') {
      // Get live status from daemon
      const response = await ipc.send({ type: 'status', source: 'cortextos status' });
      if (response.success) {
        const statuses = response.data as AgentStatus[];
        displayStatuses(statuses);
      }
    } else {
      // Fall back to reading heartbeat files
      console.log(statusFailureMessage(health));
      const ctxRoot = join(homedir(), '.cortextos', instanceId);
      const stateDir = join(ctxRoot, 'state');

      if (!existsSync(stateDir)) {
        console.log('  No heartbeat data found.');
        console.log('  Start with: cortextos start');
        return;
      }

      const agentDirs = readdirSync(stateDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      if (agentDirs.length === 0) {
        console.log('  No agents have reported heartbeats.');
        return;
      }

      const rows: Array<{ agent: string; status: string; age: string; task: string }> = [];
      for (const agent of agentDirs) {
        const hbPath = join(stateDir, agent, 'heartbeat.json');
        try {
          const hb: Heartbeat = JSON.parse(readFileSync(hbPath, 'utf-8'));
          const ts = hb.last_heartbeat || hb.timestamp || new Date().toISOString();
          const age = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
          const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
          rows.push({
            agent: hb.agent || agent,
            status: hb.status || 'unknown',
            age: ageStr,
            task: hb.current_task ? hb.current_task.substring(0, 30) : '-',
          });
        } catch {
          // Skip agents without heartbeat
        }
      }

      if (rows.length === 0) {
        console.log('  No agents have reported heartbeats.');
      } else {
        console.log('\n  Last Known Heartbeats\n');
        const header = '  Name              Status      Last Seen    Current Task';
        const separator = '  ' + '-'.repeat(header.length - 2);
        console.log(header);
        console.log(separator);
        for (const r of rows) {
          const name = r.agent.padEnd(18);
          const status = r.status.padEnd(12);
          const age = r.age.padEnd(13);
          console.log(`  ${name}${status}${age}${r.task}`);
        }
        console.log('');
      }
    }
  });

function displayStatuses(statuses: AgentStatus[]): void {
  if (statuses.length === 0) {
    console.log('No agents running.');
    console.log('Add one with: cortextos add-agent <name>');
    return;
  }

  console.log('\n  Agent Status\n');

  // Table header
  const header = '  Name              Status      PID       Uptime      Model';
  const separator = '  ' + '-'.repeat(header.length - 2);
  console.log(header);
  console.log(separator);

  for (const s of statuses) {
    const name = s.name.padEnd(18);
    const status = s.status.padEnd(12);
    const pid = (s.pid?.toString() || '-').padEnd(10);
    const uptime = s.uptime ? formatUptime(s.uptime).padEnd(12) : '-'.padEnd(12);
    const model = s.model || '-';
    console.log(`  ${name}${status}${pid}${uptime}${model}`);
  }

  console.log('');
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
