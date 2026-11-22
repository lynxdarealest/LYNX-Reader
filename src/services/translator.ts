import { Chapter, ChapterTranslation, DictionaryEntry } from '../types';
import {
  computeDictionarySignature,
  escapeRegExp,
  mergeDictionariesByPrecedence,
} from './dictionary';

export const TRANSLATION_SEGMENT_DELIMITER = '=|==|=';
const MAX_CHUNK_CHARS = 6000;
const MAX_CHUNK_SEGMENTS = 35;

export interface PreparedTranslationSegments {
  tokenizedSegments: string[];
  tokenPrefix: string;
  tokenToReplacement: Map<string, string>;
  expectedCountsPerSegment: Array<Map<string, number>>;
}

export interface TranslationProgress {
  completedChunks: number;
  totalChunks: number;
}

export interface BookTranslationProgress {
  completedChapters: number;
  totalChapters: number;
  currentChapterNumber: number;
  currentChapterTitle: string;
  chunkProgress?: TranslationProgress | null;
}

export type TranslationTransport = (
  joinedPayload: string,
  signal?: AbortSignal
) => Promise<string>;

export function hasCJKCharacters(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff]/.test(text);
}

/**
 * Fast deterministic fingerprint of a chapter's original title and content.
 */
export function computeChapterSourceHash(title: string, content: string): string {
  const input = `${title}\u0000${content}`;
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}-${input.length}`;
}

export function isTranslationStale(
  chapter: Pick<Chapter, 'title' | 'content'>,
  translation: ChapterTranslation | null | undefined
): boolean {
  if (!translation) return false;
  return (
    translation.sourceTitle !== chapter.title ||
    translation.sourceContent !== chapter.content
  );
}

/**
 * Generate a collision-free uppercase alphanumeric token prefix that never appears in input or replacements.
 */
function generateSafePrefix(segments: string[], replacements: string[]): string {
  const combined = segments.join('\n') + '\n' + replacements.join('\n');
  for (let attempt = 0; attempt < 20; attempt++) {
    const rand = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 4).padEnd(4, 'X');
    const candidate = `LYNX${rand}`;
    if (!combined.includes(candidate)) {
      return candidate;
    }
  }
  return `LYNX${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Merge global + book dictionaries (book wins on duplicate original, longest-first),
 * preserve literal `=|==|=` delimiter if present, and replace phrases with unique tokens in a single pass.
 */
export function prepareTranslationSegments(
  segments: string[],
  globalEntries: DictionaryEntry[],
  bookEntries: DictionaryEntry[]
): PreparedTranslationSegments {
  const merged = mergeDictionariesByPrecedence(globalEntries, bookEntries);
  const tokenPrefix = generateSafePrefix(
    segments,
    merged.map((m) => m.replacement)
  );

  const tokenToReplacement = new Map<string, string>();
  const phraseToToken = new Map<string, string>();
  let counter = 0;

  // Assign token for literal delimiter `=|==|=` if any segment contains it
  const hasDelimiter = segments.some((s) => s.includes(TRANSLATION_SEGMENT_DELIMITER));
  const candidates: string[] = [];

  if (hasDelimiter) {
    const delimToken = `${tokenPrefix}0000Z`;
    counter++;
    tokenToReplacement.set(delimToken, TRANSLATION_SEGMENT_DELIMITER);
    phraseToToken.set(TRANSLATION_SEGMENT_DELIMITER, delimToken);
    candidates.push(TRANSLATION_SEGMENT_DELIMITER);
  }

  for (const entry of merged) {
    const orig = entry.original;
    if (!orig) continue;
    // Note: if delimiter token already took `=|==|=`, book entry won't break delimiter splitting
    if (orig === TRANSLATION_SEGMENT_DELIMITER) {
      const existingToken = phraseToToken.get(TRANSLATION_SEGMENT_DELIMITER);
      if (existingToken) tokenToReplacement.set(existingToken, entry.replacement);
      continue;
    }
    const token = `${tokenPrefix}${String(counter++).padStart(4, '0')}Z`;
    tokenToReplacement.set(token, entry.replacement);
    phraseToToken.set(orig, token);
    candidates.push(orig);
  }

  // Sort all patterns longest-first so overlapping terms match the longest one first
  candidates.sort((a, b) => b.length - a.length);

  const expectedCountsPerSegment: Array<Map<string, number>> = [];
  if (candidates.length === 0) {
    for (let i = 0; i < segments.length; i++) {
      expectedCountsPerSegment.push(new Map());
    }
    return {
      tokenizedSegments: [...segments],
      tokenPrefix,
      tokenToReplacement,
      expectedCountsPerSegment,
    };
  }

  const combinedRegex = new RegExp(candidates.map(escapeRegExp).join('|'), 'g');
  const tokenizedSegments = segments.map((seg) => {
    const counts = new Map<string, number>();
    const out = seg.replace(combinedRegex, (matched) => {
      const tok = phraseToToken.get(matched);
      if (!tok) return matched;
      counts.set(tok, (counts.get(tok) || 0) + 1);
      return tok;
    });
    expectedCountsPerSegment.push(counts);
    return out;
  });

  return {
    tokenizedSegments,
    tokenPrefix,
    tokenToReplacement,
    expectedCountsPerSegment,
  };
}

/**
 * Validate translated response segments and token integrity, then restore dictionary replacements.
 */
export function restoreAndValidateTranslatedSegments(
  rawResponse: string,
  expectedSegmentCount: number,
  prepared: PreparedTranslationSegments,
  segmentOffset = 0
): string[] {
  if (!rawResponse || !rawResponse.trim()) {
    throw new Error('Dịch vụ dịch trả về phản hồi rỗng. Bản dịch chưa được lưu.');
  }

  const trimmed = rawResponse.trim();
  if (/^\s*<!doctype html/i.test(trimmed) || trimmed.includes('_cf_chl_opt')) {
    throw new Error(
      'Máy chủ dịch đang yêu cầu xác minh bảo mật nên phản hồi không hợp lệ. Vui lòng thử lại sau.'
    );
  }

  const rawParts = rawResponse.split(TRANSLATION_SEGMENT_DELIMITER);
  if (rawParts.length !== expectedSegmentCount) {
    throw new Error(
      `Phản hồi dịch không hợp lệ: số đoạn nhận được (${rawParts.length}) không khớp số đoạn đã gửi (${expectedSegmentCount}).`
    );
  }

  const { tokenPrefix, tokenToReplacement, expectedCountsPerSegment } = prepared;
  const allTokens = Array.from(tokenToReplacement.keys());
  const restoreRegex =
    allTokens.length > 0 ? new RegExp(allTokens.map(escapeRegExp).join('|'), 'g') : null;
  const anyPrefixMatchRegex = new RegExp(`${escapeRegExp(tokenPrefix)}[0-9A-Za-z]*`, 'gi');

  const restoredSegments: string[] = [];

  for (let i = 0; i < rawParts.length; i++) {
    const translatedSeg = rawParts[i];
    const expectedMap = expectedCountsPerSegment[segmentOffset + i] || new Map<string, number>();

    // Verify no altered/truncated/case-mutated token artifacts exist
    const foundTokens = translatedSeg.match(anyPrefixMatchRegex) || [];
    const foundCounts = new Map<string, number>();
    for (const tok of foundTokens) {
      if (!expectedMap.has(tok)) {
        throw new Error(
          `Dịch vụ dịch đã làm thay đổi hoặc sai lệch từ khóa giữ chỗ ("${tok}"). Bản dịch chưa được lưu, vui lòng thử lại.`
        );
      }
      foundCounts.set(tok, (foundCounts.get(tok) || 0) + 1);
    }

    // Verify exact count for every expected token in this segment
    for (const [tok, expectedCount] of expectedMap.entries()) {
      const actualCount = foundCounts.get(tok) || 0;
      if (actualCount !== expectedCount) {
        throw new Error(
          `Dịch vụ dịch đã làm mất hoặc thay đổi số lần xuất hiện của từ khóa giữ chỗ (${tok}: cần ${expectedCount}, nhận ${actualCount}). Bản dịch chưa được lưu, vui lòng thử lại.`
        );
      }
    }

    // Replace tokens cleanly in one pass
    const restored = restoreRegex
      ? translatedSeg.replace(restoreRegex, (tok) => tokenToReplacement.get(tok) ?? tok)
      : translatedSeg;

    restoredSegments.push(restored);
  }

  return restoredSegments;
}

/**
 * Default transport using Electron desktop IPC if available, else same-origin `/api/translate`.
 */
export const defaultTranslationTransport: TranslationTransport = async (
  joinedPayload: string,
  signal?: AbortSignal
): Promise<string> => {
  if (typeof window !== 'undefined' && window.desktopBridge?.translate) {
    if (signal?.aborted) {
      throw new Error('Đã hủy yêu cầu dịch.');
    }
    return await window.desktopBridge.translate(joinedPayload);
  }

  const body = new URLSearchParams({
    sajax: 'trans',
    content: joinedPayload,
  }).toString();

  let resp: Response;
  try {
    resp = await fetch('/api/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body,
      signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('Đã hủy yêu cầu dịch.');
    }
    throw new Error(
      'Không thể kết nối tới dịch vụ dịch. Vui lòng kiểm tra kết nối Internet.'
    );
  }

  const text = await resp.text();

  if (!resp.ok) {
    let msg = `Lỗi dịch vụ dịch (HTTP ${resp.status}).`;
    try {
      const json = JSON.parse(text);
      if (json && typeof json.error === 'string' && json.error.trim()) {
        msg = json.error;
      }
    } catch {
      // Non-JSON upstream error
    }
    throw new Error(msg);
  }

  return text;
};

/**
 * Translate arbitrary short segments (such as book title, author, description) while preserving dictionary terms.
 */
export async function translateTextSegments(params: {
  segments: string[];
  globalEntries: DictionaryEntry[];
  bookEntries?: DictionaryEntry[];
  transport?: TranslationTransport;
  signal?: AbortSignal;
}): Promise<string[]> {
  const {
    segments,
    globalEntries,
    bookEntries = [],
    transport = defaultTranslationTransport,
    signal,
  } = params;

  const nonEmptyIndices: number[] = [];
  const nonEmptyTexts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] && segments[i].trim().length > 0) {
      nonEmptyIndices.push(i);
      nonEmptyTexts.push(segments[i]);
    }
  }
  if (nonEmptyTexts.length === 0) return [...segments];

  const prepared = prepareTranslationSegments(nonEmptyTexts, globalEntries, bookEntries);
  const joined = prepared.tokenizedSegments.join(TRANSLATION_SEGMENT_DELIMITER);
  const rawResponse = await transport(joined, signal);
  const restored = restoreAndValidateTranslatedSegments(
    rawResponse,
    nonEmptyTexts.length,
    prepared,
    0
  );

  const output = [...segments];
  for (let i = 0; i < nonEmptyIndices.length; i++) {
    output[nonEmptyIndices[i]] = (restored[i] ?? output[nonEmptyIndices[i]]).trim();
  }
  return output;
}

