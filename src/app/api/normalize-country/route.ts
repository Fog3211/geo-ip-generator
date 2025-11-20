import { NextRequest, NextResponse } from 'next/server';
import { normalizeCountryInput } from '~/lib/services/ai-country-matcher';
import { withRateLimit } from '~/lib/middleware/rate-limit-middleware';

/**
 * Normalize country input using AI + fuzzy matching
 * 
 * Query parameters:
 * - q: Country name or code (required)
 * 
 * Examples:
 * GET /api/normalize-country?q=日本
 * GET /api/normalize-country?q=United States
 * GET /api/normalize-country?q=Deutschland
 */
async function handleNormalizeCountry(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');

    if (!query || !query.trim()) {
      return NextResponse.json(
        {
          error: 'Invalid parameters',
          message: 'Query parameter "q" is required',
        },
        { status: 400 }
      );
    }

    const result = await normalizeCountryInput(query.trim());

    if (!result) {
      return NextResponse.json(
        {
          success: false,
          message: `Could not find country/region matching: ${query}`,
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Normalize country API error:', error);

    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

// Export the rate-limited handler
export const GET = withRateLimit(handleNormalizeCountry, 'normalize-country');

