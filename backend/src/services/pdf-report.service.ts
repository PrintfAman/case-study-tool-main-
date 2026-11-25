import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { env } from '../config/env';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 54;
const BOTTOM = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const sectionDefinitions: Array<{ key: string; title: string }> = [
  { key: 'executiveSummary', title: 'Executive Summary' },
  { key: 'projectOverview', title: 'Project Overview' },
  { key: 'businessBackground', title: 'Business Background' },
  { key: 'problemStatement', title: 'Problem Statement' },
  { key: 'objectives', title: 'Objectives' },
  { key: 'websiteAnalysis', title: 'Website Analysis' },
  { key: 'technicalArchitecture', title: 'Technical Architecture' },
  { key: 'technologyStack', title: 'Technology Stack' },
  { key: 'repositoryAnalysis', title: 'Repository Analysis' },
  { key: 'businessModel', title: 'Business Model' },
  { key: 'targetAudience', title: 'Target Audience' },
  { key: 'marketAnalysis', title: 'Market Analysis' },
  { key: 'competitorAnalysis', title: 'Competitor Analysis' },
  { key: 'competitorComparison', title: 'Competitor Comparison' },
  { key: 'businessScope', title: 'Business Scope' },
  { key: 'marketOpportunities', title: 'Market Opportunities' },
  { key: 'revenueModel', title: 'Revenue Model' },
  { key: 'profitabilityAnalysis', title: 'Profitability Analysis' },
  { key: 'risksAndLimitations', title: 'Risks and Limitations' },
  { key: 'swotAnalysis', title: 'SWOT Analysis' },
  { key: 'recommendations', title: 'Recommendations' },
  { key: 'growthStrategy', title: 'Growth Strategy' },
  { key: 'implementationRoadmap', title: 'Implementation Roadmap' },
  { key: 'conclusion', title: 'Conclusion' },
];

function safeText(value: string, font: PDFFont): string {
  let result = '';
  for (const character of value) {
    try {
      font.encodeText(character);
      result += character;
    } catch {
      result += '?';
    }
  }
  return result;
}

function titleCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function compactValue(value: unknown, font: PDFFont, depth = 0): string {
  if (typeof value === 'string') return safeText(value.replace(/\s+/g, ' ').slice(0, 600), font);
  if (value == null) return 'Not available';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth >= 5) return 'Further nested details omitted.';
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactValue(item, font, depth + 1)).join('; ').slice(0, 600);
  }
  return Object.entries(value as Record<string, unknown>).slice(0, 10)
    .map(([key, child]) => `${titleCase(key)}: ${compactValue(child, font, depth + 1)}`)
    .join('; ').slice(0, 600);
}

function wrapLines(value: string, font: PDFFont, size: number, width: number): string[] {
  const output: string[] = [];
  const paragraphs = value.slice(0, 30_000).split(/\r?\n/);
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      output.push('');
      continue;
    }

    let line = '';
    for (const rawWord of words) {
      const word = safeText(rawWord, font);
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }

      if (line) output.push(line);
      line = '';
      let fragment = '';
      for (const character of word) {
        if (fragment && font.widthOfTextAtSize(`${fragment}${character}`, size) > width) {
          output.push(fragment);
          fragment = character;
        } else {
          fragment += character;
        }
      }
      line = fragment;
    }
    if (line) output.push(line);
  }
  return output;
}

