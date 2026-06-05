import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mutable mock state (hoisted so the vi.mock factories below can close over it).
const state = vi.hoisted(() => ({ plat: 'win32', present: new Set<string>() }));

vi.mock('os', async (orig) => ({ ...(await orig() as object), platform: () => state.plat }));
vi.mock('fs', async (orig) => ({
  ...(await orig() as object),
  existsSync: (p: string) => state.present.has(String(p).replace(/\\/g, '/')),
}));

import { resolveCodexBinary } from '../../../src/pty/codex-app-server-pty';

describe('resolveCodexBinary', () => {
  const ORIG_PATH = process.env.PATH;
  beforeEach(() => {
    state.plat = 'win32';
    state.present = new Set();
    process.env.PATH = 'C:\\bin;C:\\Users\\cody\\AppData\\Roaming\\npm';
  });

  it('non-win32 → bare "codex"', () => {
    state.plat = 'linux';
    expect(resolveCodexBinary()).toBe('codex');
  });

  it('win32 with codex.exe on PATH → "codex.exe" (preferred)', () => {
    state.present.add('C:/Users/cody/AppData/Roaming/npm/codex.exe');
    state.present.add('C:/Users/cody/AppData/Roaming/npm/codex.cmd');
    expect(resolveCodexBinary()).toBe('codex.exe');
  });

  it('win32 with only codex.cmd on PATH → "codex.cmd" (this box: bare-name spawn was the bug)', () => {
    state.present.add('C:/Users/cody/AppData/Roaming/npm/codex.cmd');
    expect(resolveCodexBinary()).toBe('codex.cmd');
  });

  it('win32 with neither on PATH → "codex.cmd" fallback (never bare "codex" on Windows)', () => {
    expect(resolveCodexBinary()).toBe('codex.cmd');
  });

  afterEach(() => { process.env.PATH = ORIG_PATH; });
});
