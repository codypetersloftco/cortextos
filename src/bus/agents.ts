import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentInfo, AgentConfig, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { sendMessage } from './message.js';
import { validateAgentName } from '../utils/validate.js';

/**
 * Known non-recipient names → the registry name they should resolve to. A send to
 * one of these ALWAYS rejects with a suggestion — this overrides the inbox-dir
 * existence test below, since orphaned dead-letter dirs (e.g. an inbox/norma/ or
 * inbox/chief/ created by the very bugs we are fixing) would otherwise grandfather
 * the dead name in forever. task_1782943545090 / task_1782937946305.
 */
export const RECIPIENT_ALIASES: Record<string, string> = {
  // Retired agent pseudonyms (Cody governance 2026-07-01).
  norma: 'dbanalyst',
  forge: 'engineer',
  sentinel: 'analyst',
  // Template-default orchestrator names with no consumer in this org — a hardcoded
  // 'chief'/'orchestrator' recipient silently dead-lettered crash alerts + worker
  // completion reports. Suggest the real org orchestrator.
  orchestrator: 'boss',
  chief: 'boss',
};

/**
 * Validate that `name` is a deliverable message/task recipient before we write to
 * its inbox (roster-validation, task_1782943545090). Throws with a self-correcting
 * suggestion on an unknown or retired name so a typo/pseudonym fails loudly instead
 * of silently dead-lettering to an unwatched inbox/<name>/ dir. Returns the
 * lowercase-normalized name callers should actually use downstream (send-message,
 * createTask/updateTask's assigned_to, notify-agent) so a differently-cased but
 * valid input still lands on the ONE canonical inbox dir.
 *
 * Legit recipients: known agents (listAgents — dir scan + enabled-agents.json) OR
 * any name that already has an inbox dir. Ephemeral workers create their inbox at
 * spawn (worker-process.ts) and enabled agents at enable time, so inbox-existence
 * covers workers/prestage/system without enumerating every pattern — provided the
 * deploy paired an orphan-inbox hygiene sweep so the signal stays honest.
 *
 * Format-validate + lowercase-normalize FIRST, before the alias/existence checks
 * below (prism blind-gate finding #1). Two real bugs this closes:
 *   1. Path traversal: with no charset check ahead of it, `existsSync(join(ctxRoot,
 *      'inbox', name))` for name='../state' resolves to ctxRoot/state (which
 *      exists) and falsely passes. validateAgentName's charset (no '.', '/')
 *      rejects it outright before any join()/existsSync runs.
 *   2. Case-bypass of the alias deny-list: on a case-insensitive filesystem
 *      (Windows/macOS), 'Norma' skips the case-sensitive RECIPIENT_ALIASES
 *      lookup and listAgents match, then existsSync(inbox/Norma) resolves to the
 *      SAME directory as inbox/norma — grandfathering a retired pseudonym back in
 *      via a capitalization variant. Normalizing to lowercase before every check
 *      closes the gap.
 */
export function assertDeliverableRecipient(ctxRoot: string, org: string | undefined, name: string): string {
  const normalized = name.toLowerCase();
  validateAgentName(normalized);

  const suggestion = RECIPIENT_ALIASES[normalized];
  if (suggestion) {
    throw new Error(
      `'${name}' is not a deliverable recipient — did you mean '${suggestion}'? ` +
      `(cortextos bus list-agents). Message not delivered.`,
    );
  }
  const known = listAgents(ctxRoot, org).some((a) => a.name === normalized);
  if (known) return normalized;
  if (existsSync(join(ctxRoot, 'inbox', normalized))) return normalized;
  throw new Error(
    `'${name}' is not a known agent or worker — check the roster with 'cortextos bus list-agents'. ` +
    `Message not delivered (was it a typo or a retired name?).`,
  );
}

