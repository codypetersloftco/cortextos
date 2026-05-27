import { execSync } from 'child_process';
import net from 'net';
import type { ProcessInfo, InfraService, Pm2Status } from '@/lib/types';

const MANAGED_APPS = [
  'ai-admin-backend',
  'ai-admin-frontend',
  'ai-admin-worker-fast',
  'ai-admin-worker-slow',
  'lot-status-backend',
  'lot-status-frontend',
  'fbi-backend',
  'fbi-frontend',
] as const;

/** Maps frontend app names to their localhost URL (from each project's vite.config.ts). */
const APP_URLS: Record<string, string> = {
  'ai-admin-frontend': 'https://localhost:5173',
  'fbi-frontend': 'http://localhost:5174',
  'lot-status-frontend': 'https://localhost:5175',
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

function fetchPm2Processes(): ProcessInfo[] {
  const output = execSync('pm2 jlist', {
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
  });

  const raw = JSON.parse(output) as Pm2Raw[];
  const managedSet = new Set<string>(MANAGED_APPS);

  return raw
    .filter((p) => managedSet.has(p.name))
    .map((p) => {
      return {
        name: p.name,
        pmId: p.pm_id,
        pid: p.pid ?? null,
        status: p.pm2_env.status as Pm2Status,
        cpuPercent: p.monit.cpu,
        memoryMb: Math.round(p.monit.memory / 1024 / 1024),
        restarts: p.pm2_env.restart_time,
        uptime: p.pm2_env.status === 'online' ? p.pm2_env.pm_uptime : null,
        autorestart: p.pm2_env.autorestart ?? true,
        url: APP_URLS[p.name] ?? null,
      };
    });
}

export async function getAppsData(): Promise<{ processes: ProcessInfo[]; infra: InfraService[] }> {
  let processes: ProcessInfo[] = [];
  try {
    processes = fetchPm2Processes();
  } catch {
    // pm2 not running or no apps registered yet
  }

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

  return { processes, infra };
}