export async function createPdfReport(projectId: string, projectName: string, content: Record<string, unknown>): Promise<{ path: string; fileName: string }> {
  const outputDir = resolve(env.REPORT_STORAGE_DIR);
  mkdirSync(outputDir, { recursive: true });
  const slug = projectName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'case-study';
  const fileName = `${projectId}-${slug}-${randomUUID()}.pdf`;
  const path = join(outputDir, fileName);

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const gray = rgb(0.36, 0.39, 0.42);
  const ink = rgb(0.08, 0.11, 0.15);
  const accent = rgb(0.08, 0.36, 0.34);
  const border = rgb(0.82, 0.85, 0.87);
  const sectionPages = new Map<string, PDFPage>();
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = 700;

  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = 790;
  };
  const ensureSpace = (height: number) => {
    if (y - height < BOTTOM) newPage();
  };
  const drawRule = (atY: number, color = border) => {
    page.drawLine({ start: { x: MARGIN, y: atY }, end: { x: PAGE_WIDTH - MARGIN, y: atY }, thickness: 0.7, color });
  };
  const drawWrapped = (value: string, options: { size?: number; face?: PDFFont; indent?: number; lineHeight?: number; color?: ReturnType<typeof rgb> } = {}) => {
    const size = options.size ?? 10;
    const face = options.face ?? font;
    const indent = options.indent ?? 0;
    const lineHeight = options.lineHeight ?? 14;
    const lines = wrapLines(value, face, size, CONTENT_WIDTH - indent);
    for (const line of lines) {
      ensureSpace(lineHeight);
      if (line) page.drawText(line, { x: MARGIN + indent, y, size, font: face, color: options.color ?? ink });
      y -= lineHeight;
    }
  };

  // Cover page.
  page.drawText('CASE STUDY TOOL', { x: MARGIN, y: 772, size: 9, font: bold, color: accent });
  page.drawText('PROJECT ANALYSIS REPORT', { x: MARGIN, y: 746, size: 10, font, color: gray });
  y = 670;
  drawWrapped(projectName, { size: 26, face: bold, lineHeight: 32 });
  y -= 18;
  drawWrapped('Evidence-based case study', { size: 15, lineHeight: 22, color: gray });
  y -= 32;
  drawRule(y, accent);
  y -= 30;
  drawWrapped(`Generated ${new Date().toISOString().slice(0, 10)}`, { size: 10, color: gray });
  drawWrapped('Prepared from collected website and repository sources. Unknowns are labeled where the supplied evidence is insufficient.', { size: 10, color: gray, lineHeight: 16 });
  y = 96;
  drawWrapped('Case Study Tool', { size: 9, color: gray });

  const drawTable = (values: unknown[], indent: number) => {
    const rows = values.map((value) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null).filter((value): value is Record<string, unknown> => value !== null);
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 4);
    if (rows.length === 0 || columns.length === 0) {
      drawWrapped('No comparison data was collected.', { size: 9, indent, color: gray });
      return;
    }

    const tableX = MARGIN + indent;
    const tableWidth = CONTENT_WIDTH - indent;
    const columnWidth = tableWidth / columns.length;
    const headerHeight = 24;
    const drawHeader = () => {
      page.drawRectangle({ x: tableX, y: y - headerHeight + 4, width: tableWidth, height: headerHeight, color: rgb(0.91, 0.95, 0.94) });
      columns.forEach((column, index) => page.drawText(safeText(titleCase(column), bold), {
        x: tableX + index * columnWidth + 5,
        y: y - 12,
        size: 8,
        font: bold,
        color: ink,
        maxWidth: columnWidth - 10,
      }));
      y -= headerHeight;
    };

    ensureSpace(headerHeight + 30);
    drawHeader();
    for (const row of rows.slice(0, 25)) {
      const cells = columns.map((column) => wrapLines(compactValue(row[column], font), font, 8, columnWidth - 10).slice(0, 10));
      const rowHeight = Math.max(24, Math.max(...cells.map((lines) => lines.length)) * 10 + 10);
      if (y - rowHeight < BOTTOM) {
        newPage();
        drawHeader();
      }
      page.drawRectangle({ x: tableX, y: y - rowHeight + 4, width: tableWidth, height: rowHeight, borderColor: border, borderWidth: 0.5 });
      columns.forEach((_column, columnIndex) => {
        const x = tableX + columnIndex * columnWidth;
        if (columnIndex > 0) page.drawLine({ start: { x, y: y + 4 }, end: { x, y: y - rowHeight + 4 }, thickness: 0.5, color: border });
        cells[columnIndex]?.forEach((line, lineIndex) => page.drawText(line, {
          x: x + 5,
          y: y - 10 - lineIndex * 10,
          size: 8,
          font,
          color: ink,
          maxWidth: columnWidth - 10,
        }));
      });
      y -= rowHeight;
    }
    y -= 5;
  };

  const drawValue = (value: unknown, depth = 0, indent = 0): void => {
    if (typeof value === 'string') {
      drawWrapped(value || 'Not available');
      return;
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') {
      drawWrapped(value == null ? 'Not available' : String(value));
      return;
    }
    if (depth >= 5) {
      drawWrapped(compactValue(value, font, depth), { indent });
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        drawWrapped('No data collected.', { indent, color: gray });
        return;
      }
      if (value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
        drawTable(value, indent);
        return;
      }
      for (const item of value.slice(0, 40)) {
        if (item && typeof item === 'object') {
          drawValue(item, depth + 1, indent + 10);
        } else {
          drawWrapped(`- ${compactValue(item, font)}`, { indent });
        }
      }
      return;
    }

    const entries = Object.entries(value as Record<string, unknown>).slice(0, 30);
    if (entries.length === 0) {
      drawWrapped('No data collected.', { indent, color: gray });
      return;
    }
    for (const [key, child] of entries) {
      ensureSpace(28);
      page.drawText(safeText(titleCase(key), bold), { x: MARGIN + indent, y, size: 9, font: bold, color: accent });
      y -= 14;
      drawValue(child, depth + 1, indent + 10);
      y -= 3;
    }
  };

  for (const section of sectionDefinitions) {
    ensureSpace(52);
    sectionPages.set(section.title, page);
    page.drawText(safeText(section.title, bold), { x: MARGIN, y, size: 15, font: bold, color: ink });
    y -= 10;
    drawRule(y, accent);
    y -= 20;
    drawValue(content[section.key]);
    y -= 20;
  }

  // Insert the contents page after pagination is known, so every entry points
  // to the actual page holding that section's first heading.
  const contentsPage = pdf.insertPage(1, [PAGE_WIDTH, PAGE_HEIGHT]);
  page = contentsPage;
  y = 790;
  page.drawText('Table of Contents', { x: MARGIN, y, size: 20, font: bold, color: ink });
  y -= 12;
  drawRule(y, accent);
  y -= 28;
  const insertedPages = pdf.getPages();
  for (const section of sectionDefinitions) {
    const title = safeText(section.title, font);
    const targetPage = sectionPages.get(section.title);
    const pageNumber = targetPage ? insertedPages.indexOf(targetPage) + 1 : 1;
    const pageLabel = String(pageNumber);
    const titleWidth = font.widthOfTextAtSize(title, 9);
    const pageWidth = font.widthOfTextAtSize(pageLabel, 9);
    const dotCount = Math.max(2, Math.floor((CONTENT_WIDTH - titleWidth - pageWidth - 18) / 3));
    page.drawText(title, { x: MARGIN, y, size: 9, font, color: ink });
    page.drawText('.'.repeat(dotCount), { x: MARGIN + titleWidth + 8, y, size: 9, font, color: gray });
    page.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN - pageWidth, y, size: 9, font: bold, color: ink });
    y -= 24;
  }

  const pages = pdf.getPages();
  pages.forEach((currentPage, index) => {
    if (index > 0) {
      currentPage.drawText(safeText(projectName, font), { x: MARGIN, y: 816, size: 8, font, color: gray, maxWidth: CONTENT_WIDTH });
      currentPage.drawLine({ start: { x: MARGIN, y: 808 }, end: { x: PAGE_WIDTH - MARGIN, y: 808 }, thickness: 0.5, color: border });
    }
    currentPage.drawLine({ start: { x: MARGIN, y: 42 }, end: { x: PAGE_WIDTH - MARGIN, y: 42 }, thickness: 0.5, color: border });
    currentPage.drawText('Case Study Tool', { x: MARGIN, y: 26, size: 8, font, color: gray });
    const pageLabel = `Page ${index + 1} of ${pages.length}`;
    const pageLabelWidth = font.widthOfTextAtSize(pageLabel, 8);
    currentPage.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN - pageLabelWidth, y: 26, size: 8, font, color: gray });
  });

  writeFileSync(path, await pdf.save());
  return { path, fileName };
}
