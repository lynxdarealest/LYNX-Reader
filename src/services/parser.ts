import JSZip from 'jszip';
import { ChapterSplitRule, BookFormat } from '../types';

export const DEFAULT_CHAPTER_RULES: ChapterSplitRule[] = [
  {
    id: 'vietnamese-standard',
    name: 'Tiêu chuẩn Tiếng Việt (Chương, Hồi, Quyển, Phần)',
    pattern:
      '(?:^|\\n)[ \\t]*(?:Hồi|Chương|Quyển|Tiết|Mục|Bài|Phần|Tập)[ \\t]+(?:thứ[ \\t]+)?(?:[0-9IVXLCDM]+|[一二三四五六七八九十百千万]+)[ \\t]*[:：.\\-–—]?[ \\t]*([^\\n]{0,120})',
    flags: 'im',
    example: 'Chương 1: Khởi đầu mới | Hồi thứ 12: Đại náo',
  },
  {
    id: 'chinese-qt',
    name: 'Truyện chữ / Trung / Nhật (第X章, 話, Chương)',
    pattern:
      '(?:^|\\n)[ \\t]*(?:第[ \\t]*[0-9０-９一二三四五六七八九十百千万零〇两]+[ \\t]*[章回节卷话話篇集部]|Chương[ \\t]+[0-9]+|Hồi[ \\t]+[0-9]+|Đệ[ \\t]+[0-9]+[ \\t]*chương)[ \\t]*[:：.\\-–—]?[ \\t]*([^\\n]{0,120})',
    flags: 'im',
    example: 'Chương 123: Đột phá Trúc Cơ | 第5章 逆天改命 | 第1話',
  },
  {
    id: 'english-format',
    name: 'Tiếng Anh (Chapter, Book, Part, Prologue)',
    pattern:
      '(?:^|\\n)[ \\t]*(?:(?:Chapter|Book|Part|Act|Volume|Episode)[ \\t]+(?:[0-9IVXLCDM]+|[0-9]+)|(?:Prologue|Epilogue)(?:[ \\t]*[:：.\\-–—][ \\t]*[^\\n]{0,100})?(?=\\s*(?:\\n|$)))[ \\t]*[:：.\\-–—]?[ \\t]*([^\\n]{0,120})',
    flags: 'im',
    example: 'Chapter 1: The Beginning | Part II: The Journey',
  },
  {
    id: 'markdown-heading',
    name: 'Tiêu đề Markdown (#, ##, ###)',
    pattern: '(?:^|\\n)[ \\t]*#{1,3}[ \\t]+([^\\n]{1,120})',
    flags: 'im',
    example: '# Chương 1: Khởi đầu | ## Phần 2',
  },
  {
    id: 'numeric-prefix',
    name: 'Số thứ tự đầu dòng (1. 2. 3...)',
    pattern: '(?:^|\\n)[ \\t]*([0-9]{1,4})[ \\t]*(?:[.、][ \\t]*|-[ \\t]+)([^\\n]{1,100})',
    flags: 'im',
    example: '1. Mở màn | 2. Gặp gỡ bất ngờ',
  },
];

export interface ParsedChapterDraft {
  title: string;
  wordCount: number;
  content: string;
}

export interface ParsedBookDraft {
  title: string;
  author: string;
  description: string;
  coverUrl?: string;
  format: BookFormat;
  sourceFileName: string;
  fileSize: number;
  rawText?: string;
  detectedRuleId?: string;
  structuralSplitUsed?: boolean;
  chapters: ParsedChapterDraft[];
}

export interface RegexTestResult {
  isValid: boolean;
  error?: string;
  matchCount: number;
  sampleMatches: Array<{
    index: number;
    lineNumber: number;
    text: string;
  }>;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\uFEFF/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function ensureFlags(flags: string): string {
  let result = flags || 'im';
  if (!result.includes('g')) result += 'g';
  if (!result.includes('m')) result += 'm';
  return result;
}

// Read raw text with multiple encoding fallbacks
export async function readFileAsText(file: File, selectedEncoding = 'auto'): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // If user forced encoding
  if (selectedEncoding !== 'auto') {
    try {
      const decoder = new TextDecoder(selectedEncoding);
      return decoder.decode(bytes);
    } catch {
      // Fallback to utf-8 if encoding not supported
    }
  }

  // Check BOM first
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes);
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Auto detection
  // 1. Try UTF-8 first (strict fatal flag to check if valid UTF-8)
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    return utf8Decoder.decode(bytes);
  } catch {
    // UTF-8 failed, test Windows-1258 or GBK
  }

  // 2. Fallback to Windows-1258 (Vietnamese ANSI) or UTF-8 replacement
  try {
    return new TextDecoder('windows-1258').decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

// Count Vietnamese/English/CJK words
export function countWords(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const matches = trimmed.match(/\S+/g);
  const spaceCount = matches ? matches.length : 0;
  if (spaceCount < trimmed.length / 8) {
    return trimmed.replace(/\s+/g, '').length;
  }
  return spaceCount;
}

// Test a custom regular expression against text with detailed diagnostics
export function testRegexPattern(
  pattern: string,
  flags = 'gim',
  text: string
): RegexTestResult {
  if (!pattern || !pattern.trim()) {
    return {
      isValid: false,
      error: 'Biểu thức chính quy không được để trống.',
      matchCount: 0,
      sampleMatches: [],
    };
  }

  const effectiveFlags = ensureFlags(flags);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, effectiveFlags);
  } catch (err: any) {
    return {
      isValid: false,
      error: err.message || 'Cú pháp RegEx không hợp lệ.',
      matchCount: 0,
      sampleMatches: [],
    };
  }

  const cleanedText = normalizeNewlines(text);
  const sampleMatches: Array<{ index: number; lineNumber: number; text: string }> = [];
  let matchCount = 0;
  let m: RegExpExecArray | null;

  // Track line numbers
  const lineBreaks: number[] = [];
  for (let i = 0; i < cleanedText.length; i++) {
    if (cleanedText[i] === '\n') {
      lineBreaks.push(i);
    }
  }

  const getLineNumber = (charIndex: number): number => {
    let low = 0;
    let high = lineBreaks.length - 1;
    let line = 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lineBreaks[mid] < charIndex) {
        line = mid + 2;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return line;
  };

  try {
    while ((m = regex.exec(cleanedText)) !== null) {
      const fullMatch = m[0].trim();
      if (fullMatch) {
        matchCount++;
        if (sampleMatches.length < 50) {
          const startChar = m.index + Math.max(0, m[0].indexOf(fullMatch));
          sampleMatches.push({
            index: startChar,
            lineNumber: getLineNumber(startChar),
            text: fullMatch.replace(/^#{1,6}\s+/, '').slice(0, 80),
          });
        }
      }
      // Safety guard against infinite loops on zero-length matches
      if (m.index === regex.lastIndex) {
        regex.lastIndex++;
      }
    }
  } catch (err: any) {
    return {
      isValid: false,
      error: 'Lỗi thực thi: ' + (err.message || 'Timeout / Lỗi lặp'),
      matchCount,
      sampleMatches,
    };
  }

  return {
    isValid: true,
    matchCount,
    sampleMatches,
  };
}

