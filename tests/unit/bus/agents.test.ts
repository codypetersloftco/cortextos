import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listAgents, notifyAgent, assertDeliverableRecipient } from '../../../src/bus/agents';
import type { BusPaths } from '../../../src/types';

describe('Agent Discovery', () => {
  let testDir: string;
  let ctxRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-agents-test-'));
    ctxRoot = testDir;
    // Point CTX_FRAMEWORK_ROOT at an isolated subdir (no orgs/ inside) so that
    // listAgents() sees a configured but empty framework root and does NOT fall
    // back to process.cwd() — which is the repo root and has a real orgs/ dir.
    process.env.CTX_FRAMEWORK_ROOT = join(testDir, 'framework');
    delete process.env.CTX_PROJECT_ROOT;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    // Clean up env vars
    delete process.env.CTX_FRAMEWORK_ROOT;
    delete process.env.CTX_PROJECT_ROOT;
  });

  describe('listAgents', () => {
    it('discovers agents from enabled-agents.json', () => {
      // Set up enabled-agents.json
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({
          boris: { org: 'acme', enabled: true },
          paul: { org: 'acme', enabled: true },
        }),
      );

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(2);
      expect(agents.map(a => a.name).sort()).toEqual(['boris', 'paul']);
      expect(agents[0].org).toBe('acme');
      expect(agents[0].enabled).toBe(true);
    });

    it('reads IDENTITY.md first line for role', () => {
      // Set up framework root with agent identity
      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

      const agentDir = join(frameworkRoot, 'orgs', 'testorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'IDENTITY.md'),
        '# Worker Agent\n\n## Role\nBackend developer responsible for API implementation\n',
      );

      // Set up enabled-agents.json
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ worker: { org: 'testorg', enabled: true } }),
      );

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].role).toBe('Backend developer responsible for API implementation');
    });

    it('handles missing files gracefully', () => {
      // No config dir, no heartbeats - should return empty array
      const agents = listAgents(ctxRoot);
      expect(agents).toEqual([]);
    });

    it('handles missing IDENTITY.md gracefully', () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ agent1: { org: 'org1', enabled: true } }),
      );

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].role).toBe('');
    });

    it('reads heartbeat data for status', () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ worker: { org: 'testorg', enabled: true } }),
      );

      // Write heartbeat to state dir (path: state/{agent}/heartbeat.json)
      const hbDir = join(ctxRoot, 'state', 'worker');
      mkdirSync(hbDir, { recursive: true });
      writeFileSync(
        join(hbDir, 'heartbeat.json'),
        JSON.stringify({
          agent: 'worker',
          timestamp: new Date().toISOString(),
          status: 'idle',
        }),
      );

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].last_heartbeat).toBeTruthy();
      expect(agents[0].running).toBe(true); // Recent heartbeat means running
    });

    it('filters by org when specified', () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({
          boris: { org: 'acme', enabled: true },
          other: { org: 'different', enabled: true },
        }),
      );

      const agents = listAgents(ctxRoot, 'acme');
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('boris');
    });

    // BUG-028: daemon and CLI must agree on what's enabled.
    // Previously, listAgents short-circuited on enabled-agents.json existence,
    // hiding agents the daemon was actually running from `cortextos list-agents`.
    it('shows agents from dir scan even when enabled-agents.json exists', () => {
      // Set up: enabled-agents.json with one agent (alice), but TWO dirs on disk
      // (alice and bob). Previously listAgents would only return alice. After
      // the fix, both should be returned.
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ alice: { org: 'acme', enabled: true } }),
      );

      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });

      const agents = listAgents(ctxRoot);
      expect(agents.map(a => a.name).sort()).toEqual(['alice', 'bob']);
    });

    // 2026-07-02 phantom `_shared` boot: orgs/<org>/agents/_shared holds shared
    // fleet assets (Telegram avatars), not an agent. Underscore-prefixed dirs are
    // reserved infra (mirroring state/_shared) and must never appear on the roster.
    it('excludes underscore-prefixed reserved dirs (_shared) from the dir scan', () => {
      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', '_shared', 'avatars'), { recursive: true });

      const agents = listAgents(ctxRoot);
      expect(agents.map(a => a.name)).toEqual(['alice']);
    });

    it('excludes underscore-prefixed names from the enabled-agents.json merge', () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({
          alice: { org: 'acme', enabled: true },
          _shared: { org: 'acme', enabled: true },
        }),
      );

      const agents = listAgents(ctxRoot);
      expect(agents.map(a => a.name)).toEqual(['alice']);
    });

    it('respects enabled: false from enabled-agents.json for agents found in dir scan', () => {
      // Set up: dir for alice + entry in enabled-agents.json saying enabled: false.
      // listAgents should return alice with enabled: false (not skip her entirely).
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ alice: { org: 'acme', enabled: false } }),
      );

      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });

      const agents = listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('alice');
      expect(agents[0].enabled).toBe(false);
    });
  });

  describe('notifyAgent', () => {
    let paths: BusPaths;

    beforeEach(() => {
      paths = {
        ctxRoot,
        inbox: join(ctxRoot, 'inbox', 'sender'),
        inflight: join(ctxRoot, 'inflight', 'sender'),
        processed: join(ctxRoot, 'processed', 'sender'),
        logDir: join(ctxRoot, 'logs', 'sender'),
        stateDir: join(ctxRoot, 'state', 'sender'),
        taskDir: join(ctxRoot, 'tasks'),
        approvalDir: join(ctxRoot, 'approvals'),
        analyticsDir: join(ctxRoot, 'analytics'),
        heartbeatDir: join(ctxRoot, 'heartbeats'),
      };
    });

    it('creates signal file and bus message', () => {
      mkdirSync(join(ctxRoot, 'inbox', 'target'), { recursive: true });
      notifyAgent(paths, 'sender', 'target', 'Wake up!', ctxRoot);

      // Check signal file exists
      const signalFile = join(ctxRoot, 'state', 'target', '.urgent-signal');
      expect(existsSync(signalFile)).toBe(true);

      // Check bus message was sent
      const targetInbox = join(ctxRoot, 'inbox', 'target');
      expect(existsSync(targetInbox)).toBe(true);
      const files = require('fs').readdirSync(targetInbox).filter((f: string) => f.endsWith('.json'));
      expect(files.length).toBe(1);
    });

    it('signal file has correct JSON format', () => {
      mkdirSync(join(ctxRoot, 'inbox', 'paul'), { recursive: true });
      notifyAgent(paths, 'boris', 'paul', 'New task available', ctxRoot);

      const signalFile = join(ctxRoot, 'state', 'paul', '.urgent-signal');
      const content = JSON.parse(readFileSync(signalFile, 'utf-8'));

      expect(content).toHaveProperty('from', 'boris');
      expect(content).toHaveProperty('message', 'New task available');
      expect(content).toHaveProperty('timestamp');
      // Verify timestamp is ISO 8601
      expect(new Date(content.timestamp).toISOString()).toBeTruthy();
    });

    it('creates state directory if it does not exist', () => {
      mkdirSync(join(ctxRoot, 'inbox', 'newagent'), { recursive: true });
      const stateDir = join(ctxRoot, 'state', 'newagent');
      expect(existsSync(stateDir)).toBe(false);

      notifyAgent(paths, 'sender', 'newagent', 'Hello', ctxRoot);

      expect(existsSync(stateDir)).toBe(true);
    });

    // Prism re-gate #2 (2026-07-02): the shared notifyAgent() helper is now the
    // ONE place both notify-agent CLI surfaces validate through — a live repro
    // against the pre-fix SHA showed `cortextos notify-agent norma ...` exiting 0
    // and recreating a retired-pseudonym state dir right after an inbox sweep.
    it('rejects an unknown/retired target BEFORE writing any signal file or state dir', () => {
      const stateDir = join(ctxRoot, 'state', 'norma');
      expect(() => notifyAgent(paths, 'sender', 'norma', 'hello', ctxRoot)).toThrow(/not a deliverable recipient.*dbanalyst/);
      expect(existsSync(stateDir)).toBe(false);
    });

    it('rejects a path-traversal target before any write', () => {
      expect(() => notifyAgent(paths, 'sender', '../state', 'hello', ctxRoot)).toThrow(/Invalid agent name/);
    });

    it('returns the normalized (lowercase) target name', () => {
      mkdirSync(join(ctxRoot, 'inbox', 'target'), { recursive: true });
      expect(notifyAgent(paths, 'sender', 'Target', 'Wake up!', ctxRoot)).toBe('target');
      expect(existsSync(join(ctxRoot, 'state', 'target', '.urgent-signal'))).toBe(true);
    });
  });

  // task_1782943545090: send-message / task-assign roster validation — a typo or
  // retired pseudonym must fail loudly, not silently dead-letter to an unwatched inbox.
  describe('assertDeliverableRecipient', () => {
    function enableAgent(name: string, org = 'acme') {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      const file = join(configDir, 'enabled-agents.json');
      const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};
      cur[name] = { org, enabled: true };
      writeFileSync(file, JSON.stringify(cur));
    }

    it('accepts a known enabled agent', () => {
      enableAgent('dbanalyst');
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'dbanalyst')).not.toThrow();
    });

    it('accepts a name that has an existing inbox dir (worker/prestage/system)', () => {
      mkdirSync(join(ctxRoot, 'inbox', 'worker-abc123'), { recursive: true });
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'worker-abc123')).not.toThrow();
    });

    it('rejects an unknown name with a roster hint', () => {
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'nobody')).toThrow(/not a known agent or worker/);
    });

    it('rejects a retired pseudonym alias and suggests the registry name', () => {
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'norma')).toThrow(/not a deliverable recipient.*dbanalyst/);
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'forge')).toThrow(/not a deliverable recipient.*engineer/);
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'sentinel')).toThrow(/not a deliverable recipient.*analyst/);
    });

    it('rejects template-default orchestrator names (chief/orchestrator) and suggests boss', () => {
      // task_1782937946305: the crash-alert emitter and worker report-back defaulted
      // to a hardcoded 'chief'/'orchestrator' with no consumer here.
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'chief')).toThrow(/not a deliverable recipient.*boss/);
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'orchestrator')).toThrow(/not a deliverable recipient.*boss/);
    });

    it('rejects a reserved shared-assets name (_shared) EVEN IF its inbox dir exists', () => {
      // The live ctxRoot really has inbox/_shared (created by the phantom boot) —
      // dir-existence must NOT grandfather a reserved infra dir in as a recipient.
      mkdirSync(join(ctxRoot, 'inbox', '_shared'), { recursive: true });
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, '_shared')).toThrow(/reserved/);
    });

    it('rejects an alias EVEN IF an orphan inbox dir exists (grandfather guard)', () => {
      // The exact bug: a prior dead-letter created inbox/norma/ or inbox/chief/.
      // Dir-existence must NOT grandfather the dead name in — the alias map overrides.
      mkdirSync(join(ctxRoot, 'inbox', 'norma'), { recursive: true });
      mkdirSync(join(ctxRoot, 'inbox', 'chief'), { recursive: true });
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'norma')).toThrow(/not a deliverable recipient/);
      expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'chief')).toThrow(/not a deliverable recipient/);
    });

    // Prism blind-gate finding #1 (bus-roster-validation fix-loop, 2026-07-01/02):
    // validateAgentName + lowercase-normalize must run FIRST, before the alias
    // check and before existsSync ever touches the filesystem.
    describe('prism finding #1: format-validate + lowercase-normalize before existsSync', () => {
      it('rejects a path-traversal name instead of falsely passing via existsSync', () => {
        // Bug: join(ctxRoot, 'inbox', '../state') resolves to ctxRoot/state, which
        // exists (created by resolvePaths/notifyAgent elsewhere), so the OLD
        // existsSync-only check would have passed it. The format check must
        // reject the raw string before any join()/existsSync runs.
        mkdirSync(join(ctxRoot, 'state'), { recursive: true });
        expect(() => assertDeliverableRecipient(ctxRoot, undefined, '../state')).toThrow(/Invalid agent name/);
      });

      it('accepts a known agent typed in a different case, normalized to canonical lowercase', () => {
        enableAgent('boss');
        expect(assertDeliverableRecipient(ctxRoot, undefined, 'Boss')).toBe('boss');
        expect(assertDeliverableRecipient(ctxRoot, undefined, 'BOSS')).toBe('boss');
      });

      it('returns the normalized (already-lowercase) name for a plain valid recipient', () => {
        enableAgent('dbanalyst');
        expect(assertDeliverableRecipient(ctxRoot, undefined, 'dbanalyst')).toBe('dbanalyst');
      });

      it('rejects a retired-pseudonym alias EVEN when typed in a different case (alias-case)', () => {
        // Case-bypass: on a case-insensitive filesystem, 'Norma' skips the
        // case-sensitive RECIPIENT_ALIASES lookup and listAgents match, then
        // existsSync(inbox/Norma) can resolve to the same dir as inbox/norma —
        // grandfathering the retired name back in via capitalization alone.
        mkdirSync(join(ctxRoot, 'inbox', 'norma'), { recursive: true });
        expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'Norma')).toThrow(/not a deliverable recipient.*dbanalyst/);
        expect(() => assertDeliverableRecipient(ctxRoot, undefined, 'NORMA')).toThrow(/not a deliverable recipient.*dbanalyst/);
      });
    });
  });
});
