import { z } from 'zod';
import { env } from '../config/env';
import { AppError } from '../utils/app-error';

export interface RepositorySourceInspection {
  filesInspected: string[];
  apiRoutes: string[];
  databaseIndicators: string[];
  codeQuality: string[];
  potentialIssues: string[];
}

export interface GitHubAnalysis {
  owner: string;
  repository: string;
  url: string;
  metadata: Record<string, unknown>;
  languages: Record<string, number>;
  structure: string[];
  dependencies: string[];
  detectedTechnology: string[];
  assessment: string[];
  sourceInspection: RepositorySourceInspection;
  analyzedAt: string;
}

const repoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  html_url: z.string(),
  description: z.string().nullable(),
  homepage: z.string().nullable(),
  default_branch: z.string(),
  language: z.string().nullable(),
  topics: z.array(z.string()).default([]),
  license: z.object({ spdx_id: z.string().nullable() }).nullable(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  size: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  pushed_at: z.string(),
});

const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })).default([]),
});

const apiLanguagesSchema = z.record(z.string(), z.number());
const contentsSchema = z.object({ content: z.string().optional(), encoding: z.string().optional(), size: z.number().optional() });

export function parseGitHubUrl(rawUrl: string): { owner: string; repository: string } {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new AppError('Invalid GitHub repository URL', { statusCode: 400, code: 'BAD_REQUEST' }); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) {
    throw new AppError('Only public https://github.com/owner/repository URLs are supported', { statusCode: 400, code: 'BAD_REQUEST' });
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) throw new AppError('GitHub URL must identify one owner and repository', { statusCode: 400, code: 'BAD_REQUEST' });
  const repository = segments[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(segments[0]) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository === '.' || repository === '..') {
    throw new AppError('GitHub owner or repository name is invalid', { statusCode: 400, code: 'BAD_REQUEST' });
  }
  return { owner: segments[0], repository };
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

async function githubFetch(path: string): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Case-Study-Tool',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (response.status === 404) throw new AppError('GitHub repository was not found or is private', { statusCode: 404, code: 'NOT_FOUND' });
  if (response.status === 403) throw new AppError('GitHub API rate limit or access restriction reached', { statusCode: 429, code: 'RATE_LIMITED' });
  if (!response.ok) throw new AppError(`GitHub API returned HTTP ${response.status}`, { statusCode: 502, code: 'BAD_REQUEST' });
  return response;
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const current = nextIndex;
      nextIndex += 1;
      const value = values[current];
      if (value !== undefined) results[current] = await work(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function dependencyNames(path: string, content: string): string[] {
  if (path.endsWith('package.json') || path.endsWith('composer.json')) {
    try {
      const manifest = JSON.parse(content) as Record<string, unknown>;
      const keys = path.endsWith('package.json')
        ? ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        : ['require', 'require-dev'];
      return keys.flatMap((key) => {
        const dependencies = manifest[key];
        return typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies) ? Object.keys(dependencies) : [];
      });
    } catch {
      return [];
    }
  }

  if (path.endsWith('requirements.txt')) {
    return content.split(/\r?\n/).map((line) => /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?/.exec(line)?.[1]).filter((name): name is string => Boolean(name));
  }
  if (path.endsWith('go.mod')) return content.split(/\r?\n/).map((line) => /^\s*([A-Za-z0-9_.\-/]+)\s+v\d/.exec(line)?.[1]).filter((name): name is string => Boolean(name));
  if (path.endsWith('Gemfile')) return content.split(/\r?\n/).map((line) => /^\s*gem\s+['"]([^'"]+)['"]/.exec(line)?.[1]).filter((name): name is string => Boolean(name));
  if (path.endsWith('pom.xml')) return [...content.matchAll(/<artifactId>\s*([^<]+)\s*<\/artifactId>/g)].map((match) => match[1]?.trim()).filter((name): name is string => Boolean(name));
  if (path.endsWith('Cargo.toml') || path.endsWith('pyproject.toml') || path.endsWith('pubspec.yaml')) {
    return content.split(/\r?\n/).map((line) => /^\s{0,4}([A-Za-z][A-Za-z0-9_.-]*)\s*(?:=|:)/.exec(line)?.[1]).filter((name): name is string => Boolean(name));
  }
  return [];
}

