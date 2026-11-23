import JSZip from 'jszip';
import { Book, Chapter } from '../types';

export type ExportFormat = 'EPUB' | 'TXT' | 'HTML';
export type ExportContentMode = 'original' | 'translated';
export type UntranslatedBehavior = 'fallback-original' | 'skip';

export interface ExportBookOptions {
  format: ExportFormat;
  contentMode: ExportContentMode;
  title?: string;
  author?: string;
  description?: string;
  includeTableOfContents?: boolean;
  includeIntroduction?: boolean;
  rangeLabel?: string;
  language?: string;
}

export interface ExportBookResult {
  filename: string;
  chapterCount: number;
}

function getResolvedMetadata(book: Book, options?: Partial<ExportBookOptions>) {
  const title = (options?.title !== undefined ? options.title : book.title).trim() || book.title || 'LYNX Reader';
  const author = (options?.author !== undefined ? options.author : book.author || '').trim();
  const description = (options?.description !== undefined ? options.description : book.description || '').trim();
  const includeTableOfContents = options?.includeTableOfContents ?? true;
  const includeIntroduction = options?.includeIntroduction ?? true;
  const contentMode: ExportContentMode = options?.contentMode ?? 'translated';
  const rangeLabel = (options?.rangeLabel || '').trim();
  return {
    title,
    author,
    description,
    includeTableOfContents,
    includeIntroduction,
    contentMode,
    rangeLabel,
  };
}

function detectLanguageTag(
  chapters: Chapter[],
  contentMode: ExportContentMode,
  explicitLang?: string
): string {
  if (explicitLang && /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(explicitLang.trim())) {
    return explicitLang.trim();
  }
  if (contentMode === 'translated') return 'vi';

  const sample = chapters
    .slice(0, 3)
    .map((c) => `${c.title}\n${c.content.slice(0, 800)}`)
    .join('\n')
    .slice(0, 2400);

  const kanaCount = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  if (kanaCount >= 5) return 'ja';

  const hangulCount = (sample.match(/[\uac00-\ud7af]/g) || []).length;
  if (hangulCount >= 5) return 'ko';

  const cjkCount = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjkCount >= 10) return 'zh';

  const viCount = (
    sample.match(/[ăâđêôơưĂÂĐÊÔƠƯáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/g) || []
  ).length;
  if (viCount >= 3) return 'vi';

  return 'en';
}

export function buildExportFilename(
  title: string,
  format: ExportFormat,
  contentMode?: ExportContentMode
): string {
  const base = sanitizeFilename(title);
  const modeTag = contentMode === 'original' ? ' [Gốc]' : '';
  const ext = format.toLowerCase();
  return `${base}${modeTag}.${ext}`;
}

export async function exportBook(
  book: Book,
  chapters: Chapter[],
  options: ExportBookOptions
): Promise<ExportBookResult> {
  if (options.format === 'TXT') {
    return exportBookToTXT(book, chapters, options);
  }
  if (options.format === 'HTML') {
    return exportBookToHTML(book, chapters, options);
  }
  return exportBookToEPUB(book, chapters, options);
}

/**
 * Clean up text content and format for UTF-8 TXT export (compatible with Windows Notepad, mobile readers & TTS)
 */
