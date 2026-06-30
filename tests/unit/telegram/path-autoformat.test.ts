import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { autoFormatTelegramPaths, TelegramAPI } from '../../../src/telegram/api';

// ---------------------------------------------------------------------------
// autoFormatTelegramPaths — pure formatter.
// Wraps Windows (C:\...) and UNC (\\...) file paths in backticks so Telegram
// renders them as tap-to-copy monospace, AND normalizes backslashes to forward
// slashes inside the span (Cody's documented fleet rule: a backslash followed
// by t/n/r/b inside a code span renders as a tab/newline and corrupts the path).
// Must NOT touch URLs, times/ratios, or anything already inside a code span.
// ---------------------------------------------------------------------------
describe('autoFormatTelegramPaths — true positives (wrap + normalize)', () => {
  it('wraps a Windows drive path and converts backslashes to forward slashes', () => {
    expect(autoFormatTelegramPaths('open C:\\Users\\cody\\file.txt now'))
      .toBe('open `C:/Users/cody/file.txt` now');
  });

  it('wraps an already-forward-slash Windows path unchanged (slashes kept)', () => {
    expect(autoFormatTelegramPaths('see C:/Users/cody/x.py'))
      .toBe('see `C:/Users/cody/x.py`');
  });

  it('wraps a UNC path and normalizes the leading + internal backslashes', () => {
    expect(autoFormatTelegramPaths('on \\\\server\\share\\folder'))
      .toBe('on `//server/share/folder`');
  });

  it('keeps internal spaces in folder names (intermediate segments)', () => {
    expect(autoFormatTelegramPaths('at C:\\Program Files\\App\\bin.exe done'))
      .toBe('at `C:/Program Files/App/bin.exe` done');
  });

  it('does not consume trailing prose after the path', () => {
    expect(autoFormatTelegramPaths('the file C:\\tmp\\x.log is large'))
      .toBe('the file `C:/tmp/x.log` is large');
  });

  it('excludes a trailing sentence period from the wrapped path', () => {
    expect(autoFormatTelegramPaths('saved to C:\\tmp\\out.txt.'))
      .toBe('saved to `C:/tmp/out.txt`.');
  });

  it('wraps two distinct paths on one line', () => {
    expect(autoFormatTelegramPaths('copy C:\\a\\b.txt to D:\\c\\d.txt'))
      .toBe('copy `C:/a/b.txt` to `D:/c/d.txt`');
  });
});

describe('autoFormatTelegramPaths — false positives (must NOT wrap)', () => {
  it('leaves https URLs untouched', () => {
    const s = 'see https://api.telegram.org/bot123/sendMessage';
    expect(autoFormatTelegramPaths(s)).toBe(s);
  });

  it('leaves http URLs with a port untouched', () => {
    const s = 'backend http://localhost:8000/api/admin';
    expect(autoFormatTelegramPaths(s)).toBe(s);
  });

  it('leaves a time of day untouched', () => {
    const s = 'meeting at 5:30 today';
    expect(autoFormatTelegramPaths(s)).toBe(s);
  });

  it('leaves an aspect ratio untouched', () => {
    const s = 'render at 16:9 please';
    expect(autoFormatTelegramPaths(s)).toBe(s);
  });

  it('leaves a bare colon in prose untouched', () => {
    const s = 'note: this is important';
    expect(autoFormatTelegramPaths(s)).toBe(s);
  });
});

describe('autoFormatTelegramPaths — skip already-coded regions (no double-wrap)', () => {
  it('does not re-wrap a path already inside inline backticks', () => {
    const s = 'open `C:\\Users\\cody\\x.txt` now';
    expect(autoFormatTelegramPaths(s)).toBe(s);
  });

  it('does not wrap a path inside a fenced code block', () => {
    const s = 'run:\n```\ncd C:\\Users\\cody\\proj\n```\ndone';
    expect(autoFormatTelegramPaths(s)).toBe(s);
  });

  it('wraps a bare path that appears outside an existing code span on the same text', () => {
    expect(autoFormatTelegramPaths('use `already` then C:\\tmp\\x.log'))
      .toBe('use `already` then `C:/tmp/x.log`');
  });
});

// ---------------------------------------------------------------------------
// Wiring: TelegramAPI.sendMessage applies the formatter in HTML mode, and
// SKIPS it in plain-text mode (where backticks would render literally).
// ---------------------------------------------------------------------------
describe('TelegramAPI.sendMessage path auto-format wiring', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function captureSend() {
    const sent: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) } as any;
    }) as any;
    return sent;
  }

  it('wraps a Windows path as a <code> span in HTML mode', async () => {
    const sent = captureSend();
    const api = new TelegramAPI('123:TEST');
    await api.sendMessage('999', 'log at C:\\tmp\\run.log');
    expect(sent[0].text).toContain('<code>C:/tmp/run.log</code>');
  });

  it('does NOT add backticks in plain-text mode (parseMode null)', async () => {
    const sent = captureSend();
    const api = new TelegramAPI('123:TEST');
    await api.sendMessage('999', 'log at C:\\tmp\\run.log', undefined, { parseMode: null });
    expect(sent[0].text).toBe('log at C:\\tmp\\run.log');
    expect(sent[0].text).not.toContain('`');
  });
});

// ---------------------------------------------------------------------------
// Media captions (--image / --file) are the SAME command surface as a text
// send-telegram, so a path in a caption must behave identically: wrapped +
// normalized + parse_mode=HTML. Plain-text mode must skip both.
// ---------------------------------------------------------------------------
describe('TelegramAPI media-caption path auto-format', () => {
  const originalFetch = globalThis.fetch;
  let tmpFile: string;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-caption-'));
    tmpFile = join(dir, 'asset.bin');
    writeFileSync(tmpFile, 'x');
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function captureMultipart() {
    const sent: FormData[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      sent.push(init.body as FormData);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } as any;
    }) as any;
    return sent;
  }

  it('wraps a Windows path in a --image caption as <code> + parse_mode HTML', async () => {
    const sent = captureMultipart();
    const api = new TelegramAPI('123:TEST');
    await api.sendPhoto('999', tmpFile, 'see C:\\tmp\\x.png', undefined, { parseMode: 'HTML' });
    expect(sent[0].get('caption')).toContain('<code>C:/tmp/x.png</code>');
    expect(sent[0].get('parse_mode')).toBe('HTML');
  });

  it('wraps a Windows path in a --file caption as <code> + parse_mode HTML', async () => {
    const sent = captureMultipart();
    const api = new TelegramAPI('123:TEST');
    await api.sendDocument('999', tmpFile, 'doc at C:\\a\\b.pdf', undefined, { parseMode: 'HTML' });
    expect(sent[0].get('caption')).toContain('<code>C:/a/b.pdf</code>');
    expect(sent[0].get('parse_mode')).toBe('HTML');
  });

  it('plain-text --image caption skips wrap AND parse_mode', async () => {
    const sent = captureMultipart();
    const api = new TelegramAPI('123:TEST');
    await api.sendPhoto('999', tmpFile, 'see C:\\tmp\\x.png', undefined, { parseMode: null });
    expect(sent[0].get('caption')).toBe('see C:\\tmp\\x.png');
    expect(sent[0].get('parse_mode')).toBeNull();
  });
});
