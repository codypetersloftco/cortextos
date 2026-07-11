/**
 * Mid-session reminder delivery — selection/throttle semantics.
 *
 * The class bug (3 instances): reminders fired ONLY via the boot prompt, so
 * one created mid-session with a mid-session fire_at silently waited for the
 * next restart (sessions run ~71h). The fast-checker now sweeps overdue
 * reminders on its poll loop; selectRemindersToInject is the pure decision
 * core it uses.
 */
import { describe, it, expect } from 'vitest';
import { selectRemindersToInject, type Reminder } from '../../../src/bus/reminders.js';

const COOLDOWN = 10 * 60_000;

function reminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r1',
    created_at: '2026-07-11T10:00:00.000Z',
    fire_at: '2026-07-11T12:00:00.000Z',
    prompt: 'do the thing',
    status: 'pending',
    ...over,
  };
}

const T_DUE = Date.parse('2026-07-11T12:00:00.000Z');

describe('selectRemindersToInject', () => {
  it('selects a pending reminder once fire_at has passed (THE class case)', () => {
    // created mid-session, due mid-session — must be deliverable without a restart
    const due = selectRemindersToInject([reminder()], new Map(), T_DUE + 1000, COOLDOWN);
    expect(due.map(r => r.id)).toEqual(['r1']);
  });

  it('does not select before fire_at', () => {
    const due = selectRemindersToInject([reminder()], new Map(), T_DUE - 1000, COOLDOWN);
    expect(due).toEqual([]);
  });

  it('does not select acked reminders', () => {
    const due = selectRemindersToInject(
      [reminder({ status: 'acked' })], new Map(), T_DUE + 1000, COOLDOWN,
    );
    expect(due).toEqual([]);
  });

  it('throttles re-injection within the cooldown, redelivers after it', () => {
    const now = T_DUE + 60_000;
    const injectedAt = new Map([['r1', now - 60_000]]); // injected 1 min ago
    expect(selectRemindersToInject([reminder()], injectedAt, now, COOLDOWN)).toEqual([]);

    // ...but an un-acked reminder redelivers once the cooldown passes
    const later = now + COOLDOWN;
    expect(
      selectRemindersToInject([reminder()], injectedAt, later, COOLDOWN).map(r => r.id),
    ).toEqual(['r1']);
  });

  it('selects independently per id', () => {
    const now = T_DUE + 1000;
    const injectedAt = new Map([['r1', now - 1000]]);
    const due = selectRemindersToInject(
      [reminder(), reminder({ id: 'r2' })], injectedAt, now, COOLDOWN,
    );
    expect(due.map(r => r.id)).toEqual(['r2']);
  });
});
