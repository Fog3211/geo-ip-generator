/**
 * Generate combined IPv6 JSON data from IP2Location LITE IPv6 CSV
 * - No DB required; map alpha-2 -> alpha-3 using existing IPv4 combined JSON
 * - Output: data/combined-geo-ipv6-data.json and .min.json
 */

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { parse } from 'csv-parse';
import { randomUUID } from 'crypto';

const streamPipeline = promisify(pipeline);

// Data source for IPv6 LITE (country-only)
const IP2LOCATION_IPV6_URL = 'https://download.ip2location.com/lite/IP2LOCATION-LITE-DB1.IPV6.CSV.ZIP';
const DATA_DIR = path.join(process.cwd(), 'scripts', 'data');
const ZIP_FILE = path.join(DATA_DIR, 'IP2LOCATION-LITE-DB1.IPV6.CSV.ZIP');
const CSV_FILE = path.join(DATA_DIR, 'IP2LOCATION-LITE-DB1.IPV6.CSV');

// Input mapping source: existing IPv4 combined file
const IPV4_COMBINED_PATH = path.join(process.cwd(), 'data', 'combined-geo-ip-data.json');

interface CountryMapItem {
  id: string; // alpha-3
  code2: string; // alpha-2
  nameEn: string;
  nameZh?: string;
  continent?: string;
  region?: string;
}

interface Ipv6RangeRow {
  startIp: string; // textual IPv6
  endIp: string;   // textual IPv6
  countryCode: string; // alpha-2
  countryName: string;
}

interface Ipv6RangeOut {
  startIp: string;
  endIp: string;
  startIpBigInt: string; // 0..2^128-1 decimal string
  endIpBigInt: string;
  isp?: string;
}

interface CountryOut {
  id: string;
  code2: string;
  nameEn: string;
  nameZh?: string;
  continent?: string;
  region?: string;
  ipv6Ranges: Ipv6RangeOut[];
}

