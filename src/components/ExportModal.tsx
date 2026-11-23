import React from 'react';
import {
  X,
  Download,
  FileText,
  BookOpen,
  Code2,
  Check,
  AlertCircle,
  Loader2,
  Languages,
  FileCode2,
  ListTree,
  RotateCcw,
} from 'lucide-react';
import { Book, Chapter, ChapterTranslation } from '../types';
import {
  ExportFormat,
  ExportContentMode,
  UntranslatedBehavior,
  buildExportFilename,
  exportBook,
} from '../services/exporter';
import { getBookTranslations } from '../services/storage';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  book: Book;
  chapters: Chapter[];
  currentChapterIndex?: number;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  book,
  chapters,
  currentChapterIndex,
}) => {
  const sortedChapters = React.useMemo(
    () => [...chapters].sort((a, b) => a.chapterIndex - b.chapterIndex),
    [chapters]
  );
  const totalCount = sortedChapters.length;

  const [format, setFormat] = React.useState<ExportFormat>('EPUB');
  const [contentMode, setContentMode] = React.useState<ExportContentMode>('translated');
  const [untranslatedBehavior, setUntranslatedBehavior] =
    React.useState<UntranslatedBehavior>('fallback-original');
  const [rangeStart, setRangeStart] = React.useState<number>(1);
  const [rangeEnd, setRangeEnd] = React.useState<number>(Math.max(1, totalCount));

  const [exportTitle, setExportTitle] = React.useState(book.title);
  const [exportAuthor, setExportAuthor] = React.useState(book.author || '');
  const [exportDescription, setExportDescription] = React.useState(book.description || '');

  const [includeToc, setIncludeToc] = React.useState(true);
  const [includeIntro, setIncludeIntro] = React.useState(true);

  const [translationMap, setTranslationMap] = React.useState<Map<string, ChapterTranslation>>(
    () => new Map()
  );
  const [isLoadingTranslations, setIsLoadingTranslations] = React.useState(false);
  const [isExporting, setIsExporting] = React.useState(false);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Initialize state whenever modal opens or book changes
  React.useEffect(() => {
    if (!isOpen) return;
    setExportTitle(book.title || '');
    setExportAuthor(book.author || '');
    setExportDescription(book.description || '');
    setRangeStart(1);
    setRangeEnd(Math.max(1, totalCount));
    setIncludeToc(true);
    setIncludeIntro(true);
    setUntranslatedBehavior('fallback-original');
    setError(null);
    setSuccessMessage(null);
    setIsLoadingTranslations(true);

    getBookTranslations(book.id)
      .then((list) => {
        const map = new Map<string, ChapterTranslation>();
        for (const item of list) {
          if (item.translatedContent && item.translatedContent.trim()) {
            map.set(item.chapterId, item);
          }
        }
        setTranslationMap(map);
        setContentMode(map.size > 0 ? 'translated' : 'original');
      })
      .catch(() => {
        setTranslationMap(new Map());
        setContentMode('original');
      })
      .finally(() => {
        setIsLoadingTranslations(false);
      });
  }, [isOpen, book.id, book.title, book.author, book.description, totalCount]);

  // Clear stale feedback whenever user modifies options
  React.useEffect(() => {
    setSuccessMessage(null);
    setError(null);
  }, [
    format,
    contentMode,
    untranslatedBehavior,
    rangeStart,
    rangeEnd,
    exportTitle,
    exportAuthor,
    exportDescription,
    includeToc,
    includeIntro,
  ]);

  if (!isOpen) return null;

  const safeStart = Math.min(Math.max(1, rangeStart), Math.max(1, totalCount));
  const safeEnd = Math.min(Math.max(safeStart, rangeEnd), Math.max(1, totalCount));
  const slicedChapters =
    totalCount > 0 ? sortedChapters.slice(safeStart - 1, safeEnd) : [];

  const translatedTotalCount = translationMap.size;
  const translatedInRange = slicedChapters.filter((ch) => translationMap.has(ch.id)).length;
  const untranslatedInRange = slicedChapters.length - translatedInRange;

  const effectiveChaptersPreviewCount =
    contentMode === 'translated' && untranslatedBehavior === 'skip'
      ? translatedInRange
      : slicedChapters.length;

  const totalWordsInRange = slicedChapters.reduce((acc, ch) => {
    if (contentMode === 'translated') {
      const tr = translationMap.get(ch.id);
      if (tr) {
        const words = tr.translatedContent.trim().split(/\s+/).filter(Boolean).length;
        return acc + words;
      }
      if (untranslatedBehavior === 'skip') return acc;
    }
    return acc + (ch.wordCount || 0);
  }, 0);

  const activePos = Math.min(
    Math.max(1, (currentChapterIndex ?? book.currentChapterIndex ?? 0) + 1),
    Math.max(1, totalCount)
  );

  const isMetadataModified =
    exportTitle !== (book.title || '') ||
    exportAuthor !== (book.author || '') ||
    exportDescription !== (book.description || '');

  const previewFilename = buildExportFilename(
    exportTitle.trim() || book.title,
    format,
    contentMode
  );

  const handleStartChange = (val: number) => {
    const clamped = Math.min(Math.max(1, val || 1), Math.max(1, totalCount));
    setRangeStart(clamped);
    if (clamped > rangeEnd) {
      setRangeEnd(clamped);
    }
  };

  const handleEndChange = (val: number) => {
    const clamped = Math.min(Math.max(1, val || 1), Math.max(1, totalCount));
    setRangeEnd(clamped);
    if (clamped < rangeStart) {
      setRangeStart(clamped);
    }
  };

  const handleExport = async () => {
    if (totalCount === 0 || slicedChapters.length === 0) {
      setError('Không có chương nào trong phạm vi đã chọn.');
      return;
    }
    if (
      contentMode === 'translated' &&
      untranslatedBehavior === 'skip' &&
      translatedInRange === 0
    ) {
      setError('Phạm vi đã chọn chưa có chương nào được dịch.');
      return;
    }

    setIsExporting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      let chaptersToExport: Chapter[];

      if (contentMode === 'original') {
        chaptersToExport = slicedChapters.map((ch) => ({
          ...ch,
          title: ch.title,
          content: ch.content,
        }));
      } else {
        const latestList = await getBookTranslations(book.id);
        const latestMap = new Map<string, ChapterTranslation>();
        for (const item of latestList) {
          if (item.translatedContent && item.translatedContent.trim()) {
            latestMap.set(item.chapterId, item);
          }
        }

        const resolved: Chapter[] = [];
        for (const ch of slicedChapters) {
          const tr = latestMap.get(ch.id);
          if (tr) {
            resolved.push({
              ...ch,
              title: tr.translatedTitle || ch.title,
              content: tr.translatedContent,
            });
          } else if (untranslatedBehavior === 'fallback-original') {
            resolved.push(ch);
          }
        }
        chaptersToExport = resolved;
      }

      if (chaptersToExport.length === 0) {
        setError('Không có chương hợp lệ để xuất.');
        return;
      }

      const rangeLabel =
        safeStart === 1 && safeEnd === totalCount
          ? `Toàn bộ (Chương 1 – ${totalCount})`
          : safeStart === safeEnd
          ? `Chương ${safeStart}`
          : `Chương ${safeStart} – ${safeEnd}`;

      const result = await exportBook(book, chaptersToExport, {
        format,
        contentMode,
        title: exportTitle.trim() || book.title,
        author: exportAuthor.trim(),
        description: exportDescription.trim(),
        includeTableOfContents: includeToc,
        includeIntroduction: includeIntro,
        rangeLabel,
      });

      setSuccessMessage(
        `Đã xuất ${result.chapterCount} chương ra file "${result.filename}".`
      );
    } catch (err: any) {
      setError(err?.message || 'Không thể xuất file truyện.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-2xl w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden select-none animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="px-5 py-3 border-b border-neutral-800 flex items-center justify-between bg-neutral-950 shrink-0">
          <div className="flex items-center space-x-2">
            <Download className="w-4 h-4 text-amber-500" />
            <h2 className="text-sm font-bold text-neutral-100">Xuất file truyện</h2>
            <span className="text-[11px] text-neutral-500 font-mono">
              ({totalCount} chương)
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {/* 1. Content Mode: Original vs Translated */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-neutral-200 font-semibold flex items-center space-x-1.5">
                <Languages className="w-3.5 h-3.5 text-amber-400" />
                <span>1. Chế độ nội dung xuất</span>
              </label>
              {isLoadingTranslations ? (
                <span className="text-[11px] text-neutral-400 flex items-center space-x-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Đang kiểm tra bản dịch...</span>
                </span>
              ) : (
                <span className="text-[11px] text-neutral-400 font-mono">
                  Đã dịch {translatedTotalCount}/{totalCount} chương
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setContentMode('original')}
                className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                  contentMode === 'original'
                    ? 'bg-amber-600/15 border-amber-500 text-amber-100 shadow-sm'
                    : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:border-neutral-700'
                }`}
              >
                <div className="font-bold text-xs text-neutral-100">Text gốc (Nguyên văn)</div>
                <div className="text-[11px] text-neutral-400 mt-0.5">
                  Xuất nguyên bản tiếng gốc trong thư viện
                </div>
              </button>

              <button
                type="button"
                onClick={() => setContentMode('translated')}
                className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                  contentMode === 'translated'
                    ? 'bg-emerald-600/15 border-emerald-500 text-emerald-100 shadow-sm'
                    : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:border-neutral-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-neutral-100">Text dịch (Tiếng Việt)</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                      translatedTotalCount > 0
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-700/50'
                        : 'bg-neutral-800 text-neutral-400'
                    }`}
                  >
                    {translatedTotalCount}/{totalCount}
                  </span>
                </div>
                <div className="text-[11px] text-neutral-400 mt-0.5">
                  Dùng các bản dịch đã lưu &amp; chỉnh sửa
                </div>
              </button>
            </div>

            {contentMode === 'translated' && untranslatedInRange > 0 && (
              <div className="p-3 rounded-xl bg-amber-950/25 border border-amber-700/40 space-y-2">
                <div className="text-[11px] text-amber-200">
                  Trong phạm vi đã chọn có{' '}
                  <strong className="font-mono">{untranslatedInRange}/{slicedChapters.length}</strong>{' '}
                  chương chưa có bản dịch:
                </div>
                <div className="flex flex-wrap gap-3 text-[11px] text-neutral-200">
                  <label className="flex items-center space-x-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="untranslatedBehavior"
                      checked={untranslatedBehavior === 'fallback-original'}
                      onChange={() => setUntranslatedBehavior('fallback-original')}
                      className="accent-amber-500"
                    />
                    <span>Giữ text gốc cho chương chưa dịch</span>
                  </label>
                  <label className="flex items-center space-x-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="untranslatedBehavior"
                      checked={untranslatedBehavior === 'skip'}
                      onChange={() => setUntranslatedBehavior('skip')}
                      className="accent-amber-500"
                    />
                    <span>Chỉ xuất {translatedInRange} chương đã dịch</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* 2. Chapter Range Selection */}
          <div className="space-y-2.5 p-3.5 rounded-xl bg-neutral-950 border border-neutral-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-neutral-200 font-semibold">
                2. Phạm vi chương xuất
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setRangeStart(1);
                    setRangeEnd(Math.max(1, totalCount));
                  }}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer border transition-colors ${
                    safeStart === 1 && safeEnd === totalCount
                      ? 'bg-amber-600/20 border-amber-500/60 text-amber-300'
                      : 'bg-neutral-900 border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                  }`}
                >
                  Toàn bộ (1–{totalCount})
                </button>
                {activePos > 1 && activePos <= totalCount && (
                  <button
                    type="button"
                    onClick={() => {
                      setRangeStart(activePos);
                      setRangeEnd(totalCount);
                    }}
                    className="px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer bg-neutral-900 border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                  >
                    Từ đang đọc (#{activePos}–{totalCount})
                  </button>
                )}
                {totalCount > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setRangeStart(activePos);
                      setRangeEnd(activePos);
                    }}
                    className="px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer bg-neutral-900 border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                  >
                    Chỉ chương #{activePos}
                  </button>
                )}
              </div>
            </div>

            {totalCount === 0 ? (
              <p className="text-neutral-500 text-[11px]">Truyện chưa có chương nào.</p>
            ) : totalCount <= 400 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-neutral-400 mb-1">Từ chương</label>
                  <select
                    value={safeStart}
                    onChange={(e) => handleStartChange(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-neutral-100 focus:outline-none focus:border-amber-500"
                  >
                    {sortedChapters.map((ch, idx) => (
                      <option key={ch.id} value={idx + 1}>
                        #{idx + 1} - {ch.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-neutral-400 mb-1">Đến chương</label>
                  <select
                    value={safeEnd}
                    onChange={(e) => handleEndChange(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-neutral-100 focus:outline-none focus:border-amber-500"
                  >
                    {sortedChapters.map((ch, idx) => (
                      <option key={ch.id} value={idx + 1} disabled={idx + 1 < safeStart}>
                        #{idx + 1} - {ch.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-neutral-400 mb-1">Từ chương (1–{totalCount})</label>
                  <input
                    type="number"
                    min={1}
                    max={totalCount}
                    value={safeStart}
                    onChange={(e) => handleStartChange(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-neutral-100 font-mono focus:outline-none focus:border-amber-500"
                  />
                  <p className="text-[10px] text-neutral-500 truncate mt-1">
                    {sortedChapters[safeStart - 1]?.title}
                  </p>
                </div>
                <div>
                  <label className="block text-[11px] text-neutral-400 mb-1">Đến chương ({safeStart}–{totalCount})</label>
                  <input
                    type="number"
                    min={safeStart}
                    max={totalCount}
                    value={safeEnd}
                    onChange={(e) => handleEndChange(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-neutral-100 font-mono focus:outline-none focus:border-amber-500"
                  />
                  <p className="text-[10px] text-neutral-500 truncate mt-1">
                    {sortedChapters[safeEnd - 1]?.title}
                  </p>
                </div>
              </div>
            )}

            <div className="text-[11px] text-neutral-400 font-mono pt-0.5">
              Sẽ xuất <strong className="text-amber-300">{effectiveChaptersPreviewCount}</strong> chương • ~{totalWordsInRange.toLocaleString()} từ
            </div>
          </div>

          {/* 3. Format Selection (Cross-app compatible) */}
          <div className="space-y-2">
            <label className="text-neutral-200 font-semibold block">
              3. Định dạng xuất (tương thích app khác)
            </label>
            <div className="grid grid-cols-3 gap-2.5">
              <button
                type="button"
                onClick={() => setFormat('EPUB')}
                className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                  format === 'EPUB'
                    ? 'bg-amber-600/15 border-amber-500 text-amber-200 shadow-sm'
                    : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:border-neutral-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm text-neutral-100">EPUB</span>
                  <BookOpen className="w-4 h-4 text-amber-500" />
                </div>
                <div className="text-[10px] text-neutral-400 mt-1">
                  Apple Books, Kindle, Play Books, Moon+, Calibre
                </div>
              </button>

              <button
                type="button"
                onClick={() => setFormat('TXT')}
                className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                  format === 'TXT'
                    ? 'bg-amber-600/15 border-amber-500 text-amber-200 shadow-sm'
                    : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:border-neutral-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm text-neutral-100">TXT</span>
                  <FileText className="w-4 h-4 text-amber-500" />
                </div>
                <div className="text-[10px] text-neutral-400 mt-1">
                  UTF-8 có BOM, mọi trình đọc chữ &amp; TTS
                </div>
              </button>

              <button
                type="button"
                onClick={() => setFormat('HTML')}
                className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                  format === 'HTML'
                    ? 'bg-amber-600/15 border-amber-500 text-amber-200 shadow-sm'
                    : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:border-neutral-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm text-neutral-100">HTML</span>
                  <Code2 className="w-4 h-4 text-amber-500" />
                </div>
                <div className="text-[10px] text-neutral-400 mt-1">
                  Mở trực tiếp bằng trình duyệt, Word, Docs
                </div>
              </button>
            </div>
          </div>

          {/* 4. Editable Metadata for Export */}
          <div className="space-y-2.5 p-3.5 rounded-xl bg-neutral-950 border border-neutral-800">
            <div className="flex items-center justify-between">
              <label className="text-neutral-200 font-semibold flex items-center space-x-1.5">
                <FileCode2 className="w-3.5 h-3.5 text-amber-400" />
                <span>4. Thông tin tác phẩm khi xuất (có thể chỉnh sửa)</span>
              </label>
              {isMetadataModified && (
                <button
                  type="button"
                  onClick={() => {
                    setExportTitle(book.title || '');
                    setExportAuthor(book.author || '');
                    setExportDescription(book.description || '');
                  }}
                  className="flex items-center space-x-1 text-[10px] text-amber-400 hover:text-amber-300 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Khôi phục</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] text-neutral-400 mb-1">Tên tác phẩm</label>
                <input
                  type="text"
                  value={exportTitle}
                  onChange={(e) => setExportTitle(e.target.value)}
                  placeholder="Nhập tên tác phẩm..."
                  className="w-full px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-neutral-100 focus:outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-[11px] text-neutral-400 mb-1">Tác giả</label>
                <input
                  type="text"
                  value={exportAuthor}
                  onChange={(e) => setExportAuthor(e.target.value)}
                  placeholder="Khuyết danh"
                  className="w-full px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-neutral-100 focus:outline-none focus:border-amber-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-neutral-400 mb-1">Giới thiệu truyện</label>
              <textarea
                rows={3}
                value={exportDescription}
                onChange={(e) => setExportDescription(e.target.value)}
                placeholder="Nhập văn án / giới thiệu truyện (nếu muốn kèm vào file xuất)..."
                className="w-full px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-neutral-100 focus:outline-none focus:border-amber-500 resize-y"
              />
            </div>
          </div>

          {/* 5. Attachments: TOC & Introduction */}
          <div className="space-y-2 p-3.5 rounded-xl bg-neutral-950 border border-neutral-800">
            <label className="text-neutral-200 font-semibold flex items-center space-x-1.5">
              <ListTree className="w-3.5 h-3.5 text-amber-400" />
              <span>5. Đính kèm trong file xuất</span>
            </label>

            <div className="space-y-2 pt-1">
              <label className="flex items-start space-x-2.5 cursor-pointer text-neutral-200">
                <input
                  type="checkbox"
                  checked={includeToc}
                  onChange={(e) => setIncludeToc(e.target.checked)}
                  className="accent-amber-500 mt-0.5 rounded"
                />
                <span>
                  <strong className="text-neutral-100">Đính kèm trang Mục lục</strong>
                  <span className="block text-[11px] text-neutral-400">
                    Thêm trang danh sách chương có liên kết bấm nhảy tới từng chương (EPUB/HTML) hoặc mục lục đầu file (TXT). EPUB vẫn luôn kèm chỉ mục hệ thống cho mọi app đọc.
                  </span>
                </span>
              </label>

              <label className="flex items-start space-x-2.5 cursor-pointer text-neutral-200">
                <input
                  type="checkbox"
                  checked={includeIntro}
                  onChange={(e) => setIncludeIntro(e.target.checked)}
                  className="accent-amber-500 mt-0.5 rounded"
                />
                <span>
                  <strong className="text-neutral-100">Đính kèm Giới thiệu truyện</strong>
                  <span className="block text-[11px] text-neutral-400">
                    Thêm trang bìa thông tin (Tên truyện, Tác giả, Phạm vi, Ảnh bìa nếu có) cùng phần văn án Giới thiệu ở đầu sách.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {error && (
            <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-800/50 text-red-300 text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          {successMessage && (
            <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-800/50 text-emerald-300 text-xs flex items-center space-x-2">
              <Check className="w-4 h-4 shrink-0 text-emerald-400" />
              <span>{successMessage}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-neutral-800 bg-neutral-950 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="text-[11px] text-neutral-500 font-mono truncate max-w-[280px]" title={previewFilename}>
            File: <span className="text-neutral-300">{previewFilename}</span>
          </div>
          <div className="flex items-center space-x-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-medium cursor-pointer"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={isExporting || effectiveChaptersPreviewCount === 0}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold shadow-md transition-colors cursor-pointer disabled:opacity-50"
            >
              {isExporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>
                {isExporting
                  ? 'Đang tạo file...'
                  : `Xuất ${effectiveChaptersPreviewCount} chương (.${format.toLowerCase()})`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