// Detect which built-in chapter splitting rule best fits the text
export function detectBestChapterRule(text: string): {
  rule: ChapterSplitRule;
  testResult: RegexTestResult;
} {
  const cleanedText = normalizeNewlines(text);
  const sampleText = cleanedText.length > 350000 ? cleanedText.slice(0, 350000) : cleanedText;

  let bestRule = DEFAULT_CHAPTER_RULES[0];
  let bestScore = -1;

  for (const rule of DEFAULT_CHAPTER_RULES) {
    const res = testRegexPattern(rule.pattern, rule.flags, sampleText);
    if (!res.isValid || res.matchCount === 0) continue;

    // Prefer dedicated chapter/heading markers over generic numeric lines
    const isNumeric = rule.id === 'numeric-prefix';
    const bonus = isNumeric ? 0 : 1000;
    const score = (res.matchCount >= 2 ? bonus : 0) + res.matchCount;

    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  const fullResult =
    sampleText.length === cleanedText.length && bestScore > -1
      ? testRegexPattern(bestRule.pattern, bestRule.flags, cleanedText)
      : testRegexPattern(bestRule.pattern, bestRule.flags, cleanedText);

  return { rule: bestRule, testResult: fullResult };
}

function cleanChapterTitle(raw: string): string {
  let title = raw.replace(/^#{1,6}\s+/, '').trim();
  if (title.length > 100) {
    title = title.slice(0, 100) + '...';
  }
  return title;
}

function isLikelyContentChapters(chapters: ParsedChapterDraft[]): boolean {
  if (chapters.length < 2) return false;
  const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
  const avgWords = totalWords / chapters.length;
  const substantialCount = chapters.filter((ch) => ch.wordCount >= 25).length;
  // Avoid falsely splitting a Table of Contents page into dozens of 1-line empty chapters
  return avgWords >= 30 && substantialCount >= Math.max(2, Math.floor(chapters.length * 0.4));
}

function shouldIncludePreamble(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const words = countWords(trimmed);
  // Skip short title pages, source banners, or converter metadata before Chapter 1
  if (words < 250) return false;

  const head = trimmed.slice(0, 600);
  const hasMetadataLabels =
    /(?:^|\n)\s*(?:Tên truyện|Tác giả|Thể loại|Tình trạng|Nguồn|Convert|Editor|Dịch giả|Văn án|Giới thiệu|Tóm tắt|Mục lục)\s*[:：]/im.test(
      head
    );
  if (hasMetadataLabels && words < 600) {
    return false;
  }
  return true;
}

// Split TXT/ebook raw content by regex rule
export function splitTextByRule(
  rawText: string,
  rulePattern: string,
  ruleFlags = 'gim',
  bookTitleFallback = 'Chương mở đầu'
): ParsedChapterDraft[] {
  const cleanedText = normalizeNewlines(rawText);

  let regex: RegExp;
  try {
    regex = new RegExp(rulePattern, ensureFlags(ruleFlags));
  } catch {
    regex = new RegExp(DEFAULT_CHAPTER_RULES[0].pattern, 'gim');
  }

  const matches: Array<{ index: number; fullMatch: string; title: string }> = [];
  let m: RegExpExecArray | null;

  while ((m = regex.exec(cleanedText)) !== null) {
    if (m.index === regex.lastIndex) {
      regex.lastIndex++;
    }
    const fullMatch = m[0].trim();
    if (!fullMatch) continue;
    matches.push({
      index: m.index + Math.max(0, m[0].indexOf(fullMatch)),
      fullMatch,
      title: cleanChapterTitle(fullMatch),
    });
  }

  // If no matches found, return whole text as one chapter or split by word blocks
  if (matches.length === 0) {
    const wordCount = countWords(cleanedText);
    if (wordCount > 6000) {
      return splitIntoChunks(cleanedText, 3500);
    }
    return [
      {
        title: bookTitleFallback || 'Toàn bộ nội dung',
        content: cleanedText.trim(),
        wordCount,
      },
    ];
  }

  const chapters: ParsedChapterDraft[] = [];

  // Preamble before first chapter: skip short metadata/intro blurbs, keep only substantial narrative prologue
  if (matches[0].index > 0) {
    const preambleText = cleanedText.slice(0, matches[0].index).trim();
    if (shouldIncludePreamble(preambleText)) {
      chapters.push({
        title: 'Mở đầu',
        content: preambleText,
        wordCount: countWords(preambleText),
      });
    }
  }

  // Iterate over matches
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const startIndex = current.index;
    const nextIndex = i + 1 < matches.length ? matches[i + 1].index : cleanedText.length;

    const slice = cleanedText.slice(startIndex, nextIndex).trim();

    const firstLineEnd = slice.indexOf('\n');
    let title = current.title;
    let body = slice;

    if (firstLineEnd !== -1) {
      title = cleanChapterTitle(slice.slice(0, firstLineEnd));
      body = slice.slice(firstLineEnd + 1).trim();
    } else {
      body = '';
    }

    chapters.push({
      title: title || `Chương ${i + 1}`,
      content: body || 'Nội dung đang cập nhật...',
      wordCount: countWords(body),
    });
  }

  return chapters;
}

// Split large text into word-based chunks if no headers exist
function splitIntoChunks(text: string, targetWordsPerChunk = 3500): ParsedChapterDraft[] {
  const paragraphs = text.split('\n');
  const chapters: ParsedChapterDraft[] = [];
  let currentChunk: string[] = [];
  let currentWords = 0;
  let chunkIndex = 1;

  for (const para of paragraphs) {
    const pWords = countWords(para);
    currentChunk.push(para);
    currentWords += pWords;

    if (currentWords >= targetWordsPerChunk) {
      const content = currentChunk.join('\n').trim();
      chapters.push({
        title: `Phần ${chunkIndex}`,
        content,
        wordCount: currentWords,
      });
      chunkIndex++;
      currentChunk = [];
      currentWords = 0;
    }
  }

  if (currentChunk.length > 0) {
    const content = currentChunk.join('\n').trim();
    if (content) {
      chapters.push({
        title: `Phần ${chunkIndex}`,
        content,
        wordCount: countWords(content),
      });
    }
  }

  return chapters;
}

function buildRawTextFromChapters(chapters: ParsedChapterDraft[]): string {
  return chapters
    .map((ch) => {
      const firstLine = ch.content.split('\n')[0]?.trim() || '';
      if (firstLine === ch.title.trim()) {
        return ch.content;
      }
      return `${ch.title}\n${ch.content}`;
    })
    .join('\n\n');
}

// Structured HTML block extraction preserving paragraphs, line breaks, headings & anchor IDs
interface ExtractedHtmlBlock {
  text: string;
  headingLevel: number; // 0 for normal text, 1-6 for h1-h6
  anchorIds: string[];
}

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TR',
  'UL',
]);

