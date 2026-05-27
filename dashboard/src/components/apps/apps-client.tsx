'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { IconExternalLink, IconPlayerPlay, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import type { ProcessInfo, InfraService, Pm2Status } from '@/lib/types';

interface AppsClientProps {
  initialProcesses: ProcessInfo[];
  initialInfra: InfraService[];
}

const STATUS_DOT: Record<Pm2Status, string> = {
  online: 'bg-success animate-pulse-dot',
  stopped: 'bg-muted-foreground/40',
  errored: 'bg-destructive',
  stopping: 'bg-warning',
  launching: 'bg-warning animate-pulse-dot',
  'one-launch-status': 'bg-muted-foreground/40',
};

const STATUS_BADGE: Record<Pm2Status, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  online: 'default',
  stopped: 'secondary',
  errored: 'destructive',
  stopping: 'outline',
  launching: 'outline',
  'one-launch-status': 'secondary',
};

function formatUptime(uptimeMs: number | null): string {
  if (uptimeMs === null) return '—';
  const s = Math.floor((Date.now() - uptimeMs) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function AppsClient({ initialProcesses, initialInfra }: AppsClientProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>(initialProcesses);
  const [infra, setInfra] = useState<InfraService[]>(initialInfra);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/apps');
      if (!res.ok) return;
      const data = await res.json() as { processes: ProcessInfo[]; infra: InfraService[] };
      setProcesses(data.processes ?? []);
      setInfra(data.infra ?? []);
    } catch {
      // silent — dashboard stays stale rather than crashing
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleAction(name: string, action: 'start' | 'stop' | 'restart') {
    setActionPending(`${name}:${action}`);
    setActionError(null);
    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, action }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setActionError(data.error ?? `Failed to ${action} ${name}`);
      } else {
        // Give PM2 a second to update process state, then refresh
        setTimeout(refresh, 1500);
      }
    } catch {
      setActionError(`Failed to ${action} ${name}`);
    } finally {
      setActionPending(null);
    }
  }

  return (
    <div className="space-y-8">
      {actionError && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {/* ── Applications (frontends) ────────────────────────────────── */}
      {(() => {
        const frontends = processes.filter((p) => p.name.includes('frontend'));
        const services = processes.filter((p) => !p.name.includes('frontend'));

        function renderTable(items: ProcessInfo[], showOpen: boolean) {
          return (
            <div className="overflow-hidden rounded-lg border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">App</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">CPU</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Mem</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Restarts</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Uptime</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((proc) => {
                    const isOnline = proc.status === 'online';
                    const isPending = actionPending?.startsWith(proc.name) ?? false;

                    return (
                      <tr
                        key={proc.name}
                        className="border-b transition-colors last:border-0 hover:bg-muted/30"
                      >
                        <td className="px-4 py-2.5 font-medium">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'inline-block h-2 w-2 shrink-0 rounded-full',
                                STATUS_DOT[proc.status] ?? 'bg-muted-foreground/40',
                              )}
                            />
                            {proc.name}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge
                            variant={STATUS_BADGE[proc.status] ?? 'outline'}
                            className="text-xs capitalize"
                          >
                            {proc.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {isOnline ? `${proc.cpuPercent}%` : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {isOnline ? `${proc.memoryMb} MB` : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {proc.restarts}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {formatUptime(proc.uptime)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            {showOpen && proc.url && isOnline && (
                              <a
                                href={proc.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-xs font-medium hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50"
                              >
                                <IconExternalLink size={12} className="mr-1" />
                                Open
                              </a>
                            )}
                            {!isOnline && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                disabled={isPending}
                                onClick={() => handleAction(proc.name, 'start')}
                              >
                                <IconPlayerPlay size={12} className="mr-1" />
                                Start
                              </Button>
                            )}
                            {isOnline && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                disabled={isPending}
                                onClick={() => handleAction(proc.name, 'stop')}
                              >
                                <IconPlayerStop size={12} className="mr-1" />
                                Stop
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={isPending}
                              onClick={() => handleAction(proc.name, 'restart')}
                            >
                              <IconRefresh size={12} className="mr-1" />
                              Restart
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }

        if (processes.length === 0) {
          return (
            <section className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Loftco Apps
              </p>
              <div className="rounded-lg border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                No apps registered in PM2.{' '}
                <span className="font-mono text-xs">
                  pm2 start C:\Users\cody\loftco.ecosystem.config.js
                </span>
              </div>
            </section>
          );
        }

        return (
          <>
            {frontends.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  Applications
                </p>
                {renderTable(frontends, true)}
              </section>
            )}
            {services.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  Services
                </p>
                {renderTable(services, false)}
              </section>
            )}
          </>
        );
      })()}

      {/* ── Infrastructure ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Infrastructure
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {infra.map((svc) => (
            <div
              key={svc.name}
              className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3"
            >
              <span
                className={cn(
                  'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
                  svc.status === 'up' ? 'bg-success animate-pulse-dot' : 'bg-destructive',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{svc.name}</p>
                <p className="text-xs text-muted-foreground">:{svc.port}</p>
              </div>
              <Badge variant={svc.status === 'up' ? 'default' : 'secondary'} className="text-xs">
                {svc.status}
              </Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
