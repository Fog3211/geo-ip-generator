import { z } from 'zod';
import { db } from '~/server/db';
import { generateRandomIpInRange } from '~/lib/utils/ip-utils';
import { 
  withCache, 
  getCountryCacheKey, 
  getGenerationCacheKey 
} from '~/lib/cache';
import { CACHE_KEYS, CACHE_TTL } from '~/config';

// Input validation schemas
export const generateIpSchema = z.object({
  country: z.string()
    .min(1, 'Country parameter is required')
    .max(100, 'Country parameter too long'),
  count: z.coerce.number()
    .min(1, 'Count must be at least 1')
    .max(10, 'Count cannot exceed 10')
    .int('Count must be an integer')
    .default(1),
});

// Service functions
export async function generateIpByCountry(input: z.infer<typeof generateIpSchema>) {
  const { country: query, count } = input;
  
  // Use cache for the entire operation
  return await withCache(
    {
      prefix: CACHE_KEYS.GENERATED,
      identifier: getGenerationCacheKey(query, count)
    },
    CACHE_TTL.GENERATED,
    async () => {
      // First find country information with caching
      const country = await withCache(
        {
          prefix: CACHE_KEYS.COUNTRY,
          identifier: getCountryCacheKey(query)
        },
        CACHE_TTL.COUNTRY,
        async () => {
          // Try exact matches first, then partial matches
          let country = await db.country.findFirst({
            where: {
              OR: [
                { id: query.toUpperCase() }, // 3-letter country code match (e.g., CHN, USA, JPN)
                { code2: query.toUpperCase() }, // 2-letter country code match (e.g., CN, US, JP)
                { nameEn: query }, // English name exact match
                { nameZh: query }, // Chinese name exact match
              ],
            },
            select: {
              id: true,
              code2: true,
              nameEn: true,
              nameZh: true,
              continent: true,
              region: true,
            },
          });

          // If no exact match found, try partial matches
          if (!country) {
            country = await db.country.findFirst({
              where: {
                OR: [
                  { nameEn: { contains: query } }, // English name fuzzy match
                  { nameZh: { contains: query } }, // Chinese name fuzzy match
                ],
              },
              select: {
                id: true,
                code2: true,
                nameEn: true,
                nameZh: true,
                continent: true,
                region: true,
              },
              // Order by name length to prefer shorter, more specific matches
              orderBy: [
                { nameZh: 'asc' },
                { nameEn: 'asc' }
              ]
            });
          }

          return country;
        }
      );

      if (!country) {
        throw new Error(`Country/region not found: ${query}. Please use 3-letter country codes (e.g., CHN, USA, JPN) or country names.`);
      }

      // Count total IP ranges for the country to enable unbiased random sampling
      const totalRangesCount = await db.ipRange.count({
        where: { countryId: country.id },
      });

      if (totalRangesCount === 0) {
        throw new Error(`No IP range data available for country/region: ${query}. Please import real IP data first.`);
      }

      // Generate specified number of random IPs using unbiased random offset sampling
      const generatedIps: Array<{
        ip: string;
        location: {
          region: string | null;
          city: string | null;
          isp: string | null;
        };
        ipRange: {
          startIp: string;
          endIp: string;
        };
      }> = [];

      for (let i = 0; i < count; i++) {
        // Random offset in [0, totalRangesCount)
        const offset = Math.floor(Math.random() * totalRangesCount);

        // Fetch exactly one range at the random offset with deterministic ordering
        const rows = await db.ipRange.findMany({
          where: { countryId: country.id },
          select: {
            startIp: true,
            endIp: true,
            region: { select: { name: true } },
            city: { select: { name: true } },
            isp: true,
          },
          orderBy: { id: 'asc' },
          skip: offset,
          take: 1,
        });

        const chosen = rows[0] ?? (await db.ipRange.findMany({
          where: { countryId: country.id },
          select: {
            startIp: true,
            endIp: true,
            region: { select: { name: true } },
            city: { select: { name: true } },
            isp: true,
          },
          orderBy: { id: 'asc' },
          skip: Math.max(0, totalRangesCount - 1),
          take: 1,
        }))[0];

        if (!chosen) {
          // Extremely unlikely; safeguard against race conditions
          throw new Error('Failed to fetch a random IP range. Please retry.');
        }

        const randomIp = generateRandomIpInRange(chosen.startIp, chosen.endIp);

        generatedIps.push({
          ip: randomIp,
          location: {
            region: chosen.region?.name ?? null,
            city: chosen.city?.name ?? null,
            isp: chosen.isp ?? null,
          },
          ipRange: {
            startIp: chosen.startIp,
            endIp: chosen.endIp,
          },
        });
      }

      return {
        country: {
          id: country.id, // 3-letter code (CHN, USA, JPN)
          code2: country.code2, // 2-letter code (CN, US, JP)
          nameEn: country.nameEn,
          nameZh: country.nameZh,
          continent: country.continent,
          region: country.region,
        },
        ips: generatedIps,
        totalRanges: totalRangesCount,
        cached: false, // This will be true when served from cache
      };
    }
  );
}

export async function getCountries() {
  return await withCache(
    {
      prefix: CACHE_KEYS.COUNTRY_LIST,
      identifier: 'all'
    },
    CACHE_TTL.COUNTRY_LIST,
    async () => {
      return await db.country.findMany({
        select: {
          id: true,
          code2: true,
          nameEn: true,
          nameZh: true,
          continent: true,
          region: true,
          _count: {
            select: {
              ipRanges: true,
            },
          },
        },
        orderBy: {
          nameEn: 'asc',
        },
      });
    }
  );
}

 