import { getAppsData } from '@/lib/data/apps';
import { AppsClient } from '@/components/apps/apps-client';

export const dynamic = 'force-dynamic';

export default async function AppsPage() {
  const { processes, infra } = await getAppsData();

  const running = processes.filter((p) => p.status === 'online').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Apps</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {processes.length > 0
            ? `${processes.length} apps registered — ${running} running`
            : 'No apps registered in PM2 yet'}
        </p>
      </div>

      <AppsClient initialProcesses={processes} initialInfra={infra} />
    </div>
  );
}
