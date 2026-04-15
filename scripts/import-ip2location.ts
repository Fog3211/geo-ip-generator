import { createWriteStream } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';
import { ipToInt, intToIp } from '../src/lib/utils/ip-utils';
import { silentDb as db, optimizeSQLiteForBulkOps } from '../src/server/db';

const streamPipeline = promisify(pipeline);

// IP2Location LITE download URLs (free version) - with fallback mirrors
const IP2LOCATION_URLS = [
  'https://download.ip2location.com/lite/IP2LOCATION-LITE-DB1.CSV.ZIP',
  // Add backup URLs if needed in the future
] as const;
const DATA_DIR = path.join(process.cwd(), 'scripts', 'data');
const ZIP_FILE = path.join(DATA_DIR, 'IP2LOCATION-LITE-DB1.CSV.ZIP');
const CSV_FILE = path.join(DATA_DIR, 'IP2LOCATION-LITE-DB1.CSV');

interface IPLocationRecord {
  startIp: string;
  endIp: string;
  countryCode: string;
  countryName: string;
}

interface DatabaseStats {
  total: number;
  imported: number;
  skipped: number;
  errors: number;
}

// Territory lookup cache for performance
let territoryCache: Map<string, { id: string; nameEn: string }> | null = null;

/**
 * Load and cache territory data from database
 */
async function loadTerritoryCache(): Promise<void> {
  if (territoryCache) return;
  
  console.log('🔄 Loading territory data from database...');
  
  const territories = await db.country.findMany({
    select: {
      id: true,
      code2: true,
      nameEn: true,
    },
  });
  
  territoryCache = new Map();
  territories.forEach(territory => {
    territoryCache!.set(territory.code2.toUpperCase(), {
      id: territory.id,
      nameEn: territory.nameEn,
    });
  });
  
  console.log(`✅ Loaded ${territories.length} territories into cache`);
}

/**
 * Find territory by 2-letter code
 */
function getTerritoryByCode2(code2: string): { id: string; nameEn: string } | undefined {
  if (!territoryCache) {
    throw new Error('Territory cache not loaded. Call loadTerritoryCache() first.');
  }
  return territoryCache.get(code2.toUpperCase());
}


async function ensureDataDirectory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

