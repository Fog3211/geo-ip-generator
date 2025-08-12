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
import { seedFromLocalJson } from './seed-from-json';

function run(cmd: string) {
  execSync(cmd, { stdio: 'inherit', env: process.env });
}

async function main(): Promise<void> {
  // 1) Sync schema
  run('pnpm exec prisma db push');

  // 2) Check if data exists
  const countryCount = await db.country.count();
  const ipRangeCount = await db.ipRange.count();
  if (countryCount > 0 && ipRangeCount > 0) {
    await db.$disconnect();
    return;
  }

  // 3) Prefer local JSON seed
  try {
    await seedFromLocalJson();
    await db.$disconnect();
    return;
  } catch (e) {
    console.warn('Local JSON seed failed, trying online import...', e);
  }

  // 4) Fallback to online imports
  run('pnpm run import:territories');
  run('pnpm run import:ip2location');
  await db.$disconnect();
}

// biome-ignore lint/suspicious/noAssignInExpressions: exec guard
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('prestart failed:', err);
    process.exit(1);
  });
}