/**
 * List all agents in the system.
 *
 * Merges two sources of truth:
 *   1. The framework directory scan (`${CTX_FRAMEWORK_ROOT}/orgs/<org>/agents/`)
 *      — this is what the daemon discovers and runs.
 *   2. `enabled-agents.json` — explicit user-set enable/disable state from
 *      `cortextos enable`/`disable` and the dashboard.
 *
 * BUG-028: previously this function treated `enabled-agents.json` as
 * authoritative — if the file existed, the directory scan was skipped, causing
 * `cortextos list-agents` to miss agents that the daemon was actually running.
 * Now both sources are always merged, with the file providing the explicit
 * enabled flag and the directory scan providing the canonical existence check.
 */
export function listAgents(ctxRoot: string, org?: string): AgentInfo[] {
  const agents: AgentInfo[] = [];
  const seen = new Set<string>();

  // 1. Read enabled-agents.json for explicit enable/disable state.
  // This is treated as metadata, not as the list of agents to display.
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  let enabledAgents: Record<string, { org?: string; enabled?: boolean }> = {};
  if (existsSync(enabledFile)) {
    try {
      enabledAgents = JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      // Skip corrupt file — fall through to directory scan only.
    }
  }

  // 2. ALWAYS scan org agent directories (BUG-028 fix).
  // The directory scan is now the primary source for "what agents exist".
  // The enabled-agents.json entries are merged in as metadata.
  const cliProjectRoot = process.env.CTX_FRAMEWORK_ROOT;
  const scanRoots: string[] = [];
  if (cliProjectRoot && existsSync(join(cliProjectRoot, 'orgs'))) {
    scanRoots.push(cliProjectRoot);
  }
  // Fallback: cwd, but ONLY when CTX_FRAMEWORK_ROOT is completely unset.
  // If CTX_FRAMEWORK_ROOT is set (even to a path without orgs/), respect it and
  // do not scan cwd — the caller explicitly configured a root that has no agents.
  // This prevents test contamination when cwd happens to be the framework repo.
  if (scanRoots.length === 0 && !cliProjectRoot) {
    const cwd = process.cwd();
    if (existsSync(join(cwd, 'orgs'))) {
      scanRoots.push(cwd);
    }
  }

  for (const root of scanRoots) {
    const orgsDir = join(root, 'orgs');
    if (!existsSync(orgsDir)) continue;

    let orgDirs: string[];
    try {
      orgDirs = readdirSync(orgsDir);
    } catch {
      continue;
    }

    for (const orgName of orgDirs) {
      if (org && orgName !== org) continue;

      const agentsDir = join(orgsDir, orgName, 'agents');
      if (!existsSync(agentsDir)) continue;

      let agentDirs: string[];
      try {
        agentDirs = readdirSync(agentsDir);
      } catch {
        continue;
      }

      for (const agentName of agentDirs) {
        if (!/^[a-z0-9_-]+$/.test(agentName)) continue;
        if (seen.has(agentName)) continue;

        seen.add(agentName);

        // Determine enabled state: explicit from enabled-agents.json if present,
        // otherwise default to enabled (matches the daemon's discoverAndStart
        // default-on behavior).
        const explicitEntry = enabledAgents[agentName];
        const isEnabled = explicitEntry ? explicitEntry.enabled !== false : true;

        agents.push(buildAgentInfo(agentName, orgName, isEnabled, ctxRoot));
      }
    }
  }

  // 3. Append any entries from enabled-agents.json that don't have a corresponding
  // directory on disk (stale registrations — file has them but the dir was deleted
  // or never existed). These are surfaced so users can clean them up.
  for (const [name, cfg] of Object.entries(enabledAgents)) {
    if (!/^[a-z0-9_-]+$/.test(name)) continue;
    if (seen.has(name)) continue;
    const agentOrg = cfg.org || '';
    if (org && agentOrg !== org) continue;
    seen.add(name);
    agents.push(buildAgentInfo(name, agentOrg, cfg.enabled !== false, ctxRoot));
  }

  return agents;
}

/**
 * Build an AgentInfo object by reading heartbeat, IDENTITY.md, and config.
 */
