/**
 * Track 2 mime-mismatch — Stage 4 fix verification tests.
 *
 * Originally landed in commit e1ea0a76 as the Stage 2 bug-repro
 * (assertions verified user-supplied extension reached the prompt
 * intact). Now updated to assert the Stage 4 fix: the same 5
 * mismatched-byte fixtures, post-fix, get canonical extensions
 * applied by sniffImageMime so claude-code's auto-attach labels match
 * the bytes and Anthropic accepts the image.
 *
 * Background (full audit in pr-reviews/track2-mime-mismatch/):
 *   PR #446 commit ab37554a suppressed `local_file:` from the PHOTO
 *   path to dodge "API Error: 400 image/<x> not supported" crashes
 *   Sam Wilson saw 4-6 times/day across 9 agents. Stage 1 trace
 *   showed the bug was actually in the DOCUMENT path, where
 *   `msg.document.file_name` is user-supplied. Stage 4 (this fix)
 *   adds a magic-byte sniff in media.ts so the on-disk extension
 *   always matches the bytes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import * as path from 'path';
import { tmpdir } from 'os';
import { processMediaMessage } from '../../../src/telegram/media';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { TelegramMessage } from '../../../src/types';

function createMockApi(filePath: string, fileData: Buffer) {
  return {
    getFile: vi.fn().mockResolvedValue({ result: { file_path: filePath } }),
    downloadFile: vi.fn().mockResolvedValue(fileData),
  } as any;
}

function makeDocMsg(fileName: string, caption: string = ''): TelegramMessage {
  return {
    message_id: 1,
    date: 1700000000,
    chat: { id: 42, type: 'private' },
    from: { id: 1, first_name: 'Alice' },
    document: { file_id: 'doc1', file_name: fileName },
    caption,
  };
}

/**
 * Magic-byte signatures for the five fixture cases. These are the
 * leading bytes a real-bytes sniff (libmagic / file(1) / mime-type
 * libraries) would use to determine the actual format regardless of
 * the file extension.
 */
type FixtureCase = {
  fileName: string;
  bytes: Buffer;
  actualMime: string;
  declaredMimeViaExt: string;
  /** Post-fix on-disk filename media.ts should produce. */
  expectedSavedFileName: string;
};

const FIXTURES: Record<string, FixtureCase> = {
  // Case 1: HEIC from iOS — common when Android Telegram client
  // forwards an iOS-originated screenshot/photo without re-encoding,
  // and the user has renamed or the upload pipeline labeled it .jpg.
  // Real HEIC files start with `ftypheic` (or `ftypheix` / `ftypmif1`)
  // at offset 4. Post-fix: routed to .unsupported-image suffix so
  // claude-code's auto-attach does not trigger.
  heic_as_jpg: {
    fileName: 'IMG_0042.jpg',
    bytes: Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(64, 0),
    ]),
    actualMime: 'image/heic',
    declaredMimeViaExt: 'image/jpeg',
    expectedSavedFileName: 'IMG_0042.jpg.unsupported-image',
  },

  // Case 2: animated GIF labeled .png. Post-fix: renamed to .gif.
  gif_as_png: {
    fileName: 'screenshot.png',
    bytes: Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.from([0x10, 0x00, 0x10, 0x00]),
      Buffer.alloc(64, 0),
    ]),
    actualMime: 'image/gif',
    declaredMimeViaExt: 'image/png',
    expectedSavedFileName: 'screenshot.gif',
  },

  // Case 3: WebP sticker labeled .png. Post-fix: renamed to .webp.
  webp_as_png: {
    fileName: 'sticker.png',
    bytes: Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x40, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP'),
      Buffer.alloc(64, 0),
    ]),
    actualMime: 'image/webp',
    declaredMimeViaExt: 'image/png',
    expectedSavedFileName: 'sticker.webp',
  },

  // Case 4: Sam's literal report — PNG-labeled JPEG bytes. Post-fix:
  // renamed to .jpg.
  jpeg_as_png: {
    fileName: 'screenshot.png',
    bytes: Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF'),
      Buffer.alloc(64, 0),
    ]),
    actualMime: 'image/jpeg',
    declaredMimeViaExt: 'image/png',
    expectedSavedFileName: 'screenshot.jpg',
  },

  // Case 5: control — actual PNG bytes labeled .png. Post-fix:
  // unchanged (canonical ext matches bytes).
  png_control: {
    fileName: 'real.png',
    bytes: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0),
    ]),
    actualMime: 'image/png',
    declaredMimeViaExt: 'image/png',
    expectedSavedFileName: 'real.png',
  },
};

