/**
 * Mask secret-shaped substrings before anything is DISPLAYED or LOGGED.
 *
 * WHY THIS EXISTS
 * ---------------
 * `cortextos bus list-crons` printed each cron's prompt verbatim. A cron's prompt is an arbitrary
 * command string, so it can carry a credential inline — a `PGPASSWORD=` prefix, a connection URI,
 * a `--token` flag. When it does, **every listing writes that secret into the agent's stdout log**,
 * and those logs are append-only. Such a credential is not leaked once; it is re-leaked on every
 * invocation, by a read-only command nobody thinks of as a disclosure surface.
 *
 *   A COMMAND THAT ECHOES ITS INPUT IS A DISCLOSURE SURFACE.
 *
 * Rotation fixes the value. It does not fix the mechanism, and the mechanism is what keeps
 * re-creating the exposure — so the display path is masked here, once, for every caller.
 *
 * ⚠ ORDERING MATTERS: REDACT BEFORE TRUNCATING. The table previously sliced the prompt to 60
 * chars for display. Slicing first leaves a *prefix* of the secret on screen, which is worse than
 * useless — it looks redacted and is not. Every caller must redact, then truncate.
 *
 * ⚠ THIS IS A DISPLAY GUARD, NOT STORAGE ENCRYPTION. crons.json still holds the plaintext and is
 * still the daemon's source of truth; masking here does not make it safe to put secrets in a
 * cron. The real fix is for the cron to read its credential from the environment or a secrets
 * file so the command string never carries it at all.
 */

/** Key names whose value is a secret regardless of what it looks like. */
const SECRET_KEY = /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;

/** A connection URI carrying an inline password: scheme://user:SECRET@host */
const DSN_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s"']+):([^@\s"']+)@/gi;

/** `-p SECRET` / `--password SECRET` style flags. */
const SECRET_FLAG = /(--?(?:password|token|api-?key|secret)[= ])(?:"[^"]*"|'[^']*'|\S+)/gi;

/** Bearer / Authorization headers. */
const BEARER = /\b(Authorization:\s*(?:Bearer|Basic)\s+)\S+/gi;

export const REDACTED = '***REDACTED***';

/**
 * Replace secret-shaped substrings with a marker, preserving the surrounding text so the line
 * stays diagnosable (you can still see WHICH variable was set, just not to what).
 *
 * Returns the input unchanged when nothing matches — callers can compare to detect a hit.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(SECRET_KEY, (_m, key) => `${key}=${REDACTED}`)
    .replace(DSN_PASSWORD, (_m, prefix) => `${prefix}:${REDACTED}@`)
    .replace(SECRET_FLAG, (_m, flag) => `${flag}${REDACTED}`)
    .replace(BEARER, (_m, prefix) => `${prefix}${REDACTED}`);
}

/** True when redaction would change the string — i.e. it carries something secret-shaped. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

/**
 * Redact, THEN truncate. Exposed as one function precisely so a caller cannot get the order
 * wrong: truncate-then-redact leaves a prefix of the secret visible.
 */
export function redactAndTruncate(text: string, max: number): string {
  const safe = redactSecrets(text);
  return safe.length > max ? safe.slice(0, Math.max(0, max - 3)) + '...' : safe;
}
