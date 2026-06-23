import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Matches the dashboard's tsconfig path alias so tests under
      // dashboard/src/**/__tests__ can import dashboard source via "@/…".
      '@': path.resolve(__dirname, 'dashboard/src'),
      // Dashboard tests need to resolve `next/server` and other Next deps
      // from dashboard/node_modules, because root's package.json does not
      // depend on Next.js.
      'next/server': path.resolve(__dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    // Scrub inherited CTX_* env vars before each worker runs its tests, so the
    // suite produces the same clean baseline whether invoked from CI or from a
    // live cortextOS agent cwd. See tests/setup/scrub-ctx-env.ts.
    setupFiles: ['tests/setup/scrub-ctx-env.ts'],
    include: [
      'tests/**/*.test.ts',
      'dashboard/src/**/__tests__/**/*.test.ts',
    ],
  },
});
