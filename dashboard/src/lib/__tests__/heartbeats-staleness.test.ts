import { describe, it, expect } from 'vitest';
import {
  resolveCadenceStaleness,
  isAgentHealthy,
  getHealthStatus,
} from '@/lib/data/heartbeats';
import type { Heartbeat } from '@/lib/types';

function hbAgeMs(ms: number): Pick<Heartbeat, 'last_heartbeat'> {
  return { last_heartbeat: new Date(Date.now() - ms).toISOString() };
}

function heartbeatCron(schedule: string, enabled = true) {
  return { name: 'heartbeat', enabled, schedule };
}

describe('resolveCadenceStaleness (dashboard mirror of src/bus/heartbeat.ts)', () => {
  it('is unknown with no crons at all', () => {
    expect(resolveCadenceStaleness(hbAgeMs(1_000), [])).toBe('unknown');
  });

  it('is unknown when the heartbeat cron is disabled', () => {
    expect(resolveCadenceStaleness(hbAgeMs(1_000), [heartbeatCron('12h', false)])).toBe('unknown');
  });

  it('is fresh within the own-cadence interval, stale well past it', () => {
    const crons = [heartbeatCron('12h')];
    expect(resolveCadenceStaleness(hbAgeMs(1 * 3_600_000), crons)).toBe('fresh');
    expect(resolveCadenceStaleness(hbAgeMs(20 * 3_600_000), crons)).toBe('stale');
  });

  it('does not false-flag a long-cadence agent at an age a fixed threshold would have flagged', () => {
    // The exact regression class this replaces: a 5h fixed threshold would
    // call this stale; the real 12h cadence says it's still well within norm.
    expect(resolveCadenceStaleness(hbAgeMs(8 * 3_600_000), [heartbeatCron('12h')])).toBe('fresh');
  });
});

describe('isAgentHealthy / getHealthStatus honor the cadence-aware staleness verdict', () => {
  it('isAgentHealthy treats "unknown" staleness as healthy, not a guessed stale', () => {
    const hb: Heartbeat = {
      agent: 'worker-1',
      org: 'test',
      status: 'ok',
      last_heartbeat: new Date(Date.now() - 8 * 3_600_000).toISOString(),
      staleness: 'unknown',
    };
    expect(isAgentHealthy(hb)).toBe(true);
  });

  it('isAgentHealthy respects an explicit "stale" verdict even within the old fixed threshold', () => {
    const hb: Heartbeat = {
      agent: 'fast-cadence-agent',
      org: 'test',
      status: 'ok',
      // Only 1h old — well inside the legacy 5h fixed threshold — but this
      // agent's real cadence is 15 minutes, so it genuinely IS stale.
      last_heartbeat: new Date(Date.now() - 3_600_000).toISOString(),
      staleness: 'stale',
    };
    expect(isAgentHealthy(hb)).toBe(false);
  });

  it('falls back to the fixed threshold when staleness was never computed', () => {
    const fresh: Heartbeat = {
      agent: 'legacy', org: 'test', status: 'ok',
      last_heartbeat: new Date(Date.now() - 60_000).toISOString(),
    };
    const stale: Heartbeat = {
      agent: 'legacy', org: 'test', status: 'ok',
      last_heartbeat: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    };
    expect(isAgentHealthy(fresh)).toBe(true);
    expect(isAgentHealthy(stale)).toBe(false);
  });

  it('getHealthStatus still applies the fixed DOWN ceiling regardless of cadence', () => {
    const hb: Heartbeat = {
      agent: 'long-silent', org: 'test', status: 'ok',
      last_heartbeat: new Date(Date.now() - 30 * 3_600_000).toISOString(), // 30h
      staleness: 'stale',
    };
    expect(getHealthStatus(hb)).toBe('down');
  });

  it('getHealthStatus reads "unknown" cadence as healthy short of the down ceiling', () => {
    const hb: Heartbeat = {
      agent: 'worker-1', org: 'test', status: 'ok',
      last_heartbeat: new Date(Date.now() - 8 * 3_600_000).toISOString(),
      staleness: 'unknown',
    };
    expect(getHealthStatus(hb)).toBe('healthy');
  });
});
