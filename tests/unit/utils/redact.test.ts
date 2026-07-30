import { describe, it, expect } from 'vitest';
import { redactSecrets, containsSecret, redactAndTruncate, REDACTED } from '../../../src/utils/redact.js';

/**
 * The specimen shape is drawn from a real deployment defect: a cron whose prompt begins with an
 * env-var prefix, printed verbatim by `bus list-crons` into a persistent stdout log on every
 * invocation. The values below are synthetic.
 *
 * ⚠ A redaction test passes trivially if you only assert "the secret is gone" — deleting the
 * whole string would satisfy that. Every case below also asserts what SURVIVES, because a mask
 * that destroys the surrounding text stops anyone diagnosing the cron it was meant to protect.
 */

const PW = 'hunter2SuperSecretValue';

describe('redactSecrets', () => {
  it('masks the real specimen: a PGPASSWORD= prefix on a cron command', () => {
    const out = redactSecrets(`PGPASSWORD=${PW} psql -h localhost -U postgres -c "select 1"`);
    expect(out).not.toContain(PW);
    expect(out).toContain(`PGPASSWORD=${REDACTED}`);
    // ...and the rest of the command survives, or the cron becomes undiagnosable
    expect(out).toContain('psql -h localhost -U postgres');
  });

  it('masks an inline DSN password but keeps scheme, user and host', () => {
    const out = redactSecrets(`postgresql://postgres:${PW}@localhost:5432/ai_admin`);
    expect(out).not.toContain(PW);
    expect(out).toContain('postgresql://postgres');
    expect(out).toContain('@localhost:5432/ai_admin');
  });

  it('⭐ WRAPPED VALUES: a QUOTED secret must still match', () => {
    // This is the defect that broke a colleague's scanner twice in one day. He put the quote
    // characters in his EXCLUSION SET — `PGPASSWORD=([^\s"';]+)` — which assumes the value is
    // BARE and the quote TERMINATES it. When the value is WRAPPED, the quote is the FIRST
    // character, the + needs >=1, and the match dies at position 0 returning a silent zero that
    // is indistinguishable from a clean file. The real cron on this fleet is single-quoted.
    for (const wrapped of [`PGPASSWORD='${PW}'`, `PGPASSWORD="${PW}"`, `PGPASSWORD=${PW}`]) {
      const out = redactSecrets(`${wrapped} psql -h localhost`);
      expect(out, `failed on: ${wrapped.slice(0, 14)}...`).not.toContain(PW);
      expect(out).toContain(REDACTED);
    }
  });

  it('masks --password / -p style flags', () => {
    expect(redactSecrets(`mysql -u root --password=${PW}`)).not.toContain(PW);
    expect(redactSecrets(`tool --api-key ${PW}`)).not.toContain(PW);
  });

  it('masks a bearer token but keeps the header name', () => {
    const out = redactSecrets(`curl -H "Authorization: Bearer ${PW}"`);
    expect(out).not.toContain(PW);
    expect(out).toContain('Authorization: Bearer');
  });

  it('NEGATIVE CONTROL: leaves ordinary prompts completely untouched', () => {
    // Without this, a redactor that mangles everything would pass every test above.
    const plain = 'Check the inbox and work on your highest priority task. Report to boss.';
    expect(redactSecrets(plain)).toBe(plain);
    expect(containsSecret(plain)).toBe(false);
  });

  it('NEGATIVE CONTROL: a variable whose name is not secret-shaped is preserved', () => {
    const s = 'CTX_ORG=loftco-autopilot cortextos bus check-inbox';
    expect(redactSecrets(s)).toBe(s);
  });

  it('handles empty and undefined-ish input without throwing', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(undefined as unknown as string)).toBeUndefined();
  });
});

describe('redactAndTruncate — the ordering that made this necessary', () => {
  it('⭐ THE LOAD-BEARING TEST: truncating first would leave a PREFIX of the secret visible', () => {
    // The old table did `prompt.slice(0, 57)` on the raw text. With the secret at the front,
    // that slice IS the secret. This asserts the fixed order, and it fails on the old one.
    const prompt = `PGPASSWORD=${PW} psql -h localhost -c "select count(*) from invoices"`;
    const shown = redactAndTruncate(prompt, 60);
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(shown).not.toContain(PW);
    // and not even the first few characters of it
    expect(shown).not.toContain(PW.slice(0, 6));
    expect(shown).toContain(REDACTED);
  });

  it('still truncates long non-secret prompts', () => {
    const long = 'x'.repeat(200);
    const out = redactAndTruncate(long, 60);
    expect(out).toHaveLength(60);
    expect(out.endsWith('...')).toBe(true);
  });

  it('leaves a short prompt exactly as-is', () => {
    expect(redactAndTruncate('short prompt', 60)).toBe('short prompt');
  });
});
