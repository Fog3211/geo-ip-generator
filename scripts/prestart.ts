/**
 * Prestart Orchestrator
 *
 * Goals:
 * - Ensure Prisma schema is applied
 * - If database is empty, prefer seeding from local combined JSON
 * - If local JSON is unavailable, fallback to online import scripts
 */

import { execSync } from 'child_process';
import { silentDb as db } from '../src/server/db';
import { syncFromRemoteJson } from './sync-from-remote-json';

function run(cmd: string) {
  execSync(cmd, { stdio: 'inherit', env: process.env });
}

async function main(): Promise<void> {
  // 1) Sync schema
  run('pnpm exec prisma db push');

  // 2) Always sync from remote JSON (clear and refill)
  await syncFromRemoteJson();
  await db.$disconnect();
}

// biome-ignore lint/suspicious/noAssignInExpressions: exec guard
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('prestart failed:', err);
    process.exit(1);
  });
}


