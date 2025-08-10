import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '~/lib/middleware/rate-limit-middleware';
import { generateIpv6ByCountry, generateIpv6Schema } from '~/lib/services/ip-service-json-v6';

/**
 * Generate random IPv6 addresses by country/region (GET only)
 * Query: country=CN|CHN|China|中国, count=1..10
 */
async function handleGenerateIPv6(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const parsed = generateIpv6Schema.safeParse({
      country: searchParams.get('country'),
      count: searchParams.get('count'),
    });
    if (!parsed.success) {
      return NextResponse.json({
        error: 'Invalid parameters',
        message: 'Please check your country and count parameters',
        details: parsed.error.issues.map(i => ({ field: i.path[0], message: i.message })),
      }, { status: 400 });
    }
    const data = await generateIpv6ByCountry(parsed.data);
    return NextResponse.json({ success: true, data, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Generate IPv6 API error:', error);
    return NextResponse.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}

export const GET = withRateLimit(handleGenerateIPv6, 'generate-ipv6');


