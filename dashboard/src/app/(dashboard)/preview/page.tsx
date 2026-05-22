'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { IconArrowLeft, IconExternalLink, IconCopy, IconCheck } from '@tabler/icons-react';

export default function PreviewPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const filePath = searchParams.get('path') ?? '';

  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  useEffect(() => {
    if (!filePath) {
      setError('No file path provided');
      setLoading(false);
      return;
    }

    const normalized = filePath.replace(/\\/g, '/');

    fetch(`/api/media/${encodeURI(normalized)}?render=true`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || `Failed to load file (${res.status})`);
        }
        return res.text();
      })
      .then(setHtml)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filePath]);

  function handleCopy() {
    navigator.clipboard.writeText(filePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push('/tasks')}>
          <IconArrowLeft className="size-4 mr-1" />
          Back
        </Button>
        <h1 className="text-lg font-semibold truncate flex-1">{fileName}</h1>
        <Button variant="ghost" size="icon-sm" onClick={handleCopy} title="Copy path">
          {copied ? <IconCheck className="size-4 text-green-500" /> : <IconCopy className="size-4" />}
        </Button>
        <a
          href={`vscode://file/${filePath.replace(/\\/g, '/')}`}
          title="Open in VS Code"
          className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <IconExternalLink className="size-4" />
        </a>
      </div>

      <p className="text-xs text-muted-foreground break-all px-1">{filePath}</p>

      {loading && (
        <div className="space-y-3 pt-8">
          <div className="h-6 w-2/3 rounded bg-muted/30 animate-pulse" />
          <div className="h-4 w-full rounded bg-muted/30 animate-pulse" />
          <div className="h-4 w-5/6 rounded bg-muted/30 animate-pulse" />
          <div className="h-4 w-full rounded bg-muted/30 animate-pulse" />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && !error && html && (
        <article
          className="prose prose-sm dark:prose-invert max-w-none rounded-lg border bg-card p-6"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
