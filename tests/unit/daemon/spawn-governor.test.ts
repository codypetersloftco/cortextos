import { describe, it, expect, afterEach } from 'vitest';
import { SpawnGovernor } from '../../../src/daemon/spawn-governor.js';

// SpawnGovernor reads real host memory via os.freemem()/os.totalmem(), so we
// drive its decision deterministically through the env-var thresholds rather
// than mocking os. A 0 floor always permits; an impossibly-high floor always
// defers. This pins the gate's contract (OOM Wave 2, Patch 6 / F2).

describe('SpawnGovernor (OOM Wave 2 — Patch 6 / F2)', () => {
  const SAVED_MB = process.env.CTX_MIN_FREE_MEM_MB;
  const SAVED_PCT = process.env.CTX_MIN_FREE_MEM_PERCENT;

  afterEach(() => {
    if (SAVED_MB === undefined) delete process.env.CTX_MIN_FREE_MEM_MB;
    else process.env.CTX_MIN_FREE_MEM_MB = SAVED_MB;
    if (SAVED_PCT === undefined) delete process.env.CTX_MIN_FREE_MEM_PERCENT;
    else process.env.CTX_MIN_FREE_MEM_PERCENT = SAVED_PCT;
  });

  it('permits a spawn when host memory is above both floors', () => {
    process.env.CTX_MIN_FREE_MEM_MB = '0';
    process.env.CTX_MIN_FREE_MEM_PERCENT = '0';
    const decision = new SpawnGovernor().canSpawn();
    expect(decision.ok).toBe(true);
  });

  it('defers a spawn when free RAM is below the absolute MB floor', () => {
    // Demand more free MB than any host could have free right now.
    process.env.CTX_MIN_FREE_MEM_MB = String(Number.MAX_SAFE_INTEGER);
    process.env.CTX_MIN_FREE_MEM_PERCENT = '0';
    const decision = new SpawnGovernor().canSpawn();
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.retryMs).toBe(60000);
      expect(decision.reason).toMatch(/free_mem=.*below/);
    }
  });

  it('defers a spawn when free RAM is below the percent floor', () => {
    process.env.CTX_MIN_FREE_MEM_MB = '0';
    // Require 200% free — impossible — so the percent floor alone defers.
    process.env.CTX_MIN_FREE_MEM_PERCENT = '2';
    const decision = new SpawnGovernor().canSpawn();
    expect(decision.ok).toBe(false);
  });

  it('snapshot() reports coherent free/total/percent values', () => {
    const s = new SpawnGovernor().snapshot();
    expect(s.totalMb).toBeGreaterThan(0);
    expect(s.freeMb).toBeGreaterThanOrEqual(0);
    expect(s.freePercent).toBeGreaterThanOrEqual(0);
    expect(s.freePercent).toBeLessThanOrEqual(1);
  });
});