function sourcePriority(path: string): number {
  let score = 0;
  if (/(^|\/)(routes?|routers?)(\/|$)|\.(routes?|router)\.[^.]+$/i.test(path)) score += 8;
  if (/(^|\/)(api|handlers?)(\/|\.)/i.test(path)) score += 7;
  if (/(^|\/)(controllers?)(\/|\.)/i.test(path)) score += 5;
  if (/(^|\/)(models?|entities|schema|migrations?)(\/|\.)/i.test(path)) score += 4;
  if (/(^|\/)(server|app|main|index)\.[^.]+$/i.test(path)) score += 3;
  if (/(^|\/)src\//i.test(path)) score += 2;
  if (/\.(min|bundle)\./i.test(path) || /(^|\/)(vendor|node_modules|dist|build)\//i.test(path)) score -= 100;
  return score;
}

function prioritizedSourcePaths(paths: string[]): string[] {
  return paths
    .filter((path) => /\.(?:[cm]?[jt]sx?|py|go|java|kt|rb|php|rs|cs|swift)$/i.test(path))
    .sort((left, right) => sourcePriority(right) - sourcePriority(left) || left.length - right.length)
    .slice(0, 8);
}

function inspectSource(path: string, content: string, inspection: RepositorySourceInspection, detectedTechnology: Set<string>): void {
  inspection.filesInspected.push(path);

  const routePattern = /\b(?:app|router)\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  for (const match of content.matchAll(routePattern)) inspection.apiRoutes.push(`${path}: ${match[1]?.toUpperCase()} ${match[2]}`);
  const chainedRoutePattern = /\b(?:app|router)\.route\(\s*['"`]([^'"`]+)['"`]\s*\)((?:\s*\.\s*(?:get|post|put|patch|delete)\s*\([^)]*\))*)/gi;
  for (const match of content.matchAll(chainedRoutePattern)) {
    for (const method of match[2]?.matchAll(/\.\s*(get|post|put|patch|delete)\s*\(/gi) ?? []) {
      inspection.apiRoutes.push(`${path}: ${method[1]?.toUpperCase()} ${match[1]}`);
    }
  }
  const decoratorPattern = /@(Get|Post|Put|Patch|Delete)\(\s*['"`]?([^'"`)\n]*)/g;
  for (const match of content.matchAll(decoratorPattern)) inspection.apiRoutes.push(`${path}: ${match[1]?.toUpperCase()} ${match[2]?.trim() || '/'}`);

  if (/\bexpress\b|from\s+['"]express['"]|require\s*\(\s*['"]express['"]\s*\)/i.test(content)) detectedTechnology.add('Express.js');
  if (/\bfastify\b|from\s+['"]fastify['"]|require\s*\(\s*['"]fastify['"]\s*\)/i.test(content)) detectedTechnology.add('Fastify');
  if (/\breact\b|from\s+['"]react['"]|require\s*\(\s*['"]react['"]\s*\)/i.test(content)) detectedTechnology.add('React');
  if (/\b(?:next\/server|next\/router)\b/i.test(content)) detectedTechnology.add('Next.js');
  if (/\b(?:flask|fastapi|django)\b/i.test(content)) detectedTechnology.add('Python web framework');
  if (/\b(?:postgres|mysql|sqlite|mongodb|mongoose|sequelize|typeorm|prisma|drizzle)\b/i.test(content)) detectedTechnology.add('Database or ORM references');
  if (/(prisma|sequelize|typeorm|mongoose|knex|drizzle|sqlalchemy|django\.db|gorm|entityframework|active record)/i.test(content)) {
    inspection.databaseIndicators.push(`${path}: database or ORM references detected`);
  }
  if (/\b(eval\s*\(|new Function\s*\(|dangerouslySetInnerHTML|innerHTML\s*=|shell\s*=\s*True|verify\s*=\s*False)/i.test(content)) {
    inspection.potentialIssues.push(`${path}: potentially risky dynamic execution, HTML injection, or transport setting; manual review required`);
  }
}

export async function analyzeGitHubRepository(rawUrl: string): Promise<GitHubAnalysis> {
  const { owner, repository } = parseGitHubUrl(rawUrl);
  const repoPath = `/repos/${segment(owner)}/${segment(repository)}`;
  const repoResponse = await githubFetch(repoPath);
  const repo = repoSchema.parse(await repoResponse.json());
  const encodedRef = encodeURIComponent(repo.default_branch);

  const [languagesResponse, treeResponse] = await Promise.all([
    githubFetch(`${repoPath}/languages`),
    githubFetch(`${repoPath}/git/trees/${encodedRef}?recursive=1`),
  ]);
  const languages = apiLanguagesSchema.parse(await languagesResponse.json());
  const treePayload = treeSchema.parse(await treeResponse.json());
  const files = treePayload.tree.filter((item) => item.type === 'blob').slice(0, 500);
  const paths = files.map((item) => item.path);

  const dependencyFiles = paths.filter((path) => /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|Gemfile|composer\.json|pubspec\.yaml)$/i.test(path)).slice(0, 12);
  const dependencyPaths = new Set(dependencyFiles);
  const inspectionPaths = prioritizedSourcePaths(paths).filter((path) => !dependencyPaths.has(path));
  const contentsToInspect = [...new Set([...dependencyFiles, ...inspectionPaths])];
  let totalSourceBytes = 0;
  const contentByPath = new Map<string, string>();

  await mapWithConcurrency(contentsToInspect, 4, async (path) => {
    try {
      const encodedPath = path.split('/').map(segment).join('/');
      const response = await githubFetch(`${repoPath}/contents/${encodedPath}?ref=${encodedRef}`);
      const payload = contentsSchema.parse(await response.json());
      if (!payload.content || payload.encoding !== 'base64' || (payload.size ?? 0) > 100_000) return;
      const content = Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8');
      const contentBytes = Buffer.byteLength(content, 'utf8');
      if (contentBytes > 100_000 || totalSourceBytes + contentBytes > 600_000) return;
      totalSourceBytes += contentBytes;
      contentByPath.set(path, content);
    } catch {
      // One inaccessible or unsupported file must not invalidate the repository summary.
    }
  });

  const dependencies = new Set<string>();
  const detectedTechnology = new Set<string>();
  const inspection: RepositorySourceInspection = { filesInspected: [], apiRoutes: [], databaseIndicators: [], codeQuality: [], potentialIssues: [] };

  for (const path of dependencyFiles) {
    const content = contentByPath.get(path);
    if (!content) continue;
    for (const name of dependencyNames(path.toLowerCase(), content)) dependencies.add(name);
  }
  for (const name of dependencies) {
    if (/^(react|react-dom)$/i.test(name)) detectedTechnology.add('React');
    if (/^next$/i.test(name)) detectedTechnology.add('Next.js');
    if (/^(vue|nuxt)$/i.test(name)) detectedTechnology.add(name.toLowerCase() === 'nuxt' ? 'Nuxt' : 'Vue');
    if (/^(express|fastify|@nestjs\/core|koa|hono)$/i.test(name)) detectedTechnology.add(`${name} API framework`);
    if (/^(prisma|@prisma\/client|typeorm|mongoose|sequelize|drizzle-orm)$/i.test(name)) detectedTechnology.add(`${name} ORM/database client`);
    if (/^(tailwindcss|bootstrap|styled-components)$/i.test(name)) detectedTechnology.add(`${name} CSS framework`);
  }
  for (const path of inspectionPaths) {
    const content = contentByPath.get(path);
    if (content) inspectSource(path, content, inspection, detectedTechnology);
  }

  const hasTests = paths.some((path) => /(^|\/)(test|tests|__tests__)(\/|\.)/i.test(path) || /\.(test|spec)\.[^.]+$/i.test(path));
  const hasReadme = paths.some((path) => /(^|\/)(readme\.md|readme\.txt)$/i.test(path));
  const hasCi = paths.some((path) => /^\.github\/workflows\//i.test(path) || /(^|\/)(\.travis\.yml|azure-pipelines\.yml|Jenkinsfile)$/i.test(path));
  inspection.codeQuality.push(hasTests ? 'Test files or directories were detected; this does not prove tests pass.' : 'No conventional test files were detected in the inspected tree.');
  inspection.codeQuality.push(hasCi ? 'Continuous integration configuration files were detected.' : 'No common CI configuration file was detected.');
  inspection.codeQuality.push(`Inspected ${inspection.filesInspected.length} source file(s), bounded to 8 files and 600 KB.`);

  const assessment: string[] = [];
  if (paths.length > 250) assessment.push('Repository has a large source tree; architecture should be reviewed in modules.');
  if (hasTests) assessment.push('Automated test files or directories were detected; their execution status is unknown.');
  else assessment.push('No conventional test directory or test file was detected in the inspected tree.');
  if (!hasReadme) assessment.push('No README file was detected.');
  if (dependencyFiles.length === 0) assessment.push('No common dependency manifest was found in the inspected tree.');
  if (treePayload.truncated) assessment.push('GitHub marked the recursive tree as truncated; structure and manifest coverage may be incomplete.');
  if (inspection.potentialIssues.length > 0) assessment.push('Potentially risky source patterns were detected and require manual review; they are not confirmed vulnerabilities.');

  return {
    owner,
    repository,
    url: repo.html_url,
    metadata: {
      description: repo.description,
      homepage: repo.homepage,
      defaultBranch: repo.default_branch,
      primaryLanguage: repo.language,
      topics: repo.topics,
      license: repo.license?.spdx_id ?? null,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      openIssues: repo.open_issues_count,
      sizeKb: repo.size,
      createdAt: repo.created_at,
      updatedAt: repo.updated_at,
      pushedAt: repo.pushed_at,
    },
    languages,
    structure: paths.slice(0, 250),
    dependencies: [...dependencies].slice(0, 100),
    detectedTechnology: [...detectedTechnology],
    assessment,
    sourceInspection: {
      filesInspected: inspection.filesInspected,
      apiRoutes: [...new Set(inspection.apiRoutes)].slice(0, 50),
      databaseIndicators: [...new Set(inspection.databaseIndicators)].slice(0, 30),
      codeQuality: inspection.codeQuality,
      potentialIssues: [...new Set(inspection.potentialIssues)].slice(0, 30),
    },
    analyzedAt: new Date().toISOString(),
  };
}