async function downloadIPData(): Promise<void> {
  console.log('📥 Downloading IP2Location LITE database...');
  console.log('📍 Data source: IP2Location LITE DB1 (Country only, Free version)');
  console.log('🔗 More info: https://lite.ip2location.com/');
  
  const maxRetries = 3;
  let attempt = 1;
  
  while (attempt <= maxRetries) {
    try {
      console.log(`🔄 Download attempt ${attempt}/${maxRetries}...`);
      
      // Try each URL until one succeeds
      let response: Response | null = null;
      let lastError: Error | null = null;
      
      for (const url of IP2LOCATION_URLS) {
        try {
          console.log(`🔗 Trying URL: ${url}`);
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000);

          try {
            response = await fetch(url, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'geo-ip-generator/1.0 (+https://github.com/Fog3211/geo-ip-generator)'
              }
            });
          } finally {
            clearTimeout(timeoutId);
          }
          
          if (response.ok) {
            console.log(`✅ Successfully connected to: ${url}`);
            break;
          } else {
            console.log(`⚠️ URL returned ${response.status}: ${url}`);
            lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
            response = null;
          }
        } catch (urlError) {
          console.log(`❌ Failed to connect to: ${url}`, urlError);
          lastError = urlError as Error;
          response = null;
        }
      }
      
      if (!response) {
        throw lastError || new Error('All download URLs failed');
      }
      
      const fileStream = createWriteStream(ZIP_FILE);
      if (response.body) {
        await streamPipeline(response.body as any, fileStream);
      }
      
      // Verify file was downloaded successfully
      const stats = fs.statSync(ZIP_FILE);
      if (stats.size < 1000) { // Less than 1KB probably means an error
        throw new Error('Downloaded file is too small, likely corrupted');
      }
      
      console.log(`✅ Download completed (${Math.round(stats.size / 1024 / 1024 * 100) / 100} MB)`);
      return;
      
    } catch (error) {
      console.error(`❌ Download attempt ${attempt} failed:`, error);
      
      if (attempt === maxRetries) {
        console.error('🚫 All download attempts failed');
        throw new Error(`Failed to download after ${maxRetries} attempts: ${error}`);
      }
      
      // Wait before retry (exponential backoff)
      const waitTime = Math.pow(2, attempt) * 1000;
      console.log(`⏳ Waiting ${waitTime}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      attempt++;
    }
  }
}

async function extractZipFile(): Promise<void> {
  console.log('📂 Extracting ZIP file...');
  
  try {
    // Check if unzip is available
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // Try to check if unzip is available
    try {
      await execAsync('which unzip');
    } catch {
      console.log('⚠️ unzip command not found, trying alternative extraction...');
      
      // Try using Node.js built-in extraction (if available)
      try {
        const AdmZipModule = await import('adm-zip').catch(() => null) as unknown as { default: new (filePath: string) => { extractAllTo: (targetPath: string, overwrite?: boolean) => void } } | null;
        if (AdmZipModule) {
          const zip = new AdmZipModule.default(ZIP_FILE);
          zip.extractAllTo(DATA_DIR, true);
          console.log('✅ ZIP file extracted using Node.js');
          return;
        }
      } catch (nodeZipError) {
        console.log('⚠️ Node.js ZIP extraction also failed:', nodeZipError);
      }
      
      throw new Error('No extraction method available. Please install unzip or extract manually.');
    }
    
    // Use unzip command
    const extractCommand = `cd "${DATA_DIR}" && unzip -o "${ZIP_FILE}"`;
    console.log(`🔧 Running: ${extractCommand}`);
    
    const { stdout, stderr } = await execAsync(extractCommand);
    if (stderr && !stderr.includes('inflating:')) {
      console.warn('⚠️ Extraction warnings:', stderr);
    }
    if (stdout) {
      console.log('📋 Extraction output:', stdout);
    }
    
    // Verify extraction succeeded
    if (!fs.existsSync(CSV_FILE)) {
      throw new Error(`CSV file not found after extraction: ${CSV_FILE}`);
    }
    
    console.log('✅ ZIP file extracted successfully');
  } catch (error) {
    console.error('❌ ZIP extraction failed:', error);
    console.log('💡 Manual extraction steps:');
    console.log(`1. Extract ${ZIP_FILE} to ${DATA_DIR}`);
    console.log(`2. Ensure ${CSV_FILE} exists`);
    console.log('3. Run this script again');
    throw error;
  }
}

async function parseCSVFile(): Promise<IPLocationRecord[]> {
  console.log('📖 Parsing CSV file...');
  
  const records: IPLocationRecord[] = [];
  const parser = parse({
    columns: false,
    skip_empty_lines: true,
  });
  
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(CSV_FILE);
    
    stream.pipe(parser);
    
    parser.on('data', (row: string[]) => {
      try {
        // IP2Location CSV format: start_ip_int, end_ip_int, country_code, country_name
        const startIpInt = row[0];
        const endIpInt = row[1];
        const countryCode = row[2];
        const countryName = row[3];
        
        if (startIpInt && endIpInt && countryCode && countryName) {
          const startIp = intToIp(BigInt(startIpInt));
          const endIp = intToIp(BigInt(endIpInt));
          
          records.push({
            startIp,
            endIp,
            countryCode: countryCode.replace(/"/g, ''), // Remove quotes
            countryName: countryName.replace(/"/g, ''), // Remove quotes
          });
        }
      } catch (error) {
        console.warn('⚠️ Skipping invalid row:', error);
      }
    });
    
    parser.on('end', () => {
      console.log(`✅ Parsed ${records.length} IP ranges`);
      resolve(records);
    });
    
    parser.on('error', reject);
  });
}

async function importIPRanges(records: IPLocationRecord[]): Promise<void> {
  console.log('🔢 Importing IP ranges...');
  
  // Load territory cache first
  await loadTerritoryCache();
  
  const stats: DatabaseStats = {
    total: records.length,
    imported: 0,
    skipped: 0,
    errors: 0,
  };
  
  const batchSize = 5000; // Increased batch size for better performance
  console.log(`📦 Processing ${records.length} records in batches of ${batchSize}...`);
  
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    
    try {
      // Prepare batch data for bulk insert
      const batchData: Array<{
        startIp: string;
        endIp: string;
        startIpInt: bigint;
        endIpInt: bigint;
        countryId: string;
      }> = [];
      
      // Process batch to filter valid records
      for (const record of batch) {
        const territory = getTerritoryByCode2(record.countryCode);
        if (territory) {
          batchData.push({
            startIp: record.startIp,
            endIp: record.endIp,
            startIpInt: BigInt(ipToInt(record.startIp)),
            endIpInt: BigInt(ipToInt(record.endIp)),
            countryId: territory.id,
          });
        } else {
          stats.skipped++;
        }
      }
      
      // Bulk insert the entire batch in a transaction
      if (batchData.length > 0) {
        await db.$transaction(async (tx) => {
          const result = await tx.ipRange.createMany({
            data: batchData,
          });
          
          stats.imported += result.count;
        }, {
          timeout: 120000, // 2 minutes timeout for large batches
        });
      }
      
    } catch (error) {
      console.error(`❌ Error importing batch starting at index ${i}:`, error);
      stats.errors += batch.length;
    }
    
    // Progress update
    const processed = Math.min(i + batchSize, records.length);
    const progressPct = Math.round((processed / stats.total) * 100);
    console.log(`   📊 Progress: ${processed}/${stats.total} (${progressPct}%) - Imported: ${stats.imported}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);
  }
  
  console.log(`✅ IP range import completed:`);
  console.log(`   Total records: ${stats.total}`);
  console.log(`   Successfully imported: ${stats.imported}`);
  console.log(`   Skipped (unknown territory): ${stats.skipped}`);
  console.log(`   Errors: ${stats.errors}`);
  console.log(`   Success rate: ${Math.round((stats.imported / stats.total) * 100)}%`);
}

