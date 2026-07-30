import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCron, updateCron, writeCrons, readCrons } from '../../../src/bus/crons.js';
import type { CronDefinition } from '../../../src/types/index.js';

/**
 * The guard took THREE placements to land, and each wrong one looked complete:
 *   1. cli/bus.ts beside `add-cron`  — missed the dashboard/IPC and migration
 *   2. addCron / updateCron          — missed migration, which calls writeCrons DIRECTLY
 *   3. writeCrons                    — the actual bottom; every caller delegates here
 *
 * So the load-bearing tests are NOT "does it warn" — they are:
 *   (a) it fires on the path that BYPASSES addCron/updateCron (migration's writeCrons), and
 *   (b) it does NOT re-fire when the prompt is unchanged, because writeCrons runs on every
 *       scheduler stamp (~6x/day/cron) and a routine warning stops being read.
 */

const PW = "PGPASSWORD='SyntheticNotARealSecretValue' python3 watch.py";
const PLAIN = 'Check the inbox and work on your highest priority task.';

function cron(name: string, prompt: string): CronDefinition {
  return { name, prompt, schedule: '4h', enabled: true, created_at: '2026-07-20T00:00:00Z' };
}

describe('embedded-credential warning lives on writeCrons', () => {
  let root: string, warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ctx-crons-'));
    process.env.CTX_ROOT = root;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    delete process.env.CTX_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  const warnings = () => warn.mock.calls.map(c => String(c[0])).filter(s => s.includes('CREDENTIAL'));

  it('(a) THE BYPASS: a direct writeCrons — migration\'s path — still warns', () => {
    // cron-migration.ts imports writeCrons DIRECTLY and never touches addCron/updateCron.
    // With the guard on addCron/updateCron this test FAILS, which is the point.
    writeCrons('a1', [cron('imported', PW)]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('imported');
  });

  it('(b) THE NOISE TEST: an unchanged prompt does NOT re-warn on a later write', () => {
    writeCrons('a2', [cron('watch', PW)]);
    expect(warnings()).toHaveLength(1);
    warn.mockClear();

    // the scheduler stamps last_fire_attempted_at ~6x/day — prompt untouched
    updateCron('a2', 'watch', { last_fire_attempted_at: '2026-07-30T15:00:00Z' });
    updateCron('a2', 'watch', { last_fire_attempted_at: '2026-07-30T19:00:00Z' });
    expect(warnings()).toHaveLength(0);
  });

  it('a CHANGED prompt warns again — an edit can introduce a secret', () => {
    writeCrons('a3', [cron('watch', PLAIN)]);
    expect(warnings()).toHaveLength(0);
    updateCron('a3', 'watch', { prompt: PW });
    expect(warnings()).toHaveLength(1);
  });

  it('addCron still warns (it delegates to writeCrons)', () => {
    addCron('a4', cron('new-one', PW));
    expect(warnings()).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: an ordinary prompt never warns, on any path', () => {
    // Without this, a guard that warned on everything would pass every case above.
    addCron('a5', cron('plain', PLAIN));
    updateCron('a5', 'plain', { prompt: PLAIN + ' Also check crons.' });
    writeCrons('a5', [cron('plain2', PLAIN)]);
    expect(warnings()).toHaveLength(0);
  });

  it('POSITIVE CONTROL: the writes actually land', () => {
    // Guards every assertion above: if writeCrons silently wrote nothing, "no warning" and
    // "correctly quiet" would be indistinguishable.
    addCron('a6', cron('kept', PLAIN));
    expect(readCrons('a6').map(c => c.name)).toEqual(['kept']);
  });

  it('removing a cron does not warn about the survivors', () => {
    writeCrons('a7', [cron('watch', PW), cron('plain', PLAIN)]);
    warn.mockClear();
    writeCrons('a7', [cron('watch', PW)]);   // same prompt, still on disk
    expect(warnings()).toHaveLength(0);
  });
});
