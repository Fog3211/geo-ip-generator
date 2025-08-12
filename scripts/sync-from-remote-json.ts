/**
 * Sync database from remote combined JSON on every start.
 * - Always clears existing tables then imports the latest dataset
 * - Blocks process (non-zero exit) on failure so the service won't start
 *
 * Remote JSON shape is the same as data/combined-geo-ip-data.json
 */

import { silentDb as db } from '../src/server/db';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Primary / backup dataset URLs
const DEFAULT_PRIMARY = 'https://github.com/Fog3211/geo-ip-generator/releases/latest/download/combined-geo-ip-data.json';
const DEFAULT_BACKUP = 'https://raw.githubusercontent.com/Fog3211/geo-ip-generator/main/data/combined-geo-ip-data.json';

const DATA_URL = process.env.GEO_DATA_URL ?? DEFAULT_PRIMARY;
const BACKUP_URL = process.env.GEO_DATA_BACKUP_URL ?? DEFAULT_BACKUP;
const MAX_RETRIES = 3;

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Geo-IP-Generator/Sync' } });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    const backoffMs = 500 * (i + 1);
    await new Promise(r => setTimeout(r, backoffMs));
  }
  throw lastErr instanceof Error ? lastErr : new Error('Unknown fetch error');
}

async function loadCombinedJson(): Promise<CombinedJson> {
  // Support local file path to avoid network in development
  const url = DATA_URL.trim();
  const isFileScheme = url.startsWith('file:');
  const isPath = !/^https?:\/\//i.test(url) && !isFileScheme;

  if (isFileScheme || isPath) {
    const filePath = isFileScheme ? fileURLToPath(url) : path.resolve(process.cwd(), url);
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as CombinedJson;
  }

  try {
    const res = await fetchWithRetry(url);
    return (await res.json()) as CombinedJson;
  } catch (primaryErr) {
    console.warn('Primary dataset fetch failed, trying backup:', primaryErr);
    const res2 = await fetchWithRetry(BACKUP_URL);
    return (await res2.json()) as CombinedJson;
  }
}

async function importData(data: CombinedJson): Promise<void> {
  if (!data || !Array.isArray(data.countries)) {
    throw new Error('Invalid combined JSON format');
  }

  console.log(`\n🌐 Remote dataset: ${data.countries.length} countries, ${data.metadata.ipRanges} ranges`);

  // 1) Clean existing data (respect FK order)
  console.log('🧹 Truncating existing tables...');
  await db.$transaction([
    db.ipRange.deleteMany(),
    db.city.deleteMany(),
    db.region.deleteMany(),
    db.country.deleteMany(),
  ]);

  // 2) Insert countries
  console.log('🗺️  Inserting countries...');
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

  // 3) Insert IP ranges in batches
  console.log('📦 Inserting IP ranges in batches...');
  const batchSize = 5000;
  let total = 0;
  for (const country of data.countries) {
    for (let i = 0; i < country.ipRanges.length; i += batchSize) {
      const chunk = country.ipRanges.slice(i, i + batchSize);
      await db.ipRange.createMany({
        data: chunk.map(r => ({
          startIp: r.startIp,
          endIp: r.endIp,
          startIpInt: BigInt(r.startIpInt),
          endIpInt: BigInt(r.endIpInt),
          countryId: country.id,
          isp: r.isp ?? null,
        }))
      });
      total += chunk.length;
      if (total % 50000 === 0) {
        console.log(`   ... ${total} ranges inserted`);
      }
    }
  }

  console.log(`✅ Import finished: ${data.countries.length} countries, ${total} ranges`);
}

async function main(): Promise<void> {
  try {
    console.log(`🚀 Sync dataset: ${DATA_URL}`);
    const json = await loadCombinedJson();
    await importData(json);
  } catch (error) {
    console.error('❌ Remote JSON sync failed:', error);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

// Execute when called directly
// biome-ignore lint/suspicious/noAssignInExpressions: exec guard
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export { main as syncFromRemoteJson };


