import { describe, it, expect } from 'vitest';
import { resolveHeartbeatStaleness } from '../../../src/bus/heartbeat';
import type { CronDefinition } from '../../../src/types/index';

function hbAgeMs(ms: number): { last_heartbeat: string } {
  return { last_heartbeat: new Date(Date.now() - ms).toISOString() };
}

function heartbeatCron(schedule: string, enabled = true): CronDefinition {
  return {
    name: 'heartbeat',
    prompt: 'Read HEARTBEAT.md and follow its instructions.',
    schedule,
    enabled,
    created_at: new Date().toISOString(),
  } as CronDefinition;
}

describe('resolveHeartbeatStaleness (tri-state: fresh / stale / unknown)', () => {
  it('is unknown when the agent has no crons at all (worker/bridge entry)', () => {
    const verdict = resolveHeartbeatStaleness(hbAgeMs(1_000), []);
    expect(verdict).toBe('unknown');
  });

  it('is unknown when a heartbeat cron exists but is disabled', () => {
    const crons = [heartbeatCron('12h', false)];
    const verdict = resolveHeartbeatStaleness(hbAgeMs(1_000), crons);
    expect(verdict).toBe('unknown');
  });

  it('falls back to a conservative interval (not "unknown") for a malformed schedule string', () => {
    // cronExpressionMinIntervalMs's documented contract is "conservative 48h
    // fallback for anything unparseable" -- it never returns NaN, by design,
    // so a garbage-but-present schedule still resolves to a (generous)
    // interval rather than silently guessing 'unknown'. 'unknown' is reserved
    // for "no enabled heartbeat cron at all", not "cron exists with an odd
    // schedule string" -- deliberately reusing the shared cadence-estimation
    // utility's own fallback rather than inventing a second, divergent
    // malformed-schedule policy here.
    const crons = [heartbeatCron('not-a-real-schedule !!!')];
    const verdict = resolveHeartbeatStaleness(hbAgeMs(1_000), crons);
    expect(verdict).toBe('fresh');
  });

  it('is fresh when age is well within the own-cadence interval', () => {
    const crons = [heartbeatCron('12h')];
    const verdict = resolveHeartbeatStaleness(hbAgeMs(1 * 3_600_000), crons); // 1h old, 12h cadence
    expect(verdict).toBe('fresh');
  });

  it('is fresh when age is past the interval but within the grace window', () => {
    const crons = [heartbeatCron('12h')];
    // 12h interval + a few minutes of jitter should still read fresh
    const verdict = resolveHeartbeatStaleness(hbAgeMs(12 * 3_600_000 + 5 * 60_000), crons);
    expect(verdict).toBe('fresh');
  });

  it('is stale when age clearly exceeds interval + grace', () => {
    const crons = [heartbeatCron('12h')];
    const verdict = resolveHeartbeatStaleness(hbAgeMs(20 * 3_600_000), crons); // 20h old, 12h cadence
    expect(verdict).toBe('stale');
  });

  it('resolves a shorter own-cadence agent correctly against the SAME absolute age', () => {
    // The whole point of the fix: a fixed-threshold check would treat both
    // this and the 12h-cadence case identically at the same absolute age.
    // A 30m-cadence agent silent for 3h is genuinely stale...
    const shortCadence = [heartbeatCron('30m')];
    expect(resolveHeartbeatStaleness(hbAgeMs(3 * 3_600_000), shortCadence)).toBe('stale');
  });

  it('does not falsely flag a long-cadence agent that a fixed threshold would miss', () => {
    // ...while a 12h-cadence agent at that SAME 3h age is nowhere near stale
    // (this is the exact false-flag class from the 6/11 incident + prism hb_stale).
    const longCadence = [heartbeatCron('12h')];
    expect(resolveHeartbeatStaleness(hbAgeMs(3 * 3_600_000), longCadence)).toBe('fresh');
  });

  it('supports a full 5-field cron expression schedule, not just duration shorthand', () => {
    const crons = [heartbeatCron('*/15 * * * *')]; // every 15 minutes
    expect(resolveHeartbeatStaleness(hbAgeMs(2 * 3_600_000), crons)).toBe('stale');
    expect(resolveHeartbeatStaleness(hbAgeMs(5 * 60_000), crons)).toBe('fresh');
  });

  it('ignores non-heartbeat crons when looking up the agent cadence', () => {
    const crons = [
      heartbeatCron('12h'),
      {
        name: 'parcel-import',
        prompt: 'unrelated',
        schedule: '5m',
        enabled: true,
        created_at: new Date().toISOString(),
      } as CronDefinition,
    ];
    // Age is stale for a 5m cadence but fresh for the actual 12h heartbeat cadence
    expect(resolveHeartbeatStaleness(hbAgeMs(1 * 3_600_000), crons)).toBe('fresh');
  });
});