/**
 * Translate a full chapter while preserving LYNX Reader dictionary names/terms.
 */
export async function translateChapter(params: {
  chapter: Chapter;
  globalEntries: DictionaryEntry[];
  bookEntries: DictionaryEntry[];
  transport?: TranslationTransport;
  onProgress?: (progress: TranslationProgress) => void;
  signal?: AbortSignal;
}): Promise<ChapterTranslation> {
  const {
    chapter,
    globalEntries,
    bookEntries,
    transport = defaultTranslationTransport,
    onProgress,
    signal,
  } = params;

  const sourceTitle = chapter.title;
  const sourceContent = chapter.content;
  const normalizedContent = sourceContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = normalizedContent.split('\n');

  // Track which lines are non-empty so blank lines remain untouched
  const nonEmptyLineIndices: number[] = [];
  const lineSegments: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].trim().length > 0) {
      nonEmptyLineIndices.push(i);
      lineSegments.push(rawLines[i]);
    }
  }

  const hasTitle = sourceTitle.trim().length > 0;
  const segmentsToTranslate = hasTitle ? [sourceTitle, ...lineSegments] : [...lineSegments];

  if (segmentsToTranslate.length === 0) {
    throw new Error('Chương hiện tại không có nội dung để dịch.');
  }

  const prepared = prepareTranslationSegments(
    segmentsToTranslate,
    globalEntries,
    bookEntries
  );

  // Split into safe chunks under character & segment limits
  const chunks: Array<{ startOffset: number; segments: string[] }> = [];
  let cursor = 0;
  while (cursor < prepared.tokenizedSegments.length) {
    const chunkSegs: string[] = [];
    let charCount = 0;
    const startOffset = cursor;

    while (cursor < prepared.tokenizedSegments.length) {
      const seg = prepared.tokenizedSegments[cursor];
      const addedLen = seg.length + (chunkSegs.length > 0 ? TRANSLATION_SEGMENT_DELIMITER.length : 0);
      if (
        chunkSegs.length > 0 &&
        (charCount + addedLen > MAX_CHUNK_CHARS || chunkSegs.length >= MAX_CHUNK_SEGMENTS)
      ) {
        break;
      }
      chunkSegs.push(seg);
      charCount += addedLen;
      cursor++;
    }

    chunks.push({ startOffset, segments: chunkSegs });
  }

  const translatedAllSegments: string[] = [];

  for (let c = 0; c < chunks.length; c++) {
    if (signal?.aborted) {
      throw new Error('Đã hủy yêu cầu dịch.');
    }

    onProgress?.({
      completedChunks: c,
      totalChunks: chunks.length,
    });

    const chunk = chunks[c];
    const joined = chunk.segments.join(TRANSLATION_SEGMENT_DELIMITER);
    const rawResponse = await transport(joined, signal);
    const restoredChunk = restoreAndValidateTranslatedSegments(
      rawResponse,
      chunk.segments.length,
      prepared,
      chunk.startOffset
    );
    translatedAllSegments.push(...restoredChunk);

    onProgress?.({
      completedChunks: c + 1,
      totalChunks: chunks.length,
    });
  }

  const translatedTitle = hasTitle ? translatedAllSegments[0] : sourceTitle;
  const translatedLineValues = hasTitle
    ? translatedAllSegments.slice(1)
    : translatedAllSegments;

  const rebuiltLines = [...rawLines];
  for (let i = 0; i < nonEmptyLineIndices.length; i++) {
    rebuiltLines[nonEmptyLineIndices[i]] = translatedLineValues[i] ?? rebuiltLines[nonEmptyLineIndices[i]];
  }

  const mergedDict = mergeDictionariesByPrecedence(globalEntries, bookEntries);

  return {
    chapterId: chapter.id,
    bookId: chapter.bookId,
    chapterIndex: chapter.chapterIndex,
    translatedTitle: translatedTitle.trim() || sourceTitle,
    translatedContent: rebuiltLines.join('\n'),
    sourceTitle,
    sourceContent,
    sourceHash: computeChapterSourceHash(sourceTitle, sourceContent),
    dictionarySignature: computeDictionarySignature(mergedDict),
    provider: 'lynx',
    translatedAt: Date.now(),
  };
}