export function exportBookToTXT(
  book: Book,
  chapters: Chapter[],
  options?: Partial<ExportBookOptions>
): ExportBookResult {
  const sortedChapters = [...chapters].sort((a, b) => a.chapterIndex - b.chapterIndex);
  const meta = getResolvedMetadata(book, options);

  const lines: string[] = [];
  lines.push(meta.title);
  lines.push(`Tác giả: ${meta.author || 'Khuyết danh'}`);
  lines.push(`Chế độ xuất: ${meta.contentMode === 'original' ? 'Text gốc (Nguyên văn)' : 'Text dịch'}`);
  if (meta.rangeLabel) {
    lines.push(`Phạm vi: ${meta.rangeLabel}`);
  }
  lines.push(`Số chương: ${sortedChapters.length}`);
  lines.push('');

  if (meta.includeIntroduction) {
    lines.push('========================================');
    lines.push('GIỚI THIỆU TRUYỆN');
    lines.push('========================================');
    lines.push(meta.description || 'Chưa có giới thiệu truyện.');
    lines.push('');
  }

  if (meta.includeTableOfContents) {
    lines.push('========================================');
    lines.push('MỤC LỤC');
    lines.push('========================================');
    sortedChapters.forEach((ch, idx) => {
      const chTitle = (ch.title || `Chương ${idx + 1}`).trim();
      lines.push(`${idx + 1}. ${chTitle}`);
    });
    lines.push('');
  }

  lines.push('========================================');
  lines.push('');

  for (let i = 0; i < sortedChapters.length; i++) {
    const ch = sortedChapters[i];
    const chTitle = (ch.title || `Chương ${i + 1}`).trim();
    const chBody = (ch.content || '').trim();
    lines.push(chTitle);
    lines.push('');
    lines.push(chBody);
    lines.push('');
    if (i < sortedChapters.length - 1) {
      lines.push('------------------------------');
      lines.push('');
    }
  }

  const normalized = lines
    .join('\n')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\r\n');

  const filename = buildExportFilename(meta.title, 'TXT', meta.contentMode);
  const blob = new Blob(['\uFEFF', normalized], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, filename);

  return {
    filename,
    chapterCount: sortedChapters.length,
  };
}

/**
 * Generate a standalone HTML5 document with optional introduction and clickable TOC
 */
export function exportBookToHTML(
  book: Book,
  chapters: Chapter[],
  options?: Partial<ExportBookOptions>
): ExportBookResult {
  const sortedChapters = [...chapters].sort((a, b) => a.chapterIndex - b.chapterIndex);
  const meta = getResolvedMetadata(book, options);
  const lang = detectLanguageTag(sortedChapters, meta.contentMode, options?.language);

  const introSection = meta.includeIntroduction
    ? `
  <section class="card intro" id="intro">
    <h2>Giới thiệu truyện</h2>
    ${
      meta.description
        ? meta.description
            .split(/\r?\n+/)
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => `    <p>${escapeXML(p)}</p>`)
            .join('\n')
        : '    <p class="muted">Chưa có giới thiệu truyện.</p>'
    }
  </section>`
    : '';

  const tocSection = meta.includeTableOfContents
    ? `
  <nav class="card toc" id="toc" aria-label="Mục lục">
    <h2>Mục lục (${sortedChapters.length} chương)</h2>
    <ol>
${sortedChapters
  .map((ch, i) => {
    const chTitle = escapeXML((ch.title || `Chương ${i + 1}`).trim());
    return `      <li><a href="#chapter-${i + 1}">${chTitle}</a></li>`;
  })
  .join('\n')}
    </ol>
  </nav>`
    : '';

  const chaptersHtml = sortedChapters
    .map((ch, i) => {
      const chTitle = escapeXML((ch.title || `Chương ${i + 1}`).trim());
      const paragraphs = (ch.content || '')
        .split(/\r?\n+/)
        .map((p) => p.trim())
        .filter(Boolean);
      const body =
        paragraphs.length > 0
          ? paragraphs.map((p) => `      <p>${escapeXML(p)}</p>`).join('\n')
          : '      <p class="muted">(Chương trống)</p>';
      return `  <article class="chapter" id="chapter-${i + 1}">
    <h2>${chTitle}</h2>
${body}
    ${meta.includeTableOfContents ? '<p class="back-toc"><a href="#toc">↑ Về mục lục</a></p>' : ''}
  </article>`;
    })
    .join('\n\n');

  const html = `<!DOCTYPE html>
<html lang="${escapeXML(lang)}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="author" content="${escapeXML(meta.author || 'Khuyết danh')}" />
  <title>${escapeXML(meta.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      max-width: 760px;
      margin: 0 auto;
      padding: 2rem 1.25rem 4rem;
      font-family: Georgia, "Times New Roman", serif;
      line-height: 1.8;
      font-size: 18px;
    }
    header.book-header {
      text-align: center;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid rgba(128,128,128,0.28);
      margin-bottom: 2rem;
    }
    header.book-header h1 { margin: 0 0 0.4rem; font-size: 1.9rem; }
    .meta { opacity: 0.78; font-size: 0.92rem; }
    .card {
      padding: 1.25rem 1.5rem;
      border: 1px solid rgba(128,128,128,0.25);
      border-radius: 10px;
      margin-bottom: 2rem;
    }
    .toc ol {
      columns: 1;
      padding-left: 1.4rem;
      margin: 0.75rem 0 0;
    }
    .toc li { margin: 0.3rem 0; }
    .toc a, .back-toc a { text-decoration: none; color: inherit; border-bottom: 1px dotted currentColor; }
    article.chapter {
      margin-top: 2.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid rgba(128,128,128,0.2);
    }
    article.chapter h2 {
      text-align: center;
      font-size: 1.35rem;
      margin-bottom: 1.25rem;
    }
    article.chapter p {
      text-indent: 1.5em;
      margin: 0 0 0.85em;
      text-align: justify;
    }
    p.back-toc { text-indent: 0; text-align: right; font-size: 0.85rem; opacity: 0.7; margin-top: 1.5rem; }
    .muted { opacity: 0.65; font-style: italic; }
  </style>
</head>
<body>
  <header class="book-header">
    <h1>${escapeXML(meta.title)}</h1>
    <div class="meta">Tác giả: ${escapeXML(meta.author || 'Khuyết danh')} • ${sortedChapters.length} chương${
      meta.rangeLabel ? ` • ${escapeXML(meta.rangeLabel)}` : ''
    }</div>
  </header>
${introSection}
${tocSection}
${chaptersHtml}
</body>
</html>`;

  const filename = buildExportFilename(meta.title, 'HTML', meta.contentMode);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  triggerDownload(blob, filename);

  return {
    filename,
    chapterCount: sortedChapters.length,
  };
}

