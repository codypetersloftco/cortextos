'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { Card } from '@/components/ui/card';
import { PriorityBadge, TimeAgo, Linkify } from '@/components/shared';
import type { Task } from '@/lib/types';

interface HumanTaskBannerProps {
  tasks: Task[];
  onTaskClick?: (task: Task) => void;
}

export function HumanTaskBanner({ tasks, onTaskClick }: HumanTaskBannerProps) {
  const humanTasks = tasks.filter(
    (t) => t.title.includes('[HUMAN]') && t.status !== 'completed'
  );

  if (humanTasks.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <IconAlertTriangle className="size-5 text-amber-500" />
        <h2 className="text-sm font-semibold text-amber-500">
          Needs Your Attention ({humanTasks.length})
        </h2>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {humanTasks.map((task) => (
          <Card
            key={task.id}
            className="cursor-pointer border-amber-500/20 p-3 transition-colors hover:bg-amber-500/10"
            onClick={() => onTaskClick?.(task)}
          >
            <div className="space-y-2">
              <p className="text-sm font-medium leading-snug line-clamp-2">
                {task.title.replace('[HUMAN] ', '')}
              </p>
              {task.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">
                  <Linkify text={task.description} />
                </p>
              )}
              <div className="flex items-center justify-between">
                <PriorityBadge priority={task.priority} />
                <TimeAgo date={task.created_at} className="text-xs" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
