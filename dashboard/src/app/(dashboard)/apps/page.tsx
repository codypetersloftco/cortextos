import { getAppsData } from '@/lib/data/apps';
import { AppsClient } from '@/components/apps/apps-client';

export const dynamic = 'force-dynamic';

export default async function AppsPage() {
  const { groups, infra } = await getAppsData();

  const allProcesses = groups.flatMap((g) => g.processes);
  const running = allProcesses.filter((p) => p.status === 'online').length;
  const total = allProcesses.length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Apps</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {total > 0
            ? `${groups.length} applications — ${running}/${total} services running`
            : 'No apps registered in PM2 yet'}
        </p>
      </div>

      <AppsClient initialGroups={groups} initialInfra={infra} />
    </div>
  );
}
