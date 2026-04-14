import { NextResponse } from 'next/server';
import { cache } from '~/lib/cache';

export async function GET() {
  try {
    const meta = await cache.get<{ lastUpdated?: string; version?: string }>('geo-ip-data', 'meta');

    return NextResponse.json({
      success: true,
      data: {
        meta: meta ?? null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
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