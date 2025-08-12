/**
 * Bootstrap database on first run in production environments.
 * - If there is no `Country` data, fetch world territories from mledoze/countries
 *   and insert them.
 * - If there is no `IpRange` data, insert a few sample ranges so that the
 *   generator endpoints can work before the full IP dataset is imported.
 *
 * Notes:
 * - This script is idempotent: it only performs inserts when the corresponding
 *   tables are empty. It will not delete any existing data.
 */

import { silentDb as db } from '../src/server/db';

interface TerritoryData {
  id: string; // ISO 3166-1 alpha-3 (e.g., CHN, USA)
  code2: string; // ISO 3166-1 alpha-2 (e.g., CN, US)
  nameEn: string;
  nameZh?: string | null;
  continent?: string | null;
  region?: string | null;
  independent: boolean; 
  unMember: boolean; 
}

async function fetchTerritories(): Promise<TerritoryData[]> {
  const res = await fetch('https://raw.githubusercontent.com/mledoze/countries/master/countries.json', { timeout: 10000 as unknown as number } as RequestInit);
  if (!res.ok) {
    throw new Error(`Failed to fetch territories: HTTP ${res.status}`);
  }
  const raw = (await res.json()) as unknown[];

  const territories: TerritoryData[] = raw.map((c: unknown) => {
    // Narrow the incoming shape safely
    const country = c as Record<string, unknown>;
    const name = country['name'] as Record<string, unknown> | undefined;
    const translations = country['translations'] as Record<string, unknown> | undefined;
    const zho = (translations?.['zho'] as Record<string, unknown> | undefined);

    const id = String(country['cca3'] ?? '').toUpperCase();
    const code2 = String(country['cca2'] ?? '').toUpperCase();
    const nameEn = String((name?.['common'] as string | undefined) ?? '');
    const nameZh = zho && typeof zho['common'] === 'string' ? String(zho['common']) : null;
    const continent = typeof country['region'] === 'string' ? String(country['region']) : null;
    const region = typeof country['subregion'] === 'string' ? String(country['subregion']) : null;
    const independent = Boolean(country['independent'] === true);
    const unMember = Boolean(country['unMember'] === true);

    return { id, code2, nameEn, nameZh, continent, region, independent, unMember };
  });

  return territories.filter(t => t.id.length === 3 && t.code2.length === 2 && t.nameEn.length > 0);
}

async function insertTerritoriesIfEmpty(): Promise<void> {
  const count = await db.country.count();
  if (count > 0) {
    return;
  }

  let territories: TerritoryData[] = [];
  try {
    territories = await fetchTerritories();
  } catch (e) {
    // 网络失败时使用最小内置种子，保证服务可用
    territories = [
      { id: 'USA', code2: 'US', nameEn: 'United States', nameZh: '美国', continent: 'Americas', region: 'North America', independent: true, unMember: true },
      { id: 'CHN', code2: 'CN', nameEn: 'China', nameZh: '中国', continent: 'Asia', region: 'Eastern Asia', independent: true, unMember: true },
      { id: 'JPN', code2: 'JP', nameEn: 'Japan', nameZh: '日本', continent: 'Asia', region: 'Eastern Asia', independent: true, unMember: true },
      { id: 'HKG', code2: 'HK', nameEn: 'Hong Kong', nameZh: '香港', continent: 'Asia', region: 'Eastern Asia', independent: false, unMember: false },
      { id: 'TWN', code2: 'TW', nameEn: 'Taiwan', nameZh: '台湾', continent: 'Asia', region: 'Eastern Asia', independent: false, unMember: false },
      { id: 'MAC', code2: 'MO', nameEn: 'Macao', nameZh: '澳门', continent: 'Asia', region: 'Eastern Asia', independent: false, unMember: false },
    ];
  }
  if (territories.length === 0) return;

  await db.country.createMany({
    data: territories.map(t => ({
      id: t.id,
      code2: t.code2,
      nameEn: t.nameEn,
      nameZh: t.nameZh ?? null,
      continent: t.continent ?? null,
      region: t.region ?? null,
      independent: t.independent,
      unMember: t.unMember,
    })),
  });
}

async function insertSampleIpRangesIfEmpty(): Promise<void> {
  const ranges = await db.ipRange.count();
  if (ranges > 0) {
    return;
  }

  // Minimal sample ranges for quick sanity checks
  const samples: Array<{ code3: string; start: string; end: string; isp: string }>
    = [
      { code3: 'USA', start: '8.8.0.0', end: '8.8.255.255', isp: 'Google LLC' },
      { code3: 'CHN', start: '1.2.0.0', end: '1.2.255.255', isp: 'China Telecom' },
      { code3: 'JPN', start: '13.107.0.0', end: '13.107.255.255', isp: 'Microsoft Corporation' },
    ];

  // Compute integer boundaries and insert
  const ipToInt = (ip: string): bigint => {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) {
      throw new Error(`Invalid IP: ${ip}`);
    }
    return BigInt(parts[0] * 256 ** 3 + parts[1] * 256 ** 2 + parts[2] * 256 + parts[3]);
  };

  await db.ipRange.createMany({
    data: samples.map(s => ({
      startIp: s.start,
      endIp: s.end,
      startIpInt: ipToInt(s.start),
      endIpInt: ipToInt(s.end),
      countryId: s.code3,
      isp: s.isp,
    }))
  });
}

async function main(): Promise<void> {
  try {
    await insertTerritoriesIfEmpty();
    await insertSampleIpRangesIfEmpty();
  } catch (error) {
    console.error('Bootstrap failed:', error);
  } finally {
    await db.$disconnect();
  }
}

// Execute when called directly
// biome-ignore lint/suspicious/noAssignInExpressions: compatibility with ESM execution guard
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export { main as bootstrapDb };