function extractInlineTextWithBreaks(node: Node, anchorIds: Set<string>): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').replace(/[ \t\r\n]+/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') return '';

  const elId = el.getAttribute('id') || el.getAttribute('name');
  if (elId) anchorIds.add(elId);

  if (tag === 'BR') return '\n';

  let text = '';
  for (const child of Array.from(el.childNodes)) {
    text += extractInlineTextWithBreaks(child, anchorIds);
  }
  return text;
}

function extractHtmlBlocks(rootEl: Element): ExtractedHtmlBlock[] {
  const blocks: ExtractedHtmlBlock[] = [];
  let pendingAnchors = new Set<string>();

  const pushTextBlock = (rawText: string, headingLevel: number, extraAnchors?: Set<string>) => {
    const anchors = new Set<string>(pendingAnchors);
    if (extraAnchors) {
      extraAnchors.forEach((id) => anchors.add(id));
    }
    pendingAnchors.clear();

    const lines = rawText
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      // Preserve anchors for the next non-empty block
      anchors.forEach((id) => pendingAnchors.add(id));
      return;
    }

    if (headingLevel > 0) {
      blocks.push({
        text: lines.join(' '),
        headingLevel,
        anchorIds: Array.from(anchors),
      });
      return;
    }

    lines.forEach((line, idx) => {
      blocks.push({
        text: line,
        headingLevel: 0,
        anchorIds: idx === 0 ? Array.from(anchors) : [],
      });
    });
  };

  const hasChildBlock = (el: Element): boolean => {
    return Array.from(el.children).some(
      (child) => BLOCK_TAGS.has(child.tagName.toUpperCase()) || hasChildBlock(child)
    );
  };

  const walk = (container: Element) => {
    const containerId = container.getAttribute('id') || container.getAttribute('name');
    if (containerId) pendingAnchors.add(containerId);

    let inlineBuffer = '';
    const inlineAnchors = new Set<string>();

    const flushInline = () => {
      if (inlineBuffer.trim()) {
        pushTextBlock(inlineBuffer, 0, inlineAnchors);
      } else {
        inlineAnchors.forEach((id) => pendingAnchors.add(id));
      }
      inlineBuffer = '';
      inlineAnchors.clear();
    };

    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        inlineBuffer += (child.textContent || '').replace(/[ \t\r\n]+/g, ' ');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const el = child as Element;
      const tag = el.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') continue;

      if (tag === 'BR') {
        inlineBuffer += '\n';
        continue;
      }

      if (!BLOCK_TAGS.has(tag)) {
        inlineBuffer += extractInlineTextWithBreaks(el, inlineAnchors);
        continue;
      }

      flushInline();

      if (tag === 'HR') {
        const hrId = el.getAttribute('id');
        if (hrId) pendingAnchors.add(hrId);
        continue;
      }

      const headingMatch = /^H([1-6])$/.exec(tag);
      const headingLevel = headingMatch ? Number(headingMatch[1]) : 0;

      if (headingLevel > 0 || !hasChildBlock(el)) {
        const blockAnchors = new Set<string>();
        const elId = el.getAttribute('id') || el.getAttribute('name');
        if (elId) blockAnchors.add(elId);
        const text = extractInlineTextWithBreaks(el, blockAnchors);
        pushTextBlock(text, headingLevel, blockAnchors);
      } else {
        walk(el);
      }
    }

    flushInline();
  };

  walk(rootEl);
  return blocks;
}

function splitBlocksByHeadingLevel(
  blocks: ExtractedHtmlBlock[],
  targetLevel: number,
  fallbackTitle: string
): ParsedChapterDraft[] | null {
  const headingIndices: number[] = [];
  blocks.forEach((b, idx) => {
    if (b.headingLevel > 0 && b.headingLevel <= targetLevel) {
      headingIndices.push(idx);
    }
  });

  if (headingIndices.length < 2) return null;

  const result: ParsedChapterDraft[] = [];

  if (headingIndices[0] > 0) {
    const preText = blocks
      .slice(0, headingIndices[0])
      .map((b) => b.text)
      .join('\n\n')
      .trim();
    if (shouldIncludePreamble(preText)) {
      result.push({
        title: fallbackTitle || 'Mở đầu',
        content: preText,
        wordCount: countWords(preText),
      });
    }
  }

  for (let i = 0; i < headingIndices.length; i++) {
    const startIdx = headingIndices[i];
    const endIdx = i + 1 < headingIndices.length ? headingIndices[i + 1] : blocks.length;
    const chTitle = cleanChapterTitle(blocks[startIdx].text) || `Chương ${result.length + 1}`;
    const bodyText = blocks
      .slice(startIdx + 1, endIdx)
      .map((b) => b.text)
      .join('\n\n')
      .trim();
    const finalBody = bodyText || chTitle;
    result.push({
      title: chTitle,
      content: finalBody,
      wordCount: countWords(finalBody),
    });
  }

  return isLikelyContentChapters(result) ? result : null;
}

// Path utilities for EPUB ZIP resolution
function normalizeZipPath(baseDir: string, href: string): string {
  const cleanHref = href.split('#')[0].split('?')[0];
  let combined = (baseDir + cleanHref).replace(/\\/g, '/');
  try {
    combined = decodeURIComponent(combined);
  } catch {
    // ignore malformed URI sequences
  }
  const segments: string[] = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join('/');
}