describe('Track 2 fix: document-path mime sniff produces canonical extensions', () => {
  let downloadDir: string;

  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'track2-mime-fix-'));
  });

  afterEach(() => {
    rmSync(downloadDir, { recursive: true, force: true });
  });

  for (const [caseName, fixture] of Object.entries(FIXTURES)) {
    it(`case ${caseName}: declared=${fixture.declaredMimeViaExt} actual=${fixture.actualMime} → renamed to ${fixture.expectedSavedFileName}`, async () => {
      const msg = makeDocMsg(fixture.fileName, 'check this');
      const api = createMockApi('documents/file_remote.bin', fixture.bytes);

      const result = await processMediaMessage(msg, api, downloadDir);

      // Fix verification 1: media.ts now saves under a sniff-corrected
      // filename that matches the actual bytes (or shunts HEIC to a
      // non-image suffix).
      expect(result).not.toBeNull();
      expect(result!.type).toBe('document');
      expect(result!.file_name).toBe(fixture.expectedSavedFileName);
      expect(path.basename(result!.file_path!)).toBe(fixture.expectedSavedFileName);
      expect(existsSync(result!.file_path!)).toBe(true);

      // The saved bytes are untouched — only the filename changed.
      const onDisk = readFileSync(result!.file_path!);
      expect(onDisk.equals(fixture.bytes)).toBe(true);

      // Fix verification 2: formatTelegramDocumentMessage now injects
      // a path with the canonical extension. claude-code's auto-attach
      // labels mime from extension; the label will match the bytes;
      // Anthropic accepts → no 400 crash.
      const prompt = FastChecker.formatTelegramDocumentMessage(
        'Alice',
        '42',
        'check this',
        result!.file_path!,
        result!.file_name!,
      );
      expect(prompt).toContain(`local_file: ${result!.file_path!}`);
      expect(prompt).toContain(`file_name: ${fixture.expectedSavedFileName}`);

      // Critical post-fix assertion: the original mismatched extension
      // is no longer present in the on-disk filename (except for the
      // png_control where it never was a mismatch). HEIC retains the
      // original ext but appends `.unsupported-image` so it's the
      // FINAL extension that matters.
      if (caseName !== 'png_control') {
        const finalExt = extname(result!.file_path!);
        // For HEIC: finalExt = '.unsupported-image' (non-image, suppresses auto-attach).
        // For others: finalExt is the canonical image ext matching bytes.
        if (caseName === 'heic_as_jpg') {
          expect(finalExt).toBe('.unsupported-image');
        } else {
          // Must NOT be the originally-declared (mismatched) extension.
          expect(finalExt).not.toBe(extname(fixture.fileName));
        }
      }
    });
  }

  it('summary: post-fix, 4/5 fixtures get renamed to canonical extensions (png_control unchanged)', async () => {
    const renamed: string[] = [];
    const unchanged: string[] = [];

    for (const [caseName, fixture] of Object.entries(FIXTURES)) {
      const msg = makeDocMsg(fixture.fileName);
      const api = createMockApi('documents/file_remote.bin', fixture.bytes);
      const result = await processMediaMessage(msg, api, downloadDir);
      if (result!.file_name === fixture.fileName) {
        unchanged.push(caseName);
      } else {
        renamed.push(caseName);
      }
    }

    // 4 mismatches each get a rename (jpeg/gif/webp to canonical;
    // heic to .unsupported-image shunt). png_control is left alone.
    expect(renamed.length).toBe(4);
    expect(unchanged).toEqual(['png_control']);
  });

  it('non-image documents (PDFs, code files, etc.) are NOT renamed', async () => {
    const pdfBytes = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(64, 0),
    ]);
    const msg = makeDocMsg('report.pdf');
    const api = createMockApi('documents/file_remote.bin', pdfBytes);
    const result = await processMediaMessage(msg, api, downloadDir);

    // Non-image documents preserve user-supplied filename verbatim —
    // the fix is image-specific.
    expect(result!.file_name).toBe('report.pdf');
    expect(path.extname(result!.file_path!)).toBe('.pdf');
  });
});

describe('Track 2 fix: photo path is defensively sniffed', () => {
  let downloadDir: string;

  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'track2-photo-sniff-'));
  });

  afterEach(() => {
    rmSync(downloadDir, { recursive: true, force: true });
  });

  it('photo with JPEG bytes saved as .jpg (matches Telegram CDN contract)', async () => {
    const msg: TelegramMessage = {
      message_id: 1,
      date: 1700000000,
      chat: { id: 42, type: 'private' },
      from: { id: 1, first_name: 'Alice' },
      photo: [{ file_id: 'large', width: 800, height: 600 }],
    };
    const jpegBytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64, 0),
    ]);
    const api = createMockApi('photos/file_ABCDEFGhijk.jpg', jpegBytes);
    const result = await processMediaMessage(msg, api, downloadDir);

    expect(result!.image_path!.endsWith('.jpg')).toBe(true);
  });

  it('photo with PNG bytes (CDN drift) gets sniff-corrected to .png', async () => {
    const msg: TelegramMessage = {
      message_id: 1,
      date: 1700000000,
      chat: { id: 42, type: 'private' },
      from: { id: 1, first_name: 'Alice' },
      photo: [{ file_id: 'large', width: 800, height: 600 }],
    };
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0),
    ]);
    const api = createMockApi('photos/file_ABCDEFGhijk.jpg', pngBytes);
    const result = await processMediaMessage(msg, api, downloadDir);

    // Defensive sniff overrides hardcoded .jpg when bytes disagree.
    expect(result!.image_path!.endsWith('.png')).toBe(true);
  });
});