interface ParsedCoverImage {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
}

function parseCoverDataUrl(coverUrl?: string): ParsedCoverImage | null {
  if (!coverUrl || !coverUrl.startsWith('data:image/')) return null;
  const match = coverUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;

  try {
    const rawMime = match[1].toLowerCase();
    const mediaType = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
    const ext =
      mediaType === 'image/png'
        ? 'png'
        : mediaType === 'image/webp'
        ? 'webp'
        : mediaType === 'image/gif'
        ? 'gif'
        : 'jpg';
    const b64 = match[2].replace(/\s+/g, '');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    if (bytes.length === 0) return null;
    return {
      filename: `images/cover.${ext}`,
      mediaType,
      bytes,
    };
  } catch {
    return null;
  }
}

/**
 * Generate a compliant EPUB 3 (with full EPUB 2 NCX & Guide fallback)
 * compatible with Calibre, Apple Books, Google Play Books, Kindle/Send-to-Kindle, Moon+ Reader, ReadEra, Foliate, Lithium, Kobo, etc.
 */
export async function exportBookToEPUB(
  book: Book,
  chapters: Chapter[],
  options?: Partial<ExportBookOptions>
): Promise<ExportBookResult> {
  const zip = new JSZip();
  const sortedChapters = [...chapters].sort((a, b) => a.chapterIndex - b.chapterIndex);
  const meta = getResolvedMetadata(book, options);
  const language = detectLanguageTag(sortedChapters, meta.contentMode, options?.language);

  const safeBookId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(book.id)
    ? `urn:uuid:${book.id}`
    : `urn:lynx-reader:${encodeURIComponent(book.id || 'book')}`;
  const bookIdXml = escapeXML(safeBookId);
  const titleXml = escapeXML(meta.title);
  const authorXml = escapeXML(meta.author || 'Khuyết danh');
  const descriptionXml = meta.description ? escapeXML(meta.description) : '';
  const coverImage = parseCoverDataUrl(book.coverUrl);

  // 1. mimetype (MUST be first entry in ZIP, uncompressed STORE, no extra fields)
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // 2. META-INF/container.xml
  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  zip.folder('META-INF')?.file('container.xml', containerXml);

  const oebps = zip.folder('OEBPS');
  if (!oebps) throw new Error('Không thể khởi tạo cấu trúc EPUB');

  // 3. Neutral adaptive CSS (no forced background/text colors so reader apps' Dark/Sepia/Light modes work cleanly)
  const css = `
body {
  font-family: Georgia, "Times New Roman", serif;
  margin: 5%;
  line-height: 1.75;
}
h1, h2 {
  text-align: center;
  font-weight: bold;
  margin-top: 1.4em;
  margin-bottom: 0.9em;
  line-height: 1.35;
}
p {
  text-indent: 1.5em;
  margin-top: 0;
  margin-bottom: 0.75em;
  text-align: justify;
}
.intro-box {
  margin-top: 1em;
}
.intro-meta {
  text-align: center;
  text-indent: 0;
  font-size: 0.92em;
  opacity: 0.8;
  margin-bottom: 1.2em;
}
.intro-cover {
  text-align: center;
  text-indent: 0;
  margin: 0.5em 0 1.2em;
}
.intro-cover img {
  max-width: 65%;
  max-height: 420px;
  height: auto;
}
.intro-divider {
  border: 0;
  border-top: 1px solid #999999;
  margin: 1.2em 0;
}
nav#toc ol {
  padding-left: 1.4em;
  line-height: 1.65;
}
nav#toc li {
  margin-bottom: 0.35em;
}
.muted {
  text-indent: 0;
  font-style: italic;
  opacity: 0.75;
}
`;
  oebps.file('stylesheet.css', css);

  if (coverImage) {
    oebps.file(coverImage.filename, coverImage.bytes);
  }

  const manifestItems: string[] = [];
  const spineItems: string[] = [];
  const navListItems: string[] = [];
  const ncxNavPoints: string[] = [];
  let playOrder = 1;
  let firstReadingHref = '';

  // 4. Optional Introduction / Book Info page (intro.xhtml)
  if (meta.includeIntroduction) {
    const descParagraphs = (meta.description || '')
      .split(/\r?\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const descHtml =
      descParagraphs.length > 0
        ? descParagraphs.map((p) => `    <p>${escapeXML(p)}</p>`).join('\n')
        : '    <p class="muted">Chưa có giới thiệu truyện.</p>';

    const rangeLine = meta.rangeLabel
      ? `\n  <p class="intro-meta">Phạm vi: ${escapeXML(meta.rangeLabel)} • ${sortedChapters.length} chương</p>`
      : `\n  <p class="intro-meta">${sortedChapters.length} chương • ${
          meta.contentMode === 'original' ? 'Nguyên văn' : 'Bản dịch'
        }</p>`;

    const coverHtml = coverImage
      ? `\n  <p class="intro-cover"><img src="${coverImage.filename}" alt="${titleXml}"/></p>`
      : '';

    const introXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head>
  <title>Giới thiệu - ${titleXml}</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>${coverHtml}
  <h1>${titleXml}</h1>
  <p class="intro-meta">Tác giả: ${authorXml}</p>${rangeLine}
  <hr class="intro-divider"/>
  <div class="intro-box">
    <h2>Giới thiệu truyện</h2>
${descHtml}
  </div>
</body>
</html>`;

    oebps.file('intro.xhtml', introXhtml);
    manifestItems.push(`    <item id="intro" href="intro.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`    <itemref idref="intro"/>`);
    navListItems.push(`      <li><a href="intro.xhtml">Giới thiệu truyện</a></li>`);
    ncxNavPoints.push(`    <navPoint id="navPoint-${playOrder}" playOrder="${playOrder}">
      <navLabel><text>Giới thiệu truyện</text></navLabel>
      <content src="intro.xhtml"/>
    </navPoint>`);
    playOrder++;
    firstReadingHref = 'intro.xhtml';
  }

  // If user enabled visible Table of Contents page, include nav.xhtml in <spine>
  if (meta.includeTableOfContents) {
    spineItems.push(`    <itemref idref="nav"/>`);
  }

  // 5. Chapter XHTML files
  for (let i = 0; i < sortedChapters.length; i++) {
    const ch = sortedChapters[i];
    const padded = String(i + 1).padStart(4, '0');
    const filename = `chapter_${padded}.xhtml`;
    const itemId = `ch_${padded}`;
    const chTitle = escapeXML((ch.title || `Chương ${i + 1}`).trim());

    if (!firstReadingHref) {
      firstReadingHref = filename;
    }

    const paragraphs = (ch.content || '')
      .split(/\r?\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    const bodyHtml =
      paragraphs.length > 0
        ? paragraphs.map((p) => `    <p>${escapeXML(p)}</p>`).join('\n')
        : '    <p class="muted">(Chương trống)</p>';

    const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head>
  <title>${chTitle}</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <h2>${chTitle}</h2>
${bodyHtml}
</body>
</html>`;

    oebps.file(filename, xhtml);

    manifestItems.push(`    <item id="${itemId}" href="${filename}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`    <itemref idref="${itemId}"/>`);
    navListItems.push(`      <li><a href="${filename}">${chTitle}</a></li>`);
    ncxNavPoints.push(`    <navPoint id="navPoint-${playOrder}" playOrder="${playOrder}">
      <navLabel><text>${chTitle}</text></navLabel>
      <content src="${filename}"/>
    </navPoint>`);
    playOrder++;
  }

  // Fallback nav entry if chapters somehow empty
  if (navListItems.length === 0) {
    navListItems.push(`      <li><span>${titleXml}</span></li>`);
  }

  // 6. Navigation Document (EPUB 3 nav.xhtml - ALWAYS required in manifest per EPUB 3 spec)
  const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head>
  <title>Mục lục - ${titleXml}</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Mục lục</h1>
    <ol>
${navListItems.join('\n')}
    </ol>
  </nav>
</body>
</html>`;
  oebps.file('nav.xhtml', navXhtml);

  // 7. NCX Table of Contents (EPUB 2 backwards compatibility for Kindle, Moon+ Reader, Calibre, FBReader)
  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${bookIdXml}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${titleXml}</text></docTitle>
  <docAuthor><text>${authorXml}</text></docAuthor>
  <navMap>
${ncxNavPoints.join('\n')}
  </navMap>
</ncx>`;
  oebps.file('toc.ncx', tocNcx);

  // 8. content.opf Package Document
  const coverMetaLine = coverImage
    ? `\n    <meta name="cover" content="cover-image"/>`
    : '';
  const coverManifestLine = coverImage
    ? `\n    <item id="cover-image" href="${coverImage.filename}" media-type="${coverImage.mediaType}" properties="cover-image"/>`
    : '';
  const descriptionMetaLine = descriptionXml
    ? `\n    <dc:description>${descriptionXml}</dc:description>`
    : '';

  const guideRefs: string[] = [];
  if (meta.includeTableOfContents) {
    guideRefs.push(`    <reference type="toc" title="Mục lục" href="nav.xhtml"/>`);
  }
  if (firstReadingHref) {
    guideRefs.push(`    <reference type="text" title="Nội dung" href="${firstReadingHref}"/>`);
  }
  const guideBlock =
    guideRefs.length > 0
      ? `\n  <guide>\n${guideRefs.join('\n')}\n  </guide>`
      : '';

  const contentOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookId">${bookIdXml}</dc:identifier>
    <dc:title>${titleXml}</dc:title>
    <dc:creator id="creator">${authorXml}</dc:creator>
    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>
    <dc:language>${language}</dc:language>${descriptionMetaLine}
    <dc:publisher>LYNX Reader</dc:publisher>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.[0-9]+Z$/, 'Z')}</meta>${coverMetaLine}
  </metadata>
  <manifest>
    <item id="css" href="stylesheet.css" media-type="text/css"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${coverManifestLine}
${manifestItems.join('\n')}
  </manifest>
  <spine toc="ncx">
${spineItems.join('\n')}
  </spine>${guideBlock}
</package>`;
  oebps.file('content.opf', contentOpf);

  // Generate EPUB Blob
  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  const filename = buildExportFilename(meta.title, 'EPUB', meta.contentMode);
  triggerDownload(blob, filename);

  return {
    filename,
    chapterCount: sortedChapters.length,
  };
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function sanitizeFilename(name: string): string {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s_]+|[.\s_]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'Truyen_TaiVe';
}

/**
 * Strip XML 1.0 illegal control characters and unpaired UTF-16 surrogates
 * while preserving valid surrogate pairs (e.g., CJK Extension B, emoji).
 */
function sanitizeXmlText(str: string): string {
  if (!str) return '';
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < str.length) {
        const low = str.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          out += str[i] + str[i + 1];
          i++;
          continue;
        }
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xfffd)
    ) {
      out += str[i];
    }
  }
  return out;
}

function escapeXML(str: string): string {
  return sanitizeXmlText(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
