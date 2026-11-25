import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import * as cheerio from 'cheerio';
import { AppError } from '../utils/app-error';
import { assertPublicUrl, resolvePublicUrl, type PublicUrlResolution } from './network-safety.service';

const MAX_PAGES = 10;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const CRAWLER_AGENT = 'CaseStudyTool';

export interface CrawledPage {
  url: string;
  title: string;
  description: string;
  metadata: {
    canonicalUrl: string | null;
    language: string | null;
    siteName: string | null;
    imageUrl: string | null;
    keywords: string[];
    publishedAt: string | null;
  };
  headings: string[];
  text: string;
  links: string[];
}

export interface CrawlResult {
  rootUrl: string;
  pages: CrawledPage[];
  crawledAt: string;
  warnings: string[];
}

export interface RobotsRule {
  directive: 'allow' | 'disallow';
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

/** Selects the most specific matching robots group and combines equal groups. */
export function parseRobotsTxt(contents: string, userAgent = CRAWLER_AGENT): RobotsRule[] {
  const groups: RobotsGroup[] = [];
  let agents: string[] = [];
  let rules: RobotsRule[] = [];

  const saveGroup = () => {
    if (agents.length > 0) groups.push({ agents, rules });
    agents = [];
    rules = [];
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;

    const agentMatch = /^user-agent\s*:\s*(.+)$/i.exec(line);
    if (agentMatch) {
      // Multiple user-agent lines before the first rule are one shared group.
      if (rules.length > 0) saveGroup();
      agents.push(agentMatch[1].trim().toLowerCase());
      continue;
    }

    const ruleMatch = /^(allow|disallow)\s*:\s*(.*)$/i.exec(line);
    if (ruleMatch && agents.length > 0) {
      const path = ruleMatch[2].trim();
      if (path) rules.push({ directive: ruleMatch[1].toLowerCase() as RobotsRule['directive'], path });
    }
  }
  saveGroup();

  const token = userAgent.toLowerCase();
  const score = (group: RobotsGroup) => Math.max(...group.agents.map((agent) => {
    if (agent === '*') return 0;
    return token.includes(agent) ? agent.length : -1;
  }));
  const bestScore = Math.max(-1, ...groups.map(score));
  if (bestScore < 0) return [];
  return groups.filter((group) => score(group) === bestScore).flatMap((group) => group.rules);
}

function robotsPatternMatches(pattern: string, value: string): boolean {
  const anchoredAtEnd = pattern.endsWith('$');
  const source = anchoredAtEnd ? pattern.slice(0, -1) : pattern;
  const escaped = source.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchoredAtEnd ? '$' : ''}`).test(value);
}

/** Longest matching rule wins; Allow wins ties as required by robots guidance. */
export function isAllowedByRobots(url: URL, rules: RobotsRule[]): boolean {
  const target = `${url.pathname}${url.search}`;
  const matches = rules.filter((rule) => robotsPatternMatches(rule.path, target));
  if (matches.length === 0) return true;
  const longest = Math.max(...matches.map((rule) => rule.path.replace(/[*$]/g, '').length));
  return matches
    .filter((rule) => rule.path.replace(/[*$]/g, '').length === longest)
    .some((rule) => rule.directive === 'allow');
}

interface SafeResponse {
  response: Response;
  url: URL;
}

function responseHeaders(headers: import('node:http').IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result.set(name, value.join(', '));
    else if (typeof value === 'string') result.set(name, value);
  }
  return result;
}

function requestPinned(url: URL, resolution: PublicUrlResolution, maxBytes: number, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'CaseStudyTool/1.0 (+educational analysis)',
        'Accept-Encoding': 'identity',
      },
      lookup: (_hostname, options, callback) => {
        const address = { address: resolution.address, family: resolution.family };
        if (typeof options === 'object' && options !== null && options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (incoming) => {
      const status = incoming.statusCode ?? 502;
      const headers = responseHeaders(incoming.headers);
      if (status >= 300 && status < 400) {
        incoming.destroy();
        resolve(new Response(null, { status, headers }));
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      incoming.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.byteLength;
        if (received > maxBytes) {
          incoming.destroy(new Error(`Response exceeded the ${maxBytes} byte limit`));
          return;
        }
        chunks.push(bytes);
      });
      incoming.on('end', () => {
        const body = status === 204 || status === 205 ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status, headers }));
      });
      incoming.on('error', reject);
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
    request.once('error', reject);
    request.end();
  });
}

async function fetchSafely(input: URL, maxBytes: number, redirectLimit = 4): Promise<SafeResponse> {
  let current = input;
  const expectedHostname = input.hostname.toLowerCase();
  for (let redirect = 0; redirect <= redirectLimit; redirect += 1) {
    const resolution = await resolvePublicUrl(current.toString());
    const response = await requestPinned(current, resolution, maxBytes, 12_000);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Website returned a redirect without a location');
      if (redirect === redirectLimit) throw new Error('Too many redirects');
      current = new URL(location, current);
      if (current.hostname.toLowerCase() !== expectedHostname) throw new Error('Cross-host redirect was not followed to preserve robots and origin restrictions');
      continue;
    }
    return { response, url: current };
  }
  throw new Error('Too many redirects');
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeded the ${maxBytes} byte limit`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded the ${maxBytes} byte limit`);
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

function result(rootUrl: string, pages: CrawledPage[], warnings: string[]): CrawlResult {
  return { rootUrl, pages, crawledAt: new Date().toISOString(), warnings: warnings.slice(0, 100) };
}

export async function crawlWebsite(rawUrl: string, requestedMaxPages = 6): Promise<CrawlResult> {
  let root: URL;
  try {
    root = await assertPublicUrl(rawUrl);
    root.hash = '';
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : 'Invalid website URL', {
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  }

  const maxPages = Math.min(MAX_PAGES, Math.max(1, Math.floor(requestedMaxPages) || 1));
  const warnings: string[] = [];
  const queue: URL[] = [root];
  const queued = new Set([root.href]);
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  let robotsRules: RobotsRule[] = [];
  let crawlOrigin = root.origin;

  try {
    const robotsUrl = new URL('/robots.txt', root);
    const { response: robotsResponse, url: robotsFinalUrl } = await fetchSafely(robotsUrl, MAX_ROBOTS_BYTES);
    crawlOrigin = robotsFinalUrl.origin;
    if (robotsResponse.status === 200) {
      const robotsText = await readBoundedText(robotsResponse, MAX_ROBOTS_BYTES);
      robotsRules = parseRobotsTxt(robotsText);
      if (!isAllowedByRobots(root, robotsRules)) {
        throw new AppError('The website disallows crawling this page through robots.txt', {
          statusCode: 403,
          code: 'FORBIDDEN',
        });
      }
    } else if (robotsResponse.status !== 404) {
      await robotsResponse.body?.cancel();
      warnings.push(`robots.txt returned HTTP ${robotsResponse.status}; crawling was stopped`);
      return result(root.href, pages, warnings);
    } else {
      await robotsResponse.body?.cancel();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    warnings.push(`robots.txt could not be verified; crawling was stopped (${error instanceof Error ? error.message : 'unknown error'})`);
    return result(root.href, pages, warnings);
  }

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift();
    if (!url || visited.has(url.href)) continue;
    visited.add(url.href);

    if (!isAllowedByRobots(url, robotsRules)) {
      warnings.push(`Skipped ${url.href}: disallowed by robots.txt`);
      continue;
    }

    try {
      const { response, url: pageUrl } = await fetchSafely(url, MAX_HTML_BYTES);
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !contentType.toLowerCase().includes('text/html')) {
        await response.body?.cancel();
        warnings.push(`Skipped ${url.href}: HTTP ${response.status} or unsupported content type`);
        continue;
      }

      const html = await readBoundedText(response, MAX_HTML_BYTES);
      const $ = cheerio.load(html);
      $('script, style, noscript, svg, nav, footer').remove();

      const title = $('title').first().text().trim() || $('h1').first().text().trim();
      const description = $('meta[name="description"]').attr('content')?.trim() ?? '';
      const canonicalHref = $('link[rel="canonical"]').attr('href');
      const imageHref = $('meta[property="og:image"]').attr('content');
      let canonicalUrl: string | null = null;
      let imageUrl: string | null = null;
      try { canonicalUrl = canonicalHref ? new URL(canonicalHref, pageUrl).toString() : null; } catch { canonicalUrl = null; }
      try { imageUrl = imageHref ? new URL(imageHref, pageUrl).toString() : null; } catch { imageUrl = null; }
      const metadata = {
        canonicalUrl,
        language: $('html').attr('lang')?.trim() || null,
        siteName: $('meta[property="og:site_name"]').attr('content')?.trim() || null,
        imageUrl,
        keywords: ($('meta[name="keywords"]').attr('content') ?? '').split(',').map((keyword) => keyword.trim()).filter(Boolean).slice(0, 20),
        publishedAt: $('meta[property="article:published_time"]').attr('content')?.trim() || $('meta[name="datePublished"]').attr('content')?.trim() || null,
      };
      const headings = $('h1, h2, h3').map((_index, element) => $(element).text().trim()).get().filter(Boolean).slice(0, 30);
      const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20_000);
      const links: string[] = [];

      $('a[href]').each((_index, element) => {
        const href = $(element).attr('href');
        if (!href) return;
        try {
          const link = new URL(href, pageUrl);
          link.hash = '';
          if (link.origin !== crawlOrigin || visited.has(link.href) || queued.has(link.href)) return;
          links.push(link.href);
          if (queue.length + pages.length < maxPages) {
            queue.push(link);
            queued.add(link.href);
          }
        } catch {
          // Ignore malformed or unsupported links.
        }
      });

      pages.push({ url: pageUrl.href, title, description, metadata, headings, text, links: [...new Set(links)].slice(0, 50) });
    } catch (error) {
      warnings.push(`Could not crawl ${url.href}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  return result(root.href, pages, warnings);
}
