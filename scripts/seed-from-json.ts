/**
 * Seed database from local combined JSON dataset.
 *
 * Source file: data/combined-geo-ip-data.json
 * Shape:
 * {
 *   metadata: {...},
 *   countries: [
 *     {
 *       id, code2, nameEn, nameZh?, continent?, region?, independent, unMember,
 *       ipRanges: [{ startIp, endIp, startIpInt, endIpInt, isp? }, ...]
 *     }, ...
 *   ]
 * }
 */

import fs from 'fs';
import path from 'path';
import { silentDb as db } from '../src/server/db';

interface JsonIpRange { startIp: string; endIp: string; startIpInt: string; endIpInt: string; isp?: string }
interface JsonCountry {
  id: string;
  code2: string;
  nameEn: string;
  nameZh?: string;
  continent?: string;
  region?: string;
  independent: boolean;
  unMember: boolean;
  ipRanges: JsonIpRange[];
}

interface CombinedJson {
  metadata: { version: string; generatedAt: string; countries: number; ipRanges: number; dataSize: string };
  countries: JsonCountry[];
}

async function seedFromLocalJson(): Promise<void> {
  const filePath = path.join(process.cwd(), 'data', 'combined-geo-ip-data.json');
  if (!fs.existsSync(filePath)) {
    console.log('Local combined JSON not found, skipping seed:', filePath);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content) as CombinedJson;

  if (!data || !Array.isArray(data.countries)) {
    throw new Error('Invalid combined JSON format');
  }

  console.log(`Seeding from local JSON: ${data.countries.length} countries, ${data.metadata.ipRanges} ranges`);

  // Clean tables first
  await db.$transaction([
    db.ipRange.deleteMany(),
    db.city.deleteMany(),
    db.region.deleteMany(),
    db.country.deleteMany(),
  ]);

  // Insert countries in bulk
  await db.country.createMany({
    data: data.countries.map(c => ({
      id: c.id,
      code2: c.code2,
      nameEn: c.nameEn,
      nameZh: c.nameZh ?? null,
      continent: c.continent ?? null,
      region: c.region ?? null,
      independent: Boolean(c.independent),
      unMember: Boolean(c.unMember),
    })),
  });

  // Insert IP ranges in batches to avoid exceeding statement size
  const batchSize = 5000;
  let total = 0;
  for (const country of data.countries) {
    const chunks: JsonIpRange[][] = [];
    for (let i = 0; i < country.ipRanges.length; i += batchSize) {
      chunks.push(country.ipRanges.slice(i, i + batchSize));
    }

    for (const chunk of chunks) {
      await db.ipRange.createMany({
        data: chunk.map(r => ({
          startIp: r.startIp,
          endIp: r.endIp,
          startIpInt: BigInt(r.startIpInt),
          endIpInt: BigInt(r.endIpInt),
          countryId: country.id,
          isp: r.isp ?? null,
        })),
      });
      total += chunk.length;
    }
  }

  console.log(`Seed finished: inserted ${data.countries.length} countries, ${total} ip ranges`);
}

async function main(): Promise<void> {
  try {
    await seedFromLocalJson();
  } catch (error) {
    console.error('Seed from JSON failed:', error);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

// Execute when called directly
// biome-ignore lint/suspicious/noAssignInExpressions: exec guard
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export { seedFromLocalJson };