function buildAgentInfo(
  name: string,
  org: string,
  enabled: boolean,
  ctxRoot: string,
): AgentInfo {
  // Read heartbeat from state dir (bash uses state/{agent}/heartbeat.json)
  let lastHeartbeat: string | null = null;
  let currentTask: string | null = null;
  let mode: string | null = null;
  let running = false;

  const stateHeartbeat = join(ctxRoot, 'state', name, 'heartbeat.json');
  if (existsSync(stateHeartbeat)) {
    try {
      const hb = JSON.parse(readFileSync(stateHeartbeat, 'utf-8'));
      lastHeartbeat = hb.last_heartbeat || hb.timestamp || null;
      currentTask = hb.current_task || null;
      mode = hb.mode || null;
      // Running = heartbeat written within last 10 minutes
      if (lastHeartbeat) {
        const age = Date.now() - new Date(lastHeartbeat).getTime();
        running = age < 10 * 60 * 1000;
      }
    } catch {
      // Skip corrupt
    }
  }

  // Get display name and role from IDENTITY.md
  let role = '';
  let displayName: string | undefined;
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  if (frameworkRoot) {
    const identityPaths = [
      join(frameworkRoot, 'orgs', org, 'agents', name, 'IDENTITY.md'),
      join(frameworkRoot, 'agents', name, 'IDENTITY.md'),
    ];
    for (const idPath of identityPaths) {
      if (existsSync(idPath)) {
        try {
          const content = readFileSync(idPath, 'utf-8');
          const lines = content.split('\n');

          // Parse "## Name" — user-configured display name (e.g. "Alpha", "Beta")
          const nameIdx = lines.findIndex(l => l.trim() === '## Name');
          if (nameIdx >= 0) {
            for (let i = nameIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line || line.startsWith('<!--')) continue;
              if (line.startsWith('##')) break;
              displayName = line;
              break;
            }
          }

          // Find "## Role" then take the first non-empty, non-comment line after it
          const roleIdx = lines.findIndex(l => l.startsWith('## Role'));
          if (roleIdx >= 0) {
            for (let i = roleIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              // Skip empty lines and HTML comment placeholders
              if (!line || line.startsWith('<!--') || line.startsWith('##')) break;
              role = line;
              break;
            }
          }
          // Fallback: first non-comment, non-heading line
          if (!role) {
            for (const line of lines) {
              const t = line.trim();
              if (t && !t.startsWith('#') && !t.startsWith('<!--')) {
                role = t;
                break;
              }
            }
          }
        } catch {
          // Skip
        }
        break;
      }
    }
  }

  // Read config.json for model info
  const configFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  if (configFrameworkRoot) {
    const configPaths = [
      join(configFrameworkRoot, 'orgs', org, 'agents', name, 'config.json'),
      join(configFrameworkRoot, 'agents', name, 'config.json'),
    ];
    for (const cfgPath of configPaths) {
      if (existsSync(cfgPath)) {
        try {
          const cfg: AgentConfig = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          if (cfg.enabled !== undefined) enabled = cfg.enabled;
        } catch {
          // Skip
        }
        break;
      }
    }
  }

  return {
    name,
    org,
    display_name: displayName,
    role,
    enabled,
    running,
    last_heartbeat: lastHeartbeat,
    current_task: currentTask,
    mode,
  };
}

/**
 * Send an urgent notification to an agent.
 * Writes .urgent-signal file and sends a bus message.
 * Mirrors bash notify-agent.sh behavior.
 */
export function notifyAgent(
  paths: BusPaths,
  from: string,
  targetAgent: string,
  message: string,
  ctxRoot: string,
): void {
  // Write signal file to state dir
  const signalDir = join(ctxRoot, 'state', targetAgent);
  ensureDir(signalDir);

  const signal = {
    from,
    message,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };

  atomicWriteSync(join(signalDir, '.urgent-signal'), JSON.stringify(signal));

  // Also send via normal message bus for persistence
  try {
    sendMessage(paths, from, targetAgent, 'urgent', message);
  } catch {
    // Ignore bus send failures - signal file is the primary mechanism
  }
}
