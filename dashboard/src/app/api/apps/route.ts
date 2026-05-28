import { NextRequest } from 'next/server';
import { execSync } from 'child_process';
import { getAppsData } from '@/lib/data/apps';

export const dynamic = 'force-dynamic';

const ALLOWED_APPS = new Set([
  'ai-admin-backend',
  'ai-admin-frontend',
  'ai-admin-worker-fast',
  'ai-admin-worker-slow',
  'lot-status-backend',
  'lot-status-frontend',
  'fbi-backend',
  'fbi-frontend',
  'cortextos-daemon',
  'cortextos-dashboard',
]);

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

// ---------------------------------------------------------------------------
// GET /api/apps — list PM2 processes + infra service status
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const data = await getAppsData();
    return Response.json({ ...data, lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error('[api/apps] GET error:', err);
    return Response.json({ error: 'Failed to fetch apps' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/apps — control a PM2 process
//
// Body: { name: string, action: "start" | "stop" | "restart" }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name, action } = body as { name?: string; action?: string };

  if (!name || !ALLOWED_APPS.has(name)) {
    return Response.json({ error: 'Invalid or unknown app name' }, { status: 400 });
  }
  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return Response.json(
      { error: `action must be one of: ${[...ALLOWED_ACTIONS].join(', ')}` },
      { status: 400 },
    );
  }

  // Both name and action are validated against allowlists — safe for shell interpolation.
  try {
    execSync(`pm2 ${action} ${name}`, {
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true,
    });
    return Response.json({ success: true, name, action });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/apps] POST ${action} ${name}:`, message);
    return Response.json({ error: `Failed to ${action} ${name}` }, { status: 500 });
  }
}