/**
 * Unified whole-book translation helper used by ReaderView, ImportModal (pre-confirm), and BookDetailModal.
 * Automatically translates missing/stale chapters first; if all chapters are already translated, re-translates all chapters.
 */
export async function translateBookChapters(params: {
  chapters: Chapter[];
  existingTranslations?: ChapterTranslation[];
  globalEntries: DictionaryEntry[];
  bookEntries: DictionaryEntry[];
  startFromChapterId?: string;
  retranslateAll?: boolean;
  transport?: TranslationTransport;
  signal?: AbortSignal;
  onProgress?: (progress: BookTranslationProgress) => void;
  onChapterTranslated?: (
    translation: ChapterTranslation,
    meta: { completed: number; total: number; savedCount: number }
  ) => void | Promise<void>;
}): Promise<{ completed: number; total: number; translations: ChapterTranslation[]; savedCount: number }> {
  const {
    chapters,
    existingTranslations = [],
    globalEntries,
    bookEntries,
    startFromChapterId,
    retranslateAll = false,
    transport,
    signal,
    onProgress,
    onChapterTranslated,
  } = params;

  const validChapters = chapters.filter(
    (ch) => ch.id && ch.id !== 'empty' && ch.content.trim().length > 0
  );
  if (validChapters.length === 0) {
    throw new Error('Truyện chưa có nội dung để dịch.');
  }

  const startPos = startFromChapterId
    ? Math.max(0, validChapters.findIndex((c) => c.id === startFromChapterId))
    : 0;
  const orderedChapters = [
    ...validChapters.slice(startPos),
    ...validChapters.slice(0, startPos),
  ];

  const existingMap = new Map(existingTranslations.map((t) => [t.chapterId, t]));
  const pendingChapters = orderedChapters.filter((ch) => {
    const existing = existingMap.get(ch.id);
    return !existing || isTranslationStale(ch, existing);
  });

  // Single unified "Dịch" rule:
  // If any chapters need translation (new or source-edited), translate those;
  // otherwise (all chapters already translated), re-translate all chapters cleanly.
  const queue =
    retranslateAll || pendingChapters.length === 0 ? orderedChapters : pendingChapters;

  const savedIds = new Set(existingTranslations.map((t) => t.chapterId));
  const translations: ChapterTranslation[] = [];
  let completed = 0;

  onProgress?.({
    completedChapters: 0,
    totalChapters: queue.length,
    currentChapterNumber: (queue[0]?.chapterIndex ?? 0) + 1,
    currentChapterTitle: queue[0]?.title || '',
    chunkProgress: null,
  });

  for (let i = 0; i < queue.length; i++) {
    if (signal?.aborted) {
      throw new Error('Đã hủy yêu cầu dịch.');
    }

    const ch = queue[i];
    onProgress?.({
      completedChapters: completed,
      totalChapters: queue.length,
      currentChapterNumber: ch.chapterIndex + 1,
      currentChapterTitle: ch.title,
      chunkProgress: null,
    });

    let result: ChapterTranslation | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) {
        throw new Error('Đã hủy yêu cầu dịch.');
      }
      try {
        result = await translateChapter({
          chapter: ch,
          globalEntries,
          bookEntries,
          transport,
          onProgress: (chunkProg) => {
            onProgress?.({
              completedChapters: completed,
              totalChapters: queue.length,
              currentChapterNumber: ch.chapterIndex + 1,
              currentChapterTitle: ch.title,
              chunkProgress: chunkProg,
            });
          },
          signal,
        });
        break;
      } catch (err: any) {
        if (signal?.aborted || err?.message?.includes('Đã hủy')) {
          throw err;
        }
        lastErr = err;
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }

    if (!result) {
      throw lastErr || new Error(`Không thể dịch chương ${ch.chapterIndex + 1}`);
    }

    completed++;
    savedIds.add(result.chapterId);
    translations.push(result);

    if (onChapterTranslated) {
      await onChapterTranslated(result, {
        completed,
        total: queue.length,
        savedCount: savedIds.size,
      });
    }

    onProgress?.({
      completedChapters: completed,
      totalChapters: queue.length,
      currentChapterNumber: ch.chapterIndex + 1,
      currentChapterTitle: ch.title,
      chunkProgress: null,
    });
  }

  return {
    completed,
    total: queue.length,
    translations,
    savedCount: savedIds.size,
  };
}