function resolveEpubZipFile(zip: JSZip, baseDir: string, href: string) {
  const cleanHref = href.split('#')[0].split('?')[0];
  const normalized = normalizeZipPath(baseDir, href);
  const candidates = [normalized, cleanHref];
  try {
    candidates.push(decodeURIComponent(cleanHref));
  } catch {
    // ignore
  }
  for (const c of candidates) {
    const found = zip.file(c);
    if (found) return { file: found, path: c };
  }
  // Case-insensitive fallback
  const lowerTarget = normalized.toLowerCase();
  const matchedKey = Object.keys(zip.files).find((k) => k.toLowerCase() === lowerTarget);
  if (matchedKey) {
    return { file: zip.files[matchedKey], path: matchedKey };
  }
  return null;
}

function queryXmlAll(doc: Document | Element, localName: string): Element[] {
  const direct = Array.from(doc.getElementsByTagNameNS('*', localName));
  if (direct.length > 0) return direct;
  return Array.from(doc.getElementsByTagName(localName));
}

function queryXmlFirst(doc: Document | Element, localName: string): Element | null {
  return queryXmlAll(doc, localName)[0] || null;
}

interface EpubTocEntry {
  filePath: string;
  fragment: string;
  label: string;
}

async function extractEpubTocEntries(
  zip: JSZip,
  opfDoc: Document,
  opfDir: string,
  manifestItems: Record<string, { href: string; mediaType: string; properties: string }>
): Promise<EpubTocEntry[]> {
  const entries: EpubTocEntry[] = [];
  const xmlParser = new DOMParser();

  // 1. Prefer EPUB3 nav document
  const navItemId = Object.keys(manifestItems).find((id) =>
    manifestItems[id].properties.split(/\s+/).includes('nav')
  );
  if (navItemId) {
    const resolved = resolveEpubZipFile(zip, opfDir, manifestItems[navItemId].href);
    if (resolved) {
      const navHtml = await resolved.file.async('text');
      const navDoc = xmlParser.parseFromString(navHtml, 'text/html');
      const navDir = resolved.path.includes('/')
        ? resolved.path.substring(0, resolved.path.lastIndexOf('/') + 1)
        : '';
      const tocNav =
        Array.from(navDoc.querySelectorAll('nav')).find((n) => {
          const epubType = n.getAttribute('epub:type') || n.getAttribute('type') || '';
          return epubType.toLowerCase().includes('toc');
        }) || navDoc.querySelector('nav');

      if (tocNav) {
        tocNav.querySelectorAll('a[href]').forEach((a) => {
          const rawHref = a.getAttribute('href') || '';
          const label = (a.textContent || '').replace(/\s+/g, ' ').trim();
          if (!rawHref || !label) return;
          const [filePart, fragPart = ''] = rawHref.split('#');
          const filePath = filePart ? normalizeZipPath(navDir, filePart) : '';
          entries.push({ filePath, fragment: fragPart, label });
        });
      }
    }
  }

  if (entries.length > 0) return entries;

  // 2. Fallback to EPUB2 NCX
  const spineEl = queryXmlFirst(opfDoc, 'spine');
  const tocAttrId = spineEl?.getAttribute('toc');
  const ncxId =
    (tocAttrId && manifestItems[tocAttrId] ? tocAttrId : null) ||
    Object.keys(manifestItems).find(
      (id) => manifestItems[id].mediaType === 'application/x-dtbncx+xml'
    );

  if (ncxId && manifestItems[ncxId]) {
    const resolved = resolveEpubZipFile(zip, opfDir, manifestItems[ncxId].href);
    if (resolved) {
      const ncxStr = await resolved.file.async('text');
      const ncxDoc = xmlParser.parseFromString(ncxStr, 'application/xml');
      const ncxDir = resolved.path.includes('/')
        ? resolved.path.substring(0, resolved.path.lastIndexOf('/') + 1)
        : '';

      const navPoints = queryXmlAll(ncxDoc, 'navPoint');
      for (const np of navPoints) {
        const navLabelEl = queryXmlFirst(np, 'navLabel');
        const textEl = navLabelEl ? queryXmlFirst(navLabelEl, 'text') : null;
        const contentEl = queryXmlFirst(np, 'content');
        const label = (textEl?.textContent || '').replace(/\s+/g, ' ').trim();
        const rawSrc = contentEl?.getAttribute('src') || '';
        if (!label || !rawSrc) continue;
        const [filePart, fragPart = ''] = rawSrc.split('#');
        const filePath = normalizeZipPath(ncxDir, filePart);
        entries.push({ filePath, fragment: fragPart, label });
      }
    }
  }

  return entries;
}

