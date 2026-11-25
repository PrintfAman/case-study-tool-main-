import { z } from 'zod';
import { env } from '../config/env';

export interface CompetitorSearchResult {
  title: string;
  url: string;
  content: string;
  score: number | null;
  publishedDate: string | null;
}

export interface CompetitorResearch {
  status: 'available' | 'not_configured' | 'unavailable';
  query: string;
  results: CompetitorSearchResult[];
  warning?: string;
}

const tavilyResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string().default('Untitled result'),
    url: z.string(),
    content: z.string().default(''),
    score: z.number().optional(),
    published_date: z.string().nullable().optional(),
  })).default([]),
});

function compact(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function queryTopic(website: unknown): string {
  if (!website || typeof website !== 'object' || Array.isArray(website)) return '';
  const pages = (website as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return '';
  for (const value of pages) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const page = value as { title?: unknown; description?: unknown; headings?: unknown };
    const fields = [page.title, page.description, ...(Array.isArray(page.headings) ? page.headings.slice(0, 2) : [])];
    const topic = compact(fields.filter((field): field is string => typeof field === 'string').join(' '), 180);
    if (topic) return topic;
  }
  return '';
}

function safeResultUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`Tavily response exceeded the ${limit} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Uses Tavily only when configured; provider failures become explicit warnings. */
export async function researchCompetitors(projectName: string, website: unknown, excludedUrls: Array<string | null> = []): Promise<CompetitorResearch> {
  const topic = queryTopic(website);
  const query = compact(`companies and products similar to ${projectName}${topic ? ` (${topic})` : ''} alternatives`, 500);
  if (!env.TAVILY_API_KEY) {
    return { status: 'not_configured', query, results: [], warning: 'Tavily competitor research is not configured.' };
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${env.TAVILY_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: 5,
        topic: 'general',
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    });
    if (!response.ok) {
      return { status: 'unavailable', query, results: [], warning: `Tavily returned HTTP ${response.status}.` };
    }

    const raw = await readBoundedText(response, 1_000_000);
    const payload = tavilyResponseSchema.parse(JSON.parse(raw));
    const excludedHosts = new Set(excludedUrls.flatMap((value) => {
      if (!value) return [];
      try { return [new URL(value).hostname.toLowerCase()]; } catch { return []; }
    }));
    const results = payload.results.flatMap((item) => {
      const url = safeResultUrl(item.url);
      if (!url || excludedHosts.has(new URL(url).hostname.toLowerCase())) return [];
      return [{
        title: compact(item.title, 240),
        url,
        content: compact(item.content, 1_200),
        score: item.score ?? null,
        publishedDate: item.published_date ?? null,
      }];
    }).slice(0, 5);

    return {
      status: 'available',
      query,
      results,
      ...(results.length === 0 ? { warning: 'Tavily returned no usable competitor search results.' } : {}),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      query,
      results: [],
      warning: `Tavily competitor research failed${error instanceof Error ? `: ${error.message}` : ''}.`,
    };
  }
}
