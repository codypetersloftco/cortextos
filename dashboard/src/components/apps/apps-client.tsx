'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { IconExternalLink, IconPlayerPlay, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import type { AppGroup, InfraService, Pm2Status } from '@/lib/types';

interface AppsClientProps {
  initialGroups: AppGroup[];
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


function formatUptime(uptimeMs: number | null): string {
  if (uptimeMs === null) return '—';
  const s = Math.floor((Date.now() - uptimeMs) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function AppsClient({ initialGroups, initialInfra }: AppsClientProps) {
  const [groups, setGroups] = useState<AppGroup[]>(initialGroups);
  const [infra, setInfra] = useState<InfraService[]>(initialInfra);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/apps');
      if (!res.ok) return;
      const data = await res.json() as { groups: AppGroup[]; infra: InfraService[] };
      setGroups(data.groups ?? []);
      setInfra(data.infra ?? []);
    } catch {
      // silent — stays stale rather than crashing
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
        setTimeout(refresh, 1500);
      }
    } catch {
      setActionError(`Failed to ${action} ${name}`);
    } finally {
      setActionPending(null);
    }
  }

  async function handleGroupAction(group: AppGroup, action: 'start' | 'stop' | 'restart') {
    const targets =
      action === 'start'
        ? group.processes.filter((p) => p.status !== 'online').map((p) => p.name)
        : action === 'stop'
        ? group.processes.filter((p) => p.status === 'online').map((p) => p.name)
        : group.processes.map((p) => p.name);

    if (targets.length === 0) return;

    setActionPending(`${group.id}:${action}`);
    setActionError(null);
    try {
      await Promise.all(
        targets.map((name) =>
          fetch('/api/apps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, action }),
          }),
        ),
      );
      setTimeout(refresh, 1500);
    } catch {
      setActionError(`Failed to ${action} ${group.label}`);
    } finally {
      setActionPending(null);
    }
  }

  const hasAnyProcesses = groups.some((g) => g.processes.length > 0);

  return (
    <div className="space-y-4">
      {actionError && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {!hasAnyProcesses ? (
        <div className="rounded-lg border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
          No apps registered in PM2.{' '}
          <span className="font-mono text-xs">
            pm2 start C:\Users\cody\loftco.ecosystem.config.js
          </span>
        </div>
      ) : (
        groups.map((group) => {
          const onlineCount = group.processes.filter((p) => p.status === 'online').length;
          const total = group.processes.length;
          const allOnline = onlineCount === total;
          const allStopped = onlineCount === 0;
          const groupPending = actionPending?.startsWith(`${group.id}:`) ?? false;
          const frontend = group.processes.find((p) => p.url !== null);
          const frontendOnline = frontend?.status === 'online';

          return (
            <section
              key={group.id}
              className={cn(
                'overflow-hidden rounded-lg border bg-card',
                group.platform && 'border-primary/40',
              )}
            >
              {/* Group header */}
              <div
                className={cn(
                  'flex items-center justify-between border-b px-4 py-3',
                  group.platform ? 'bg-primary/8' : 'bg-muted/30',
                )}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
                      allOnline
                        ? 'bg-success animate-pulse-dot'
                        : allStopped
                        ? 'bg-muted-foreground/40'
                        : 'bg-warning animate-pulse-dot',
                    )}
                  />
                  <span className="text-sm font-semibold">{group.label}</span>
                  {group.platform && (
                    <span className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                      Platform
                    </span>
                  )}
                  {frontend?.url && frontendOnline && (
                    <a
                      href={frontend.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium hover:bg-muted dark:border-input dark:bg-input/30 dark:hover:bg-input/50"
                    >
                      <IconExternalLink size={11} />
                      Open
                    </a>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {allOnline
                      ? 'All online'
                      : allStopped
                      ? 'All stopped'
                      : `${onlineCount}/${total} online`}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={groupPending || allOnline}
                    onClick={() => handleGroupAction(group, 'start')}
                  >
                    <IconPlayerPlay size={12} className="mr-1" />
                    Start All
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={groupPending || allStopped}
                    onClick={() => handleGroupAction(group, 'stop')}
                  >
                    <IconPlayerStop size={12} className="mr-1" />
                    Stop All
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={groupPending}
                    onClick={() => handleGroupAction(group, 'restart')}
                  >
                    <IconRefresh size={12} className="mr-1" />
                    Restart All
                  </Button>
                </div>
              </div>

              {/* Per-process rows */}
              <table className="w-full text-sm">
                <tbody>
                  {group.processes.map((proc) => {

                    const isOnline = proc.status === 'online';
                    const procPending = actionPending?.startsWith(`${proc.name}:`) ?? false;

                    return (
                      <tr
                        key={proc.name}
                        className="border-b transition-colors last:border-0 hover:bg-muted/20"
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'inline-block h-2 w-2 shrink-0 rounded-full',
                                STATUS_DOT[proc.status] ?? 'bg-muted-foreground/40',
                              )}
                            />
                            <span className="font-medium">{proc.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground capitalize">
                          {proc.status !== 'online' ? proc.status : ''}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
                          {isOnline ? `${proc.cpuPercent}%` : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
                          {isOnline ? `${proc.memoryMb}MB` : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
                          {proc.restarts > 0 ? `↺${proc.restarts}` : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground" suppressHydrationWarning>
                          {formatUptime(proc.uptime)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            {!isOnline && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                disabled={procPending}
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
                                disabled={procPending}
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
                              disabled={procPending}
                              onClick={() => handleAction(proc.name, 'restart')}
                            >
                              <IconRefresh size={12} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Production environment row */}
              {group.production && (
                <div className="flex items-center gap-3 border-t bg-amber-50/30 px-4 py-2.5 dark:bg-amber-950/10">
                  <span
                    className={cn(
                      'inline-block h-2 w-2 shrink-0 rounded-full',
                      group.production.status === 'up' ? 'bg-success animate-pulse-dot' : 'bg-destructive',
                    )}
                  />
                  <span className="text-xs font-medium text-foreground/80">
                    Production
                  </span>
                  <span className="text-xs text-muted-foreground">{group.production.label}</span>
                  <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                    PROD
                  </span>
                  <span className={cn('ml-auto text-xs font-medium', group.production.status === 'up' ? 'text-success' : 'text-destructive')}>
                    {group.production.status === 'up' ? 'Online' : 'Offline'}
                  </span>
                </div>
              )}

              {/* Infra dependencies footer */}
              {group.infraDeps.length > 0 && (
                <div className="flex items-center gap-4 border-t bg-muted/10 px-4 py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                    Requires
                  </span>
                  {group.infraDeps.map((dep) => {
                    const svc = infra.find((s) => s.name === dep);
                    const up = svc?.status === 'up';
                    return (
                      <div key={dep} className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'inline-block h-2 w-2 shrink-0 rounded-full',
                            up ? 'bg-success animate-pulse-dot' : 'bg-destructive',
                          )}
                        />
                        <span className="text-xs text-muted-foreground">{dep}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })
      )}

      {/* Infrastructure */}
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
              {svc.status !== 'up' && (
                <span className="text-xs text-muted-foreground">Offline</span>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