// EPUB Parser with TOC anchor splitting, HTML heading splitting & regex fallback
export async function parseEpubFile(file: File): Promise<ParsedBookDraft> {
  const zip = await JSZip.loadAsync(file);

  // 1. Locate container.xml
  const containerXmlStr = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXmlStr) {
    throw new Error('File EPUB không đúng cấu trúc (thiếu META-INF/container.xml)');
  }

  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXmlStr, 'application/xml');
  const rootfile = queryXmlFirst(containerDoc, 'rootfile');
  const opfPath = rootfile?.getAttribute('full-path') || 'content.opf';
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2. Read OPF file
  const opfResolved = resolveEpubZipFile(zip, '', opfPath);
  const opfStr = await opfResolved?.file.async('text');
  if (!opfStr) {
    throw new Error(`Không tìm thấy file OPF tại: ${opfPath}`);
  }

  const opfDoc = parser.parseFromString(opfStr, 'application/xml');

  // Metadata
  const title =
    queryXmlFirst(opfDoc, 'title')?.textContent?.trim() || file.name.replace(/\.[^/.]+$/, '');
  const author = queryXmlFirst(opfDoc, 'creator')?.textContent?.trim() || 'Khuyết danh';
  const description = queryXmlFirst(opfDoc, 'description')?.textContent?.trim() || '';

  // Manifest items
  const manifestItems: Record<string, { href: string; mediaType: string; properties: string }> = {};
  queryXmlAll(opfDoc, 'item').forEach((item) => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') || '';
    const properties = item.getAttribute('properties') || '';
    if (id && href) {
      manifestItems[id] = { href, mediaType, properties };
    }
  });

  // Extract cover image if available
  let coverUrl: string | undefined;
  const coverMeta = queryXmlAll(opfDoc, 'meta').find(
    (m) => m.getAttribute('name') === 'cover'
  );
  const coverItemId =
    coverMeta?.getAttribute('content') ||
    Object.keys(manifestItems).find((id) =>
      manifestItems[id].properties.split(/\s+/).includes('cover-image')
    );
  if (coverItemId && manifestItems[coverItemId]) {
    const coverResolved = resolveEpubZipFile(zip, opfDir, manifestItems[coverItemId].href);
    if (coverResolved) {
      const coverBase64 = await coverResolved.file.async('base64');
      const mime = manifestItems[coverItemId].mediaType || 'image/jpeg';
      coverUrl = `data:${mime};base64,${coverBase64}`;
    }
  }

  // Extract TOC entries (NCX / EPUB3 Nav)
  const tocEntries = await extractEpubTocEntries(zip, opfDoc, opfDir, manifestItems);
  const tocByFile = new Map<string, EpubTocEntry[]>();
  for (const entry of tocEntries) {
    if (!entry.filePath) continue;
    const key = entry.filePath.toLowerCase();
    const list = tocByFile.get(key) || [];
    list.push(entry);
    tocByFile.set(key, list);
  }

  // Spine items in reading order
  const spineItemRefs = queryXmlAll(opfDoc, 'itemref')
    .map((el) => el.getAttribute('idref'))
    .filter(Boolean) as string[];

  interface SpineSectionData {
    fileKey: string;
    fileTocEntries: EpubTocEntry[];
    blocks: ExtractedHtmlBlock[];
    joinedText: string;
    firstHeadingText: string;
    usableDocTitle: string;
  }

  const spineSections: SpineSectionData[] = [];
  const rawSegments: string[] = [];

  for (let i = 0; i < spineItemRefs.length; i++) {
    const idref = spineItemRefs[i];
    const manifestItem = manifestItems[idref];
    if (!manifestItem) continue;

    // Skip non-document items (images, CSS, etc.)
    const lowerType = manifestItem.mediaType.toLowerCase();
    const lowerHref = manifestItem.href.toLowerCase();
    if (
      lowerType &&
      !lowerType.includes('html') &&
      !lowerType.includes('xml') &&
      !lowerHref.endsWith('.xhtml') &&
      !lowerHref.endsWith('.html') &&
      !lowerHref.endsWith('.htm')
    ) {
      continue;
    }

    const resolved = resolveEpubZipFile(zip, opfDir, manifestItem.href);
    if (!resolved) continue;

    const htmlStr = await resolved.file.async('text');
    const doc = parser.parseFromString(htmlStr, 'text/html');
    const bodyEl = doc.body || doc.documentElement;
    if (!bodyEl) continue;

    bodyEl.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());

    const blocks = extractHtmlBlocks(bodyEl);
    const joinedText = blocks.map((b) => b.text).join('\n\n').trim();
    if (joinedText.length < 15) continue;

    rawSegments.push(joinedText);

    const fileKey = resolved.path.toLowerCase();
    const fileTocEntries = tocByFile.get(fileKey) || [];
    const firstHeadingText =
      blocks.find((b) => b.headingLevel > 0 && b.headingLevel <= 3)?.text || '';
    const docTitleTag = doc.querySelector('title')?.textContent?.trim() || '';
    const usableDocTitle =
      docTitleTag && docTitleTag.toLowerCase() !== title.toLowerCase() ? docTitleTag : '';

    spineSections.push({
      fileKey,
      fileTocEntries,
      blocks,
      joinedText,
      firstHeadingText,
      usableDocTitle,
    });
  }

  const chapters: ParsedChapterDraft[] = [];
  const fullBookText = rawSegments.join('\n\n').trim();

  const appendLeadingTextToPrevChapter = (leadingText: string): boolean => {
    const trimmed = leadingText.trim();
    if (!trimmed || chapters.length === 0) return false;
    const prev = chapters[chapters.length - 1];
    prev.content = `${prev.content}\n\n${trimmed}`.trim();
    prev.wordCount = countWords(prev.content);
    return true;
  };

  // Detect whether this EPUB has an incomplete/missing TOC and splits chapters across XHTML files
  const spineWithTocCount = spineSections.filter((s) => s.fileTocEntries.length > 0).length;
  const hasFragmentToc = spineSections.some(
    (s) => s.fileTocEntries.filter((e) => e.fragment).length >= 2
  );

  let wholeBookRegexChapters: ParsedChapterDraft[] | null = null;
  if (fullBookText && !hasFragmentToc) {
    const { rule: bestFullRule, testResult: fullTest } = detectBestChapterRule(fullBookText);
    const allowNumeric = spineSections.length <= 3;
    if (
      fullTest.isValid &&
      fullTest.matchCount >= 2 &&
      (bestFullRule.id !== 'numeric-prefix' || allowNumeric)
    ) {
      const candidate = splitTextByRule(
        fullBookText,
        bestFullRule.pattern,
        bestFullRule.flags,
        title
      );
      if (isLikelyContentChapters(candidate)) {
        wholeBookRegexChapters = candidate;
      }
    }
  }

  const tocIncomplete = tocEntries.length < 2 || spineWithTocCount < 2;
  const coarseTocOverride =
    wholeBookRegexChapters !== null &&
    wholeBookRegexChapters.length >= Math.max(4, tocEntries.length * 2);

  if (
    wholeBookRegexChapters &&
    ((tocIncomplete &&
      (wholeBookRegexChapters.length >= Math.max(2, Math.floor(spineSections.length * 0.5)) ||
        spineSections.length <= 5)) ||
      coarseTocOverride)
  ) {
    chapters.push(...wholeBookRegexChapters);
  } else {
    for (let sIdx = 0; sIdx < spineSections.length; sIdx++) {
      const sec = spineSections[sIdx];
      const { fileTocEntries, blocks, joinedText, firstHeadingText, usableDocTitle } = sec;

      // Strategy 1: Split a single HTML file by multiple TOC #fragment anchors
      const fragmentEntries = fileTocEntries.filter((e) => e.fragment);
      if (fragmentEntries.length >= 2) {
        const anchorSplits: Array<{ blockIdx: number; label: string }> = [];
        const seenBlockIdx = new Set<number>();

        for (const entry of fragmentEntries) {
          const blockIdx = blocks.findIndex((b) => b.anchorIds.includes(entry.fragment));
          if (blockIdx !== -1 && !seenBlockIdx.has(blockIdx)) {
            seenBlockIdx.add(blockIdx);
            anchorSplits.push({ blockIdx, label: entry.label });
          }
        }

        anchorSplits.sort((a, b) => a.blockIdx - b.blockIdx);

        if (anchorSplits.length >= 2) {
          if (anchorSplits[0].blockIdx > 0) {
            const preBlocks = blocks.slice(0, anchorSplits[0].blockIdx);
            const preText = preBlocks.map((b) => b.text).join('\n\n').trim();
            if (preText) {
              const firstPreHeading = preBlocks.find((b) => b.headingLevel > 0)?.text;
              if (sIdx > 0 && chapters.length > 0 && !firstPreHeading) {
                appendLeadingTextToPrevChapter(preText);
              } else if (firstPreHeading || shouldIncludePreamble(preText)) {
                chapters.push({
                  title: cleanChapterTitle(
                    firstPreHeading || fileTocEntries[0]?.label || 'Mở đầu'
                  ),
                  content: preText,
                  wordCount: countWords(preText),
                });
              }
            }
          }

          for (let s = 0; s < anchorSplits.length; s++) {
            const start = anchorSplits[s].blockIdx;
            const end = s + 1 < anchorSplits.length ? anchorSplits[s + 1].blockIdx : blocks.length;
            const sliceBlocks = blocks.slice(start, end);
            const sliceTitle = cleanChapterTitle(anchorSplits[s].label);
            // Avoid repeating the title line if block[0] is identical heading
            const contentBlocks =
              sliceBlocks.length > 1 &&
              sliceBlocks[0].text.trim().toLowerCase() === sliceTitle.toLowerCase()
                ? sliceBlocks.slice(1)
                : sliceBlocks;
            const content = contentBlocks.map((b) => b.text).join('\n\n').trim() || sliceTitle;
            chapters.push({
              title: sliceTitle || `Chương ${chapters.length + 1}`,
              content,
              wordCount: countWords(content),
            });
          }
          continue;
        }
      }

      // Strategy 2: Check if this single spine file contains multiple chapters via chapter markers (RegEx)
      const { rule: bestRule, testResult } = detectBestChapterRule(joinedText);
      const allowNumericHere = spineSections.length <= 3;
      if (
        testResult.isValid &&
        testResult.matchCount >= 2 &&
        (bestRule.id !== 'numeric-prefix' || allowNumericHere)
      ) {
        // Inspect raw leading slice before first match so mid-book splits stitch seamlessly
        const effFlags = ensureFlags(bestRule.flags);
        let firstMatchIdx = -1;
        try {
          const rx = new RegExp(bestRule.pattern, effFlags);
          const m = rx.exec(normalizeNewlines(joinedText));
          if (m) {
            const fm = m[0].trim();
            firstMatchIdx = m.index + Math.max(0, m[0].indexOf(fm));
          }
        } catch {
          // ignore
        }

        const leadingText = firstMatchIdx > 0 ? joinedText.slice(0, firstMatchIdx).trim() : '';
        const tailText = firstMatchIdx > 0 ? joinedText.slice(firstMatchIdx) : joinedText;

        const candidateChapters = splitTextByRule(
          sIdx > 0 && chapters.length > 0 ? tailText : joinedText,
          bestRule.pattern,
          bestRule.flags,
          fileTocEntries[0]?.label || `Chương ${chapters.length + 1}`
        );
        if (isLikelyContentChapters(candidateChapters)) {
          if (sIdx > 0 && chapters.length > 0 && leadingText) {
            appendLeadingTextToPrevChapter(leadingText);
          }
          chapters.push(...candidateChapters);
          continue;
        }
      }

      // Strategy 3: Split by multiple <h1> (or <h2> if EPUB has very few spine files)
      const headingSplitH1 = splitBlocksByHeadingLevel(
        blocks,
        1,
        fileTocEntries[0]?.label || 'Mở đầu'
      );
      if (headingSplitH1) {
        if (sIdx > 0 && chapters.length > 0 && blocks[0]?.headingLevel !== 1) {
          const firstH1Idx = blocks.findIndex((b) => b.headingLevel === 1);
          if (firstH1Idx > 0) {
            const preText = blocks.slice(0, firstH1Idx).map((b) => b.text).join('\n\n').trim();
            appendLeadingTextToPrevChapter(preText);
            const restH1 = splitBlocksByHeadingLevel(blocks.slice(firstH1Idx), 1, '');
            if (restH1) {
              chapters.push(...restH1);
              continue;
            }
          }
        }
        chapters.push(...headingSplitH1);
        continue;
      }

      if (spineSections.length <= 5) {
        const headingSplitH2 = splitBlocksByHeadingLevel(
          blocks,
          2,
          fileTocEntries[0]?.label || 'Mở đầu'
        );
        if (headingSplitH2) {
          if (sIdx > 0 && chapters.length > 0 && blocks[0]?.headingLevel !== 2) {
            const firstH2Idx = blocks.findIndex((b) => b.headingLevel > 0 && b.headingLevel <= 2);
            if (firstH2Idx > 0) {
              const preText = blocks.slice(0, firstH2Idx).map((b) => b.text).join('\n\n').trim();
              appendLeadingTextToPrevChapter(preText);
              const restH2 = splitBlocksByHeadingLevel(blocks.slice(firstH2Idx), 2, '');
              if (restH2) {
                chapters.push(...restH2);
                continue;
              }
            }
          }
          chapters.push(...headingSplitH2);
          continue;
        }
      }

      // Strategy 4: Standard single chapter per spine file
      const chapterTitle = cleanChapterTitle(
        fileTocEntries[0]?.label ||
          firstHeadingText ||
          usableDocTitle ||
          `Chương ${chapters.length + 1}`
      );

      const contentBlocks =
        blocks.length > 1 &&
        blocks[0].headingLevel > 0 &&
        blocks[0].text.trim().toLowerCase() === chapterTitle.toLowerCase()
          ? blocks.slice(1)
          : blocks;

      const cleanContent = contentBlocks.map((b) => b.text).join('\n\n').trim() || joinedText;

      chapters.push({
        title: chapterTitle,
        wordCount: countWords(cleanContent),
        content: cleanContent,
      });
    }
  }

  if (chapters.length === 0) {
    chapters.push({
      title,
      wordCount: 0,
      content: 'Không tìm thấy nội dung văn bản trong file EPUB này.',
    });
  }

  const hasExtractedContent = chapters.some((c) => c.wordCount > 0);
  const rawText = hasExtractedContent
    ? fullBookText || buildRawTextFromChapters(chapters)
    : rawSegments.join('\n\n');

  return {
    title,
    author,
    description,
    coverUrl,
    format: 'EPUB',
    sourceFileName: file.name,
    fileSize: file.size,
    rawText,
    structuralSplitUsed: true,
    chapters,
  };
}