interface CombinedV6Data {
  metadata: {
    version: string;
    generatedAt: string;
    countries: number;
    ipRanges: number;
    dataSize: string;
  };
  countries: CountryOut[];
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

async function downloadIpliteIpv6(): Promise<void> {
  console.log('📥 Downloading IP2Location LITE IPv6 database...');
  ensureDir(DATA_DIR);
  const res = await fetch(IP2LOCATION_IPV6_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const tmp = path.join(DATA_DIR, `ipv6-${randomUUID()}.zip`);
  const out = fs.createWriteStream(tmp);
  if (res.body) {
    await streamPipeline(res.body as any, out);
  }
  if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
  fs.renameSync(tmp, ZIP_FILE);
  console.log('✅ IPv6 ZIP downloaded');
}

async function unzipCsv(): Promise<void> {
  console.log('📂 Extracting IPv6 ZIP...');
  const { exec } = await import('child_process');
  const { promisify: p } = await import('util');
  const execAsync = p(exec);
  await execAsync(`cd "${DATA_DIR}" && unzip -o "${ZIP_FILE}"`);
  console.log('✅ Extracted IPv6 CSV');
}

async function parseIpv6Csv(): Promise<Ipv6RangeRow[]> {
  console.log('📖 Parsing IPv6 CSV...');
  const rows: Ipv6RangeRow[] = [];
  const parser = parse({ columns: false, skip_empty_lines: true });
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(CSV_FILE);
    stream.pipe(parser);
    parser.on('data', (row: string[]) => {
      try {
        // Expected columns: start_ip, end_ip, country_code, country_name
        const startIp = row[0];
        const endIp = row[1];
        const cc = row[2];
        const cn = row[3];
        if (startIp && endIp && cc && cn) {
          rows.push({
            startIp: startIp.replace(/"/g, ''),
            endIp: endIp.replace(/"/g, ''),
            countryCode: cc.replace(/"/g, ''),
            countryName: cn.replace(/"/g, ''),
          });
        }
      } catch (e) {
        // skip bad row
      }
    });
    parser.on('end', () => resolve());
    parser.on('error', reject);
  });
  console.log(`✅ Parsed ${rows.length} IPv6 ranges`);
  return rows;
}

function loadCountryMapFromIpv4(): Map<string, CountryMapItem> {
  if (!fs.existsSync(IPV4_COMBINED_PATH)) {
    throw new Error('Missing data/combined-geo-ip-data.json. Run pnpm run generate:data first.');
  }
  const content = fs.readFileSync(IPV4_COMBINED_PATH, 'utf-8');
  const parsed = JSON.parse(content) as { countries: Array<{ id: string; code2: string; nameEn: string; nameZh?: string; continent?: string; region?: string }> };
  const map = new Map<string, CountryMapItem>();
  for (const c of parsed.countries) {
    map.set(c.code2.toUpperCase(), {
      id: c.id,
      code2: c.code2,
      nameEn: c.nameEn,
      nameZh: c.nameZh,
      continent: c.continent,
      region: c.region,
    });
  }
  return map;
}

function ipv6ToBigInt(ip: string): bigint {
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const totalParts = headParts.length + tailParts.length;
  const missing = 8 - totalParts;
  const parts: string[] = [];
  parts.push(...headParts);
  for (let i = 0; i < Math.max(0, missing); i++) parts.push('0');
  parts.push(...tailParts);
  if (parts.length !== 8) throw new Error(`Invalid IPv6 address: ${ip}`);
  let value = 0n;
  for (const p of parts) {
    const v = BigInt(Number.parseInt(p || '0', 16));
    value = (value << 16n) + v;
  }
  return value;
}

async function generateCombinedIpv6(): Promise<void> {
  console.log('🔄 Generating combined IPv6 data...');
  try {
    // Prepare data
    if (!fs.existsSync(CSV_FILE)) {
      await downloadIpliteIpv6();
      await unzipCsv();
    } else {
      console.log('📁 Using existing IPv6 CSV');
    }

    const rows = await parseIpv6Csv();
    const countryMap = loadCountryMapFromIpv4();

    // Build country ranges
    const ccToRanges = new Map<string, Ipv6RangeOut[]>();
    for (const row of rows) {
      const cc = row.countryCode.toUpperCase();
      if (!countryMap.has(cc)) continue; // skip unknown territories in our dataset
      let list = ccToRanges.get(cc);
      if (!list) { list = []; ccToRanges.set(cc, list); }
      try {
        const s = ipv6ToBigInt(row.startIp);
        const e = ipv6ToBigInt(row.endIp);
        if (e < s) continue;
        list.push({
          startIp: row.startIp,
          endIp: row.endIp,
          startIpBigInt: s.toString(),
          endIpBigInt: e.toString(),
        });
      } catch {
        // ignore malformed
      }
    }

    // Assemble output
    const countries: CountryOut[] = [];
    for (const [cc, ranges] of ccToRanges.entries()) {
      const meta = countryMap.get(cc);
      if (!meta) continue;
      // sort ranges by start for determinism
      const sorted = ranges.slice().sort((a, b) => BigInt(a.startIpBigInt) < BigInt(b.startIpBigInt) ? -1 : 1);
      countries.push({
        id: meta.id,
        code2: meta.code2,
        nameEn: meta.nameEn,
        nameZh: meta.nameZh,
        continent: meta.continent,
        region: meta.region,
        ipv6Ranges: sorted,
      });
    }

    const combined: CombinedV6Data = {
      metadata: {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        countries: countries.length,
        ipRanges: countries.reduce((sum, c) => sum + c.ipv6Ranges.length, 0),
        dataSize: '',
      },
      countries: countries.sort((a, b) => a.nameEn.localeCompare(b.nameEn)),
    };

    const outPath = path.join(process.cwd(), 'data', 'combined-geo-ipv6-data.json');
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, JSON.stringify(combined, null, 2), 'utf-8');

    // update size
    const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
    combined.metadata.dataSize = `${sizeMB}MB`;
    fs.writeFileSync(outPath, JSON.stringify(combined, null, 2), 'utf-8');

    console.log(`✅ IPv6 combined written: ${outPath} (${sizeMB}MB)`);

    // Minified variant
    const minOut = {
      metadata: combined.metadata,
      countries: combined.countries.map(c => ({
        id: c.id,
        code2: c.code2,
        nameEn: c.nameEn,
        nameZh: c.nameZh,
        ipv6Ranges: c.ipv6Ranges.map(r => [r.startIpBigInt, r.endIpBigInt]),
      })),
    };
    const minPath = path.join(process.cwd(), 'data', 'combined-geo-ipv6-data.min.json');
    fs.writeFileSync(minPath, JSON.stringify(minOut), 'utf-8');
    console.log(`📦 IPv6 minified written: ${minPath}`);
  } catch (error) {
    console.warn('⚠️ IPv6 generation encountered an issue (skipping):', error);
    // Do not fail the pipeline if IPv6 is optional
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateCombinedIpv6();
}


