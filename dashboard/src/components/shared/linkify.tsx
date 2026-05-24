'use client';

import { Fragment } from 'react';

// URLs: standard non-whitespace match
// Windows paths: drive letter through to a file extension (.xx to .xxxxx), allowing spaces
const LINK_PATTERN = /(https?:\/\/[^\s]+|[A-Z]:\\[^\n]*?\.\w{2,5}(?=[\s,;)\]}]|$))/gm;

function toVscodeUrl(path: string): string {
  return 'vscode://file/' + path.replace(/\\/g, '/');
}

function toPreviewUrl(path: string): string {
  return '/preview?path=' + encodeURIComponent(path);
}

function isMarkdown(path: string): boolean {
  return /\.md$/i.test(path);
}

export function Linkify({ text, className }: { text: string; className?: string }) {
  const normalized = text.replace(/\\n/g, '\n');
  const parts: (string | { href: string; label: string; isFile: boolean })[] = [];
  let lastIndex = 0;

  for (const match of normalized.matchAll(LINK_PATTERN)) {
    const idx = match.index!;
    if (idx > lastIndex) {
      parts.push(normalized.slice(lastIndex, idx));
    }
    const raw = match[0];
    const isFile = /^[A-Z]:\\/.test(raw);
    const href = isFile
      ? (isMarkdown(raw) ? toPreviewUrl(raw) : toVscodeUrl(raw))
      : raw;
    parts.push({ href, label: raw, isFile });
    lastIndex = idx + raw.length;
  }
  if (lastIndex < normalized.length) {
    parts.push(normalized.slice(lastIndex));
  }

  return (
    <span className={className}>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <Fragment key={i}>{part}</Fragment>
        ) : (
          <a
            key={i}
            href={part.href}
            className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
            {...(part.isFile && !isMarkdown(part.label)
              ? {}
              : !part.isFile
                ? { target: '_blank', rel: 'noopener noreferrer' }
                : {}
            )}
          >
            {part.label}
          </a>
        )
      )}
    </span>
  );
}