// FictionBook2 (.fb2) Ebook Parser
export async function parseFb2File(file: File): Promise<ParsedBookDraft> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Peek XML encoding declaration if present
  const asciiHead = new TextDecoder('ascii', { fatal: false }).decode(bytes.slice(0, 256));
  const encMatch = /encoding=["']([^"']+)["']/i.exec(asciiHead);
  let xmlStr: string;
  if (encMatch && encMatch[1]) {
    try {
      xmlStr = new TextDecoder(encMatch[1]).decode(bytes);
    } catch {
      xmlStr = await readFileAsText(file);
    }
  } else {
    xmlStr = await readFileAsText(file);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');

  const titleEl = queryXmlFirst(doc, 'book-title');
  const title = titleEl?.textContent?.trim() || file.name.replace(/\.[^/.]+$/, '');

  const authorEl = queryXmlFirst(doc, 'author');
  const firstName = authorEl ? queryXmlFirst(authorEl, 'first-name')?.textContent?.trim() : '';
  const lastName = authorEl ? queryXmlFirst(authorEl, 'last-name')?.textContent?.trim() : '';
  const nickName = authorEl ? queryXmlFirst(authorEl, 'nickname')?.textContent?.trim() : '';
  const author = [firstName, lastName].filter(Boolean).join(' ') || nickName || 'Khuyết danh';

  const annotationEl = queryXmlFirst(doc, 'annotation');
  const description = annotationEl?.textContent?.replace(/\s+/g, ' ').trim() || '';

  // Cover image
  let coverUrl: string | undefined;
  const coverPageEl = queryXmlFirst(doc, 'coverpage');
  const coverImageEl = coverPageEl ? queryXmlFirst(coverPageEl, 'image') : null;
  const coverRef =
    coverImageEl?.getAttribute('l:href') ||
    coverImageEl?.getAttribute('xlink:href') ||
    coverImageEl?.getAttribute('href') ||
    '';
  if (coverRef) {
    const cleanId = coverRef.replace(/^#/, '');
    const binaryEl = queryXmlAll(doc, 'binary').find((b) => b.getAttribute('id') === cleanId);
    if (binaryEl?.textContent) {
      const mime = binaryEl.getAttribute('content-type') || 'image/jpeg';
      coverUrl = `data:${mime};base64,${binaryEl.textContent.replace(/\s+/g, '')}`;
    }
  }

  const chapters: ParsedChapterDraft[] = [];
  const bodies = queryXmlAll(doc, 'body').filter(
    (b) => (b.getAttribute('name') || '').toLowerCase() !== 'notes'
  );
  const mainBody = bodies[0] || queryXmlFirst(doc, 'body');

  const extractSectionTitle = (sec: Element): string => {
    const directTitle = Array.from(sec.children).find(
      (c) => c.localName?.toLowerCase() === 'title'
    );
    if (!directTitle) return '';
    return Array.from(directTitle.querySelectorAll('p'))
      .map((p) => p.textContent?.trim())
      .filter(Boolean)
      .join(' - ')
      .trim() || directTitle.textContent?.replace(/\s+/g, ' ').trim() || '';
  };

  const walkSection = (sec: Element, parentTitlePrefix = '') => {
    const ownTitle = extractSectionTitle(sec);
    const fullTitle =
      parentTitlePrefix && ownTitle
        ? `${parentTitlePrefix} — ${ownTitle}`
        : ownTitle || parentTitlePrefix;

    const childSections = Array.from(sec.children).filter(
      (c) => c.localName?.toLowerCase() === 'section'
    );
    const directParagraphs = Array.from(sec.children)
      .filter((c) => {
        const name = c.localName?.toLowerCase();
        return name === 'p' || name === 'poem' || name === 'cite' || name === 'subtitle';
      })
      .map((c) => c.textContent?.replace(/\s+/g, ' ').trim())
      .filter((t): t is string => Boolean(t && t.length > 0));

    if (childSections.length > 0) {
      if (directParagraphs.length > 0) {
        const content = directParagraphs.join('\n\n');
        chapters.push({
          title: cleanChapterTitle(fullTitle || `Chương ${chapters.length + 1}`),
          content,
          wordCount: countWords(content),
        });
      }
      for (const child of childSections) {
        walkSection(child, directParagraphs.length === 0 ? fullTitle : '');
      }
      return;
    }

    const allParagraphs = Array.from(sec.querySelectorAll('p, subtitle, cite'))
      .filter((p) => !p.closest('title'))
      .map((p) => p.textContent?.replace(/\s+/g, ' ').trim())
      .filter((t): t is string => Boolean(t && t.length > 0));

    const content = allParagraphs.join('\n\n').trim();
    if (content) {
      chapters.push({
        title: cleanChapterTitle(fullTitle || `Chương ${chapters.length + 1}`),
        content,
        wordCount: countWords(content),
      });
    }
  };

  if (mainBody) {
    const topSections = Array.from(mainBody.children).filter(
      (c) => c.localName?.toLowerCase() === 'section'
    );
    if (topSections.length > 0) {
      topSections.forEach((sec) => walkSection(sec));
    } else {
      const paragraphs = Array.from(mainBody.querySelectorAll('p'))
        .map((p) => p.textContent?.replace(/\s+/g, ' ').trim())
        .filter((t): t is string => Boolean(t));
      const joined = paragraphs.join('\n\n');
      if (joined) {
        const { rule, testResult } = detectBestChapterRule(joined);
        if (testResult.isValid && testResult.matchCount >= 2) {
          chapters.push(...splitTextByRule(joined, rule.pattern, rule.flags, title));
        } else {
          chapters.push({
            title,
            content: joined,
            wordCount: countWords(joined),
          });
        }
      }
    }
  }

  // If FB2 only had 1 giant section, check regex markers inside
  if (chapters.length === 1 && chapters[0].wordCount > 1500) {
    const { rule, testResult } = detectBestChapterRule(chapters[0].content);
    if (testResult.isValid && testResult.matchCount >= 2) {
      const resplit = splitTextByRule(chapters[0].content, rule.pattern, rule.flags, title);
      if (isLikelyContentChapters(resplit)) {
        chapters.splice(0, chapters.length, ...resplit);
      }
    }
  }

  if (chapters.length === 0) {
    chapters.push({
      title,
      wordCount: 0,
      content: 'Không tìm thấy nội dung văn bản trong file FB2 này.',
    });
  }

  const rawText = buildRawTextFromChapters(chapters);

  return {
    title,
    author,
    description,
    coverUrl,
    format: 'FB2',
    sourceFileName: file.name,
    fileSize: file.size,
    rawText,
    structuralSplitUsed: true,
    chapters,
  };
}

// DOCX Ebook Parser (via JSZip + word/document.xml)
export async function parseDocxFile(file: File): Promise<ParsedBookDraft> {
  const zip = await JSZip.loadAsync(file);
  const docXmlStr = await zip.file('word/document.xml')?.async('text');
  if (!docXmlStr) {
    throw new Error('File DOCX không đúng cấu trúc (thiếu word/document.xml)');
  }

  const parser = new DOMParser();
  let title = file.name.replace(/\.[^/.]+$/, '');
  let author = 'Khuyết danh';
  let description = '';

  const coreXmlStr = await zip.file('docProps/core.xml')?.async('text');
  if (coreXmlStr) {
    const coreDoc = parser.parseFromString(coreXmlStr, 'application/xml');
    const coreTitle = queryXmlFirst(coreDoc, 'title')?.textContent?.trim();
    const coreCreator = queryXmlFirst(coreDoc, 'creator')?.textContent?.trim();
    const coreDesc = queryXmlFirst(coreDoc, 'description')?.textContent?.trim();
    if (coreTitle) title = coreTitle;
    if (coreCreator) author = coreCreator;
    if (coreDesc) description = coreDesc;
  }

  const xmlDoc = parser.parseFromString(docXmlStr, 'application/xml');
  const paragraphs = queryXmlAll(xmlDoc, 'p');

  const blocks: ExtractedHtmlBlock[] = [];
  for (const p of paragraphs) {
    const pStyleEl = queryXmlFirst(p, 'pStyle');
    const styleVal = (pStyleEl?.getAttribute('w:val') || pStyleEl?.getAttribute('val') || '').toLowerCase();

    let headingLevel = 0;
    if (/^heading\s*1$|^1$|^title$|^tiu1$|chương/.test(styleVal)) headingLevel = 1;
    else if (/^heading\s*2$|^2$/.test(styleVal)) headingLevel = 2;
    else if (/^heading\s*3$|^3$/.test(styleVal)) headingLevel = 3;

    const textRuns = queryXmlAll(p, 't')
      .map((t) => t.textContent || '')
      .join('');
    const cleanLine = textRuns.replace(/\s+/g, ' ').trim();
    if (!cleanLine) continue;

    blocks.push({
      text: cleanLine,
      headingLevel,
      anchorIds: [],
    });
  }

  const rawText = blocks.map((b) => b.text).join('\n\n').trim();
  const { rule: bestRule, testResult } = detectBestChapterRule(rawText);

  let chapters: ParsedChapterDraft[] | null = null;
  let detectedRuleId: string | undefined;
  let structuralSplitUsed = false;

  // Prefer explicit regex chapter headings if found >= 2
  if (testResult.isValid && testResult.matchCount >= 2) {
    const regexChapters = splitTextByRule(rawText, bestRule.pattern, bestRule.flags, title);
    if (isLikelyContentChapters(regexChapters)) {
      chapters = regexChapters;
      detectedRuleId = bestRule.id;
    }
  }

  // Otherwise try Heading 1 / Heading 2 style splits
  if (!chapters) {
    const h1Split = splitBlocksByHeadingLevel(blocks, 1, title);
    if (h1Split) {
      chapters = h1Split;
      structuralSplitUsed = true;
    } else {
      const h2Split = splitBlocksByHeadingLevel(blocks, 2, title);
      if (h2Split) {
        chapters = h2Split;
        structuralSplitUsed = true;
      }
    }
  }

  if (!chapters) {
    chapters = splitTextByRule(rawText, bestRule.pattern, bestRule.flags, title);
    detectedRuleId = bestRule.id;
  }

  return {
    title,
    author,
    description,
    format: 'DOCX',
    sourceFileName: file.name,
    fileSize: file.size,
    rawText,
    detectedRuleId,
    structuralSplitUsed,
    chapters,
  };
}

// HTML / Markdown parser with smart chapter auto-detection
export async function parseHtmlOrMdFile(
  file: File,
  selectedEncoding = 'auto'
): Promise<ParsedBookDraft> {
  const rawText = await readFileAsText(file, selectedEncoding);
  const isMarkdown = file.name.toLowerCase().endsWith('.md');
  let title = file.name.replace(/\.[^/.]+$/, '');
  let cleanText = normalizeNewlines(rawText);
  let blocks: ExtractedHtmlBlock[] = [];

  if (!isMarkdown) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawText, 'text/html');
    const docTitle = doc.querySelector('h1, title')?.textContent?.trim();
    if (docTitle) {
      title = docTitle;
    }
    doc.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
    const bodyEl = doc.body || doc.documentElement;
    if (bodyEl) {
      blocks = extractHtmlBlocks(bodyEl);
      if (blocks.length > 0) {
        cleanText = blocks.map((b) => b.text).join('\n\n');
      } else {
        cleanText = normalizeNewlines(bodyEl.textContent?.trim() || rawText);
      }
    }
  }

  const { rule: bestRule, testResult } = detectBestChapterRule(cleanText);
  let chapters: ParsedChapterDraft[];
  let detectedRuleId: string | undefined = bestRule.id;
  let structuralSplitUsed = false;

  if (testResult.isValid && testResult.matchCount >= 2) {
    const regexChapters = splitTextByRule(cleanText, bestRule.pattern, bestRule.flags, title);
    if (isLikelyContentChapters(regexChapters) || isMarkdown) {
      chapters = regexChapters;
    } else {
      const hSplit =
        !isMarkdown && blocks.length > 0
          ? splitBlocksByHeadingLevel(blocks, 2, title)
          : null;
      if (hSplit) {
        chapters = hSplit;
        structuralSplitUsed = true;
      } else {
        chapters = regexChapters;
      }
    }
  } else if (!isMarkdown && blocks.length > 0) {
    const hSplit =
      splitBlocksByHeadingLevel(blocks, 1, title) ||
      splitBlocksByHeadingLevel(blocks, 2, title);
    if (hSplit) {
      chapters = hSplit;
      structuralSplitUsed = true;
      detectedRuleId = undefined;
    } else {
      chapters = splitTextByRule(cleanText, bestRule.pattern, bestRule.flags, title);
    }
  } else {
    chapters = splitTextByRule(cleanText, bestRule.pattern, bestRule.flags, title);
  }

  return {
    title,
    author: 'Khuyết danh',
    description: '',
    format: isMarkdown ? 'MD' : 'HTML',
    sourceFileName: file.name,
    fileSize: file.size,
    rawText: cleanText,
    detectedRuleId,
    structuralSplitUsed,
    chapters,
  };
}
