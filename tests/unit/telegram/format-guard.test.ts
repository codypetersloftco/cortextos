/**
 * Theta #41 formatter TS port — proves this port passes the IDENTICAL
 * 9-vector set as the python reference (analyst's
 * findings/reliability/tools/telegram-format-guard.py --self-test), plus
 * fail-open fault-injection and env-flag gating.
 *
 * Composability note: src/telegram/api.ts's autoFormatTelegramPaths already
 * wraps BARE Windows/UNC paths in backticks + normalizes their backslashes,
 * but explicitly SKIPS anything already inside a code span (see its own
 * "skip already-coded regions" tests). This guard's R1 covers exactly that
 * remaining gap — a path an agent already wrote inside backticks with
 * backslashes. The two are complementary, not redundant: this guard runs in
 * bus.ts BEFORE api.sendMessage() is called, so already-coded paths get
 * fixed first, then autoFormatTelegramPaths wraps any remaining bare ones.
 */
import { describe, it, expect } from 'vitest';
import { guard, isFormatGuardEnabled } from '../../../src/telegram/format-guard';

// Ported verbatim from telegram-format-guard.vectors.json (written by the
// python reference's --write-vectors) — same-spec proof for the port.
const VECTORS: Array<{ in: string; out: string; why: string }> = [
  {
    in: 'path: `C:\\Users\\cody\\cortextos\\tools\\blender_mcp`',
    out: 'path: `C:/Users/cody/cortextos/tools/blender_mcp`',
    why: 'R1 drive-letter path in code span',
  },
  {
    in: 'share: `\\\\HV01\\J$\\PLANS`',
    out: 'share: `//HV01/J$/PLANS`',
    why: 'R1 UNC path in code span',
  },
  {
    in: 'regex: `\\d{4}-\\d{2}`',
    out: 'regex: `\\d{4}-\\d{2}`',
    why: 'R1 negative — non-path span untouched',
  },
  {
    in: 'Done\\! Cost \\(net\\): \\#3 \\- see below\\.',
    out: 'Done! Cost (net): #3 - see below.',
    why: 'R2 MarkdownV2-style escapes stripped for regular Markdown',
  },
  {
    in: 'literal \\* star and \\_ underscore stay escaped',
    out: 'literal \\* star and \\_ underscore stay escaped',
    why: 'R2 negative — legal escapes (_ * ` [) preserved',
  },
  {
    in: 'value `a\\!b` prose \\!',
    out: 'value `a\\!b` prose !',
    why: 'R2 scope — code-span interior untouched, prose escape stripped',
  },
  {
    in: 'Fixed\\! File `C:\\Loftco\\Workspace\\AI Admin\\run.py` is live\\.',
    out: 'Fixed! File `C:/Loftco/Workspace/AI Admin/run.py` is live.',
    why: 'R1+R2 combined',
  },
  {
    in: 'Clean message with `C:/already/forward` and no escapes.',
    out: 'Clean message with `C:/already/forward` and no escapes.',
    why: 'no-op on clean input',
  },
  { in: '', out: '', why: 'empty passthrough' },
  {
    in: 'see C:\\Users\\cody\\x.txt for details',
    out: 'see C:\\Users\\cody\\x.txt for details',
    why: 'R2 spec-fix 7/7: bare Windows path OUTSIDE code spans passes through UNTOUCHED',
  },
];

describe('telegram-format-guard: identical vector set as the python reference', () => {
  for (const v of VECTORS) {
    it(v.why, () => {
      expect(guard(v.in)).toBe(v.out);
    });
  }
});

describe('telegram-format-guard: R2 character-class precision (analyst parity check)', () => {
  it('backslash-dollar is preserved — $ is not MarkdownV2-reserved punctuation', () => {
    expect(guard('price \\$5 today')).toBe('price \\$5 today');
  });

  it('backslash-letter (path/regex shapes) is preserved outside code spans', () => {
    expect(guard('pattern \\d{4} matches')).toBe('pattern \\d{4} matches');
  });

  it('backslash-punctuation (the actual MarkdownV2 reserved set) is stripped', () => {
    expect(guard('a\\.b\\!c\\(d\\)e\\#f\\-g\\+h\\=i\\|j\\{k\\}l\\~m\\>n')).toBe(
      'a.b!c(d)e#f-g+h=i|j{k}l~m>n',
    );
  });
});

describe('telegram-format-guard: fail-open (gate 1)', () => {
  it('a fault injected into the transform returns the ORIGINAL text unmodified', () => {
    const victim = 'malformed \\! `C:\\x` message';
    const bomb = (): string => {
      throw new Error('injected');
    };
    expect(guard(victim, bomb)).toBe(victim);
  });

  it('non-string input passes through un-thrown (null/number/undefined)', () => {
    expect(guard(null)).toBe(null);
    expect(guard(undefined)).toBe(undefined);
    expect(guard(123)).toBe(123);
  });

  it('empty string passes through without invoking the transform', () => {
    let called = false;
    guard('', () => {
      called = true;
      return 'x';
    });
    expect(called).toBe(false);
  });
});

describe('telegram-format-guard: env-flag gating (default OFF)', () => {
  it('is disabled by default when CTX_TELEGRAM_FORMAT_GUARD is unset', () => {
    expect(isFormatGuardEnabled({})).toBe(false);
  });

  it('is disabled for falsy-looking values', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      expect(isFormatGuardEnabled({ CTX_TELEGRAM_FORMAT_GUARD: v })).toBe(false);
    }
  });

  it('is enabled for truthy values, case-insensitive', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'ON', 'yes']) {
      expect(isFormatGuardEnabled({ CTX_TELEGRAM_FORMAT_GUARD: v })).toBe(true);
    }
  });
});

describe('telegram-format-guard: composability with autoFormatTelegramPaths', () => {
  it('fixes a backslash path an agent already wrote inside backticks — the exact gap autoFormatTelegramPaths leaves open', () => {
    // autoFormatTelegramPaths explicitly skips code spans (never re-wraps or
    // normalizes inside existing backticks) — this guard is what closes it.
    const alreadyCoded = 'open `C:\\Users\\cody\\x.txt` now';
    expect(guard(alreadyCoded)).toBe('open `C:/Users/cody/x.txt` now');
  });

  it('leaves a bare (non-coded) path untouched — that is autoFormatTelegramPaths job downstream', () => {
    const bare = 'open C:\\Users\\cody\\x.txt now';
    expect(guard(bare)).toBe(bare);
  });
});