async function cleanup(): Promise<void> {
  console.log('🧹 Cleaning up temporary files...');
  
  try {
    if (fs.existsSync(ZIP_FILE)) {
      fs.unlinkSync(ZIP_FILE);
    }
    if (fs.existsSync(CSV_FILE)) {
      fs.unlinkSync(CSV_FILE);
    }
    console.log('✅ Cleanup completed');
  } catch (error) {
    console.warn('⚠️ Cleanup warning:', error);
  }
}

async function showStatistics(): Promise<void> {
  console.log('\n📈 Final Statistics:');
  
  const territoryCount = await db.country.count();
  const ipRangeCount = await db.ipRange.count();
  
  console.log(`   Total territories/countries: ${territoryCount}`);
  console.log(`   IP ranges: ${ipRangeCount}`);
  
  // Show IP ranges by territory (top 10)
  const topTerritories = await db.country.findMany({
    select: {
      code2: true,
      nameEn: true,
      nameZh: true,
      _count: {
        select: {
          ipRanges: true,
        },
      },
    },
    orderBy: {
      ipRanges: {
        _count: 'desc',
      },
    },
    take: 10,
  });
  
  console.log('\n🏆 Top 10 territories by IP ranges:');
  topTerritories.forEach((territory, index) => {
    const chineseName = territory.nameZh ? ` / ${territory.nameZh}` : '';
    console.log(`   ${index + 1}. ${territory.code2} - ${territory.nameEn}${chineseName} (${territory._count.ipRanges} ranges)`);
  });
  
  console.log('\n🎯 Next steps:');
  console.log('   1. Run database migration: pnpm run db:generate');
  console.log('   2. Update territories data: pnpm run import:territories');
  console.log('   3. Test API: GET /api/trpc/ipRegion.generateIpByCountry?input={"query":"CHN","count":1}');
}

async function main() {
  console.log('🚀 Starting Real IP Data Import...');
  console.log('📊 Data Source: IP2Location LITE (Free)');
  console.log('🌍 Coverage: Global IP ranges with country information');
  console.log('');
  
  try {
    // Apply SQLite optimizations for bulk operations (using silent client)
    await optimizeSQLiteForBulkOps(db);
    
    await ensureDataDirectory();
    
    // Check if CSV file already exists
    if (!fs.existsSync(CSV_FILE)) {
      await downloadIPData();
      await extractZipFile();
    } else {
      console.log('📁 Using existing CSV file');
    }
    
    const records = await parseCSVFile();
    await importIPRanges(records);
    await cleanup();
    await showStatistics();
    
    console.log('\n🎉 Real IP data import completed successfully!');
    console.log('💡 Your IP generator now uses real global IP ranges');
    
  } catch (error) {
    console.error('❌ Import failed:', error);
    
    if (error instanceof Error && error.message.includes('unzip')) {
      console.log('\n💡 Manual extraction required:');
      console.log(`1. Extract ${ZIP_FILE}`);
      console.log(`2. Ensure ${CSV_FILE} exists`);
      console.log('3. Run this script again');
    }
    
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main().catch(console.error); 