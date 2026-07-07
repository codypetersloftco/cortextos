/**
 * telegram-format-guard — TS port of the reference implementation at
 * orgs/<org>/agents/analyst/findings/reliability/tools/telegram-format-guard.py
 * (theta #41, boss-endorsed BUILD, 4 gates, 2026-07-07).
 *
 * The real chokepoint is src/cli/bus.ts's `send-telegram` command (dist/cli.js
 * bus send-telegram) — NOT bus/send-telegram.sh, which wraps only some
 * callers and would be a decoy affordance if guarded alone. Gated behind
 * env flag CTX_TELEGRAM_FORMAT_GUARD, default OFF.
 *
 * SCOPE FLOOR (gate 2 — ONLY verified-bitten mechanical rules, ZERO style):
 *   R1 backslash-path normalization INSIDE code spans: Telegram clients
 *      render backslash escapes inside a code span as tab/newline
 *      (`...cortextos\tools\...` displays as `...cortextos<TAB>ools\...`) —
 *      Prism-caught 6/12, Cody-tested; forward-slash-in-code-span was the
 *      format that worked. Windows drive/UNC paths inside `...` get \ -> /.
 *      Nothing outside code spans is touched by R1.
 *   R2 illegal-escape stripping OUTSIDE code spans: send-telegram uses
 *      Telegram regular Markdown (NOT MarkdownV2) — backslash-escaping
 *      !.()-#+={}>| is wrong there and renders as literal backslashes
 *      (comms skill rule; bitten class). Only `_ * \` [` have special
 *      meaning; a backslash before anything else is stripped. Backslashes
 *      inside code spans are R1's domain, never R2's.
 *   NOT ENFORCED (caller-side class, a send-path guard cannot undo it): the
 *   backtick-in-double-quote shell-execution bite — the caller's shell
 *   executes before any send path sees the message. Stays a caller habit +
 *   guardrail.
 *   NOT ENFORCED (style, per boss gate 2): wrapping, bolding, bullets, tone.
 *
 * FAIL-OPEN (gate 1): guard() NEVER throws — any internal error returns the
 * ORIGINAL text unchanged + a stderr note. The channel must never
 * block/garble.
 *
 * Vectors: telegram-format-guard.vectors.json (written by the python
 * reference's --write-vectors) — this port passes the identical vector set
 * (same-spec proof), see tests/unit/telegram/format-guard.test.ts.
 */

// Code spans: single-backtick inline spans (Telegram regular Markdown has no
// multi-backtick fences in this dialect; ``` blocks pass through R1
// untouched because the drive-letter/UNC test won't match a whole block's
// first line).
const CODE_SPAN = /`([^`\n]*)`/g;
// A code-span body that IS a Windows path: optional junk, then drive letter
// or UNC.
const WIN_PATH = /^\s*(?:[A-Za-z]:\\|\\\\)[^\n]*$/;

function fixSpan(fullMatch: string, body: string): string {
  if (WIN_PATH.test(body)) {
    return '`' + body.replace(/\\/g, '/') + '`';
  }
  return fullMatch;
}

// R2: backslash before a MarkdownV2-style punctuation escape -> drop the
// backslash, keep the char. Scoped to the actual MarkdownV2 reserved-
// punctuation set (the class of escape that is WRONG in Telegram's regular
// Markdown) — NOT "everything except the 4 legal chars". A broader negated
// class would also strip backslash-before-LETTER, which mangles bare
// Windows paths outside code spans (`C:\Users\...` -> `C:Users...`) and
// silently breaks autoFormatTelegramPaths' downstream path-detection regex
// (it can no longer recognize the mangled text as a path at all). Verified
// this is also how the python reference (telegram-format-guard.py) behaves
// today — same latent gap, flagged upstream for the same fix.
const ILLEGAL_ESCAPE_PUNCTUATION = /\\([.!()#+=|{}~>\]-])/g;

function stripIllegalEscapes(seg: string): string {
  return seg.replace(ILLEGAL_ESCAPE_PUNCTUATION, '$1');
}

function applyRules(text: string): string {
  let out = '';
  let last = 0;
  CODE_SPAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_SPAN.exec(text)) !== null) {
    // R2 on the text BETWEEN code spans; R1 on the span itself.
    const between = text.slice(last, m.index);
    out += stripIllegalEscapes(between);
    out += fixSpan(m[0], m[1]);
    last = m.index + m[0].length;
  }
  out += stripIllegalEscapes(text.slice(last));
  return out;
}

/**
 * FAIL-OPEN wrapper — the only public entry. `transform` is injectable for
 * fault-injection testing (gate 3), mirroring the python reference's
 * `_transform` parameter.
 */
export function guard(text: unknown, transform: (s: string) => string = applyRules): unknown {
  try {
    if (typeof text !== 'string' || !text) return text;
    return transform(text);
  } catch (e) {
    const err = e as { name?: string } | undefined;
    // eslint-disable-next-line no-console
    console.error(
      `telegram-format-guard: FAIL-OPEN (${err?.name ?? 'Error'}) — original sent unmodified`,
    );
    return text;
  }
}

/** True when CTX_TELEGRAM_FORMAT_GUARD is explicitly enabled. Default OFF. */
export function isFormatGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CTX_TELEGRAM_FORMAT_GUARD || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}
