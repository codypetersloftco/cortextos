import { execSync } from 'child_process';
import https from 'https';
import net from 'net';
import type { AppGroup, AppGroupProduction, InfraService, Pm2Status } from '@/lib/types';

const APP_GROUPS_CONFIG = [
  {
    id: 'cortextos',
    label: 'cortextOS',
    processes: ['cortextos-daemon', 'cortextos-dashboard'],
    infraDeps: [] as string[],
    platform: true,
    productionConfig: null as null | { url: string; healthUrl: string; label: string },
  },
  {
    id: 'ai-admin',
    label: 'AI Admin',
    processes: ['ai-admin-frontend', 'ai-admin-backend', 'ai-admin-worker-fast', 'ai-admin-worker-slow'],
    infraDeps: ['PostgreSQL', 'Redis', 'Ollama'],
    platform: false,
    productionConfig: null as null | { url: string; healthUrl: string; label: string },
  },
  {
    id: 'lot-status',
    label: 'Lot Status',
    processes: ['lot-status-frontend', 'lot-status-backend'],
    infraDeps: [] as string[],
    platform: false,
    productionConfig: {
      url: 'https://db.loftco.com/v2/',
      healthUrl: 'https://db.loftco.com/v2/api/health',
      label: 'db.loftco.com',
    },
  },
  {
    id: 'fbi',
    label: 'Framing Bid Intelligence',
    processes: ['fbi-frontend', 'fbi-backend'],
    infraDeps: [] as string[],
    platform: false,
    productionConfig: null as null | { url: string; healthUrl: string; label: string },
  },
];

const MANAGED_APPS: string[] = APP_GROUPS_CONFIG.flatMap((g) => [...g.processes]);

const APP_URLS: Record<string, string> = {
  'ai-admin-frontend': 'https://localhost:5173',
  'fbi-frontend': 'http://localhost:5174',
  'lot-status-frontend': 'https://localhost:5175',
  'cortextos-dashboard': 'http://localhost:3000',
};

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

// Any HTTP response (including 401 from Windows Auth) means the service is up.
// Timeout or connection refused means down.
function checkProductionUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 3000 }, () => {
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

interface Pm2Raw {
  name: string;
  pm_id: number;
  pid: number | null;
  pm2_env: {
    status: string;
    restart_time: number;
    pm_uptime: number;
    autorestart?: boolean;
  };
  monit: { cpu: number; memory: number };
}

export async function getAppsData(): Promise<{ groups: AppGroup[]; infra: InfraService[] }> {
  const processMap = new Map<string, {
    pmId: number; pid: number | null; status: Pm2Status;
    cpuPercent: number; memoryMb: number; restarts: number; uptime: number | null; autorestart: boolean;
  }>();

  try {
    const output = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000, windowsHide: true });
    const raw = JSON.parse(output) as Pm2Raw[];
    const managedSet = new Set(MANAGED_APPS);

    for (const p of raw) {
      if (!managedSet.has(p.name)) continue;
      processMap.set(p.name, {
        pmId: p.pm_id,
        pid: p.pid ?? null,
        status: p.pm2_env.status as Pm2Status,
        cpuPercent: p.monit.cpu,
        memoryMb: Math.round(p.monit.memory / 1024 / 1024),
        restarts: p.pm2_env.restart_time,
        uptime: p.pm2_env.status === 'online' ? p.pm2_env.pm_uptime : null,
        autorestart: p.pm2_env.autorestart ?? true,
      });
    }
  } catch {
    // pm2 not running or no apps registered yet — groups will show all processes as stopped
  }

  // Run all health checks in parallel
  const prodChecks = await Promise.all(
    APP_GROUPS_CONFIG.map((g) =>
      g.productionConfig ? checkProductionUrl(g.productionConfig.healthUrl) : Promise.resolve(null),
    ),
  );

  const groups: AppGroup[] = APP_GROUPS_CONFIG.map((g, i) => {
    const prodUp = prodChecks[i];
    const production: AppGroupProduction | undefined =
      g.productionConfig && prodUp !== null
        ? { ...g.productionConfig, status: prodUp ? 'up' : 'down' }
        : undefined;

    return {
      id: g.id,
      label: g.label,
      platform: g.platform,
      infraDeps: [...g.infraDeps],
      ...(production ? { production } : {}),
      processes: g.processes.map((name) => {
        const pm2 = processMap.get(name);
        return pm2
          ? { name, url: APP_URLS[name] ?? null, ...pm2 }
          : { name, pmId: -1, pid: null, status: 'stopped' as Pm2Status, cpuPercent: 0, memoryMb: 0, restarts: 0, uptime: null, autorestart: true, url: APP_URLS[name] ?? null };
      }),
    };
  });

  const [pgUp, redisUp, ollamaUp] = await Promise.all([
    checkPort(5432),
    checkPort(6379),
    checkPort(11434),
  ]);

  const infra: InfraService[] = [
    { name: 'PostgreSQL', port: 5432, status: pgUp ? 'up' : 'down' },
    { name: 'Redis', port: 6379, status: redisUp ? 'up' : 'down' },
    { name: 'Ollama', port: 11434, status: ollamaUp ? 'up' : 'down' },
  ];

  return { groups, infra };
}
