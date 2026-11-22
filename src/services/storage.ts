import {
  Book,
  BookFormat,
  BookStatus,
  Chapter,
  ChapterTranslation,
  Bookmark,
  Highlight,
  DictionaryEntry,
  DictionaryEntryType,
  ReaderSettings,
  ChapterVersion,
  SiteCookieJar,
  GLOBAL_DICTIONARY_BOOK_ID,
} from '../types';
import { countWords } from './parser';
import { mergeDictionariesByPrecedence } from './dictionary';

const DB_NAME = 'LynxReaderDB';
const LEGACY_DB_NAME = 'VBookDesktopDB';
const DB_MIGRATION_FLAG = 'lynx_migrated_legacy_db_v1';
const DB_VERSION = 4;
const CURRENT_BACKUP_VERSION = 2;
const SUPPORTED_BACKUP_VERSIONS = new Set([1, 2]);

const VALID_BOOK_FORMATS = new Set<BookFormat>(['TXT', 'EPUB', 'FB2', 'DOCX', 'HTML', 'MD', 'WEB']);
const VALID_BOOK_STATUSES = new Set<BookStatus>(['unread', 'reading', 'completed', 'favorite', 'archived']);
const VALID_HIGHLIGHT_COLORS = new Set<Highlight['color']>(['yellow', 'green', 'blue', 'pink', 'purple']);
const VALID_DICT_TYPES = new Set<DictionaryEntryType>(['character', 'location', 'term', 'pronoun', 'replace']);

const LIBRARY_STORES = [
  'books',
  'chapters',
  'chapter_versions',
  'chapter_translations',
  'bookmarks',
  'highlights',
  'dictionaries',
  'settings',
] as const;

export interface StorageDiagnosticStatus {
  migrationState: 'pending' | 'not-needed' | 'completed' | 'failed';
  migrationError?: string;
  migratedStores: number;
  migratedRecords: number;
  legacyDbDetected: boolean;
  legacyDbPreserved: boolean;
}

export interface BackupProgress {
  phase: 'reading' | 'validating' | 'writing';
  processed: number;
  total: number;
  message: string;
}

export interface BackupPreview {
  version: number;
  exportedAt?: string;
  booksCount: number;
  chaptersCount: number;
  chapterVersionsCount: number;
  translationsCount: number;
  bookmarksCount: number;
  highlightsCount: number;
  dictionariesCount: number;
  globalDictionariesCount: number;
  hasSettings: boolean;
  includesSiteCookies: false;
}

export type BackupRestoreMode = 'merge' | 'replace';

export interface PreparedBackupData {
  preview: BackupPreview;
  books: Book[];
  chapters: Chapter[];
  chapterVersions: ChapterVersion[];
  chapterTranslations: ChapterTranslation[];
  bookmarks: Bookmark[];
  highlights: Highlight[];
  dictionaries: DictionaryEntry[];
  settings?: ReaderSettings;
}

export interface BackupRestoreResult {
  mode: BackupRestoreMode;
  preview: BackupPreview;
}

let storageDiagnostics: StorageDiagnosticStatus = {
  migrationState: 'pending',
  migratedStores: 0,
  migratedRecords: 0,
  legacyDbDetected: false,
  legacyDbPreserved: false,
};

export function getStorageDiagnostics(): StorageDiagnosticStatus {
  return { ...storageDiagnostics };
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'paper',
  fontFamily: 'font-literata',
  fontSize: 19,
  fontWeight: 'normal',
  lineHeight: 1.8,
  letterSpacing: 0,
  paragraphSpacing: 1.25,
  textIndent: true,
  textAlign: 'justify',
  containerWidth: 'medium',
  readingMode: 'scroll',
  autoScrollSpeed: 0,
  tapToTurnPage: true,
  wheelToTurnPage: true,
  smoothScroll: true,
  applyDictionary: true,
  highlightReplacements: true,
  customThemes: [
    {
      id: 'custom-emerald',
      name: 'Rừng thông',
      backgroundColor: '#0f1f17',
      textColor: '#d1e7dd',
      fontFamily: 'font-lora',
      fontSize: 19,
      fontWeight: 'normal',
      lineHeight: 1.85,
      paragraphSpacing: 1.2,
      containerWidth: 'medium',
      textAlign: 'justify',
      textIndent: true,
    },
    {
      id: 'custom-sunset',
      name: 'Hổ phách',
      backgroundColor: '#231812',
      textColor: '#edd6c8',
      fontFamily: 'font-merriweather',
      fontSize: 18,
      fontWeight: 'normal',
      lineHeight: 1.8,
      paragraphSpacing: 1.3,
      containerWidth: 'medium',
      textAlign: 'justify',
      textIndent: true,
    },
  ],
  ttsVoiceURI: '',
  ttsRate: 1.0,
  ttsPitch: 1.0,
  ttsAutoNextChapter: true,
};

let dbPromise: Promise<IDBDatabase> | null = null;

function formatIndexedDbError(err: DOMException | Error | null | undefined, fallback: string): string {
  if (!err) return fallback;
  const name = err.name || '';
  if (name === 'QuotaExceededError') {
    return 'Bộ nhớ lưu trữ trình duyệt/ứng dụng đã đầy (QuotaExceededError). Vui lòng giải phóng dung lượng hoặc xuất sao lưu trước khi tiếp tục.';
  }
  if (name === 'ConstraintError') {
    return 'Xung đột khóa dữ liệu trong cơ sở dữ liệu cục bộ (ConstraintError). Thao tác đã được hoàn tác để bảo vệ dữ liệu hiện có.';
  }
  if (name === 'AbortError') {
    return 'Giao dịch lưu trữ đã bị hủy giữa chừng nên chưa có thay đổi nào được ghi.';
  }
  if (name === 'VersionError') {
    return 'Phiên bản cơ sở dữ liệu cục bộ trên máy cao hơn phiên bản ứng dụng hiện tại.';
  }
  return err.message ? `${fallback} (${name ? `${name}: ` : ''}${err.message})` : fallback;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function awaitTransactionCompletion(tx: IDBTransaction, contextMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: DOMException | Error | null | undefined) => {
      if (settled) return;
      settled = true;
      reject(new Error(formatIndexedDbError(err, contextMessage)));
    };
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

async function openLegacyReadOnlyDatabase(): Promise<{ db: IDBDatabase | null; exists: boolean }> {
  return new Promise((resolve, reject) => {
    let createdDuringOpen = false;
    const req = indexedDB.open(LEGACY_DB_NAME);

    req.onupgradeneeded = () => {
      // Legacy DB did not exist; abort upgrade immediately so we never create an empty shell DB
      createdDuringOpen = true;
      try {
        req.transaction?.abort();
      } catch {
        // Ignore abort error here; onerror will handle cleanup
      }
    };

    req.onblocked = () => {
      reject(new Error('Cơ sở dữ liệu cũ VBookDesktopDB đang bị khóa bởi một cửa sổ hoặc tab khác.'));
    };

    req.onsuccess = () => {
      if (createdDuringOpen) {
        try {
          req.result.close();
        } catch {
          // ignore
        }
        resolve({ db: null, exists: false });
        return;
      }
      resolve({ db: req.result, exists: true });
    };

    req.onerror = () => {
      if (createdDuringOpen) {
        resolve({ db: null, exists: false });
        return;
      }
      reject(new Error(formatIndexedDbError(req.error, 'Không thể mở cơ sở dữ liệu cũ VBookDesktopDB')));
    };
  });
}

async function readStoreRecords(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      let result: unknown[] = [];
      req.onsuccess = () => {
        result = Array.isArray(req.result) ? req.result : [];
      };
      req.onerror = () => {
        reject(new Error(formatIndexedDbError(req.error, `Lỗi đọc dữ liệu từ bảng "${storeName}"`)));
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new Error(formatIndexedDbError(tx.error, `Lỗi giao dịch đọc bảng "${storeName}"`)));
      tx.onabort = () => reject(new Error(formatIndexedDbError(tx.error, `Giao dịch đọc bảng "${storeName}" bị hủy`)));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(`Không thể truy cập bảng "${storeName}"`));
    }
  });
}

async function migrateLegacyDatabaseIfNeeded(targetDb: IDBDatabase): Promise<void> {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(DB_MIGRATION_FLAG) === '1') {
      storageDiagnostics = {
        migrationState: 'not-needed',
        migratedStores: 0,
        migratedRecords: 0,
        legacyDbDetected: false,
        legacyDbPreserved: false,
      };
      return;
    }

    let hasLegacy = false;
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      hasLegacy = dbs.some((d) => d.name === LEGACY_DB_NAME);
      if (!hasLegacy) {
        localStorage?.setItem(DB_MIGRATION_FLAG, '1');
        storageDiagnostics = {
          migrationState: 'not-needed',
          migratedStores: 0,
          migratedRecords: 0,
          legacyDbDetected: false,
          legacyDbPreserved: false,
        };
        return;
      }
    } else {
      // Without indexedDB.databases(), probe only if we won't create an empty legacy DB
      storageDiagnostics = {
        migrationState: 'not-needed',
        migratedStores: 0,
        migratedRecords: 0,
        legacyDbDetected: false,
        legacyDbPreserved: false,
      };
      return;
    }

    storageDiagnostics.legacyDbDetected = true;
    const { db: legacyDb, exists } = await openLegacyReadOnlyDatabase();
    if (!exists || !legacyDb) {
      localStorage?.setItem(DB_MIGRATION_FLAG, '1');
      storageDiagnostics = {
        migrationState: 'not-needed',
        migratedStores: 0,
        migratedRecords: 0,
        legacyDbDetected: false,
        legacyDbPreserved: false,
      };
      return;
    }

    try {
      const commonStores = Array.from(targetDb.objectStoreNames).filter((name) =>
        legacyDb.objectStoreNames.contains(name)
      );

      if (commonStores.length === 0) {
        localStorage?.setItem(DB_MIGRATION_FLAG, '1');
        storageDiagnostics = {
          migrationState: 'completed',
          migratedStores: 0,
          migratedRecords: 0,
          legacyDbDetected: true,
          legacyDbPreserved: true,
        };
        return;
      }

      // 1. Read every store completely BEFORE mutating targetDb
      const storePayloads: Array<{ storeName: string; records: unknown[] }> = [];
      let totalRecords = 0;
      for (const storeName of commonStores) {
        const records = await readStoreRecords(legacyDb, storeName);
        if (records.length > 0) {
          storePayloads.push({ storeName, records });
          totalRecords += records.length;
        }
      }

      // 2. Write all non-empty stores in a SINGLE atomic transaction so partial failure rolls back cleanly
      if (storePayloads.length > 0) {
        const targetStoreNames = storePayloads.map((p) => p.storeName);
        await new Promise<void>((resolve, reject) => {
          const tx = targetDb.transaction(targetStoreNames, 'readwrite');
          for (const { storeName, records } of storePayloads) {
            const store = tx.objectStore(storeName);
            for (const rec of records) {
              store.put(rec);
            }
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(
              new Error(
                formatIndexedDbError(
                  tx.error,
                  'Không thể ghi dữ liệu di trú vào LynxReaderDB'
                )
              )
            );
          tx.onabort = () =>
            reject(
              new Error(
                formatIndexedDbError(
                  tx.error,
                  'Giao dịch di trú dữ liệu bị hủy, toàn bộ thay đổi đã được hoàn tác'
                )
              )
            );
        });
      }

      // Only mark migration completed after atomic write succeeds
      localStorage?.setItem(DB_MIGRATION_FLAG, '1');
      storageDiagnostics = {
        migrationState: 'completed',
        migratedStores: storePayloads.length,
        migratedRecords: totalRecords,
        legacyDbDetected: true,
        legacyDbPreserved: true,
      };
    } finally {
      try {
        legacyDb.close();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    const safeMsg = err instanceof Error ? err.message : 'Lỗi không xác định khi di trú dữ liệu cũ.';
    // Minimal diagnostic log only — never log story content, cookies, or personal data
    console.error('[Storage] Legacy DB migration failed:', safeMsg);
    storageDiagnostics = {
      migrationState: 'failed',
      migrationError: safeMsg,
      migratedStores: 0,
      migratedRecords: 0,
      legacyDbDetected: true,
      legacyDbPreserved: true,
    };
  }
}

export async function retryLegacyMigration(): Promise<StorageDiagnosticStatus> {
  const db = await getDB();
  await migrateLegacyDatabaseIfNeeded(db);
  return getStorageDiagnostics();
}

export function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      dbPromise = null;
      reject(new Error('Trình duyệt hoặc WebView hiện tại không hỗ trợ IndexedDB.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('books')) {
        const bookStore = db.createObjectStore('books', { keyPath: 'id' });
        bookStore.createIndex('status', 'status', { unique: false });
        bookStore.createIndex('lastReadTimestamp', 'lastReadTimestamp', { unique: false });
      }

      if (!db.objectStoreNames.contains('chapters')) {
        const chapterStore = db.createObjectStore('chapters', { keyPath: 'id' });
        chapterStore.createIndex('bookId', 'bookId', { unique: false });
        chapterStore.createIndex('bookId_chapterIndex', ['bookId', 'chapterIndex'], { unique: true });
      }

      if (!db.objectStoreNames.contains('bookmarks')) {
        const bookmarkStore = db.createObjectStore('bookmarks', { keyPath: 'id' });
        bookmarkStore.createIndex('bookId', 'bookId', { unique: false });
      }

      if (!db.objectStoreNames.contains('highlights')) {
        const highlightStore = db.createObjectStore('highlights', { keyPath: 'id' });
        highlightStore.createIndex('bookId', 'bookId', { unique: false });
      }

      if (!db.objectStoreNames.contains('dictionaries')) {
        const dictStore = db.createObjectStore('dictionaries', { keyPath: 'id' });
        dictStore.createIndex('bookId', 'bookId', { unique: false });
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains('chapter_versions')) {
        const versionStore = db.createObjectStore('chapter_versions', { keyPath: 'id' });
        versionStore.createIndex('chapterId', 'chapterId', { unique: false });
        versionStore.createIndex('bookId', 'bookId', { unique: false });
        versionStore.createIndex('timestamp', 'timestamp', { unique: false });
      }

      if (!db.objectStoreNames.contains('chapter_translations')) {
        const transStore = db.createObjectStore('chapter_translations', { keyPath: 'chapterId' });
        transStore.createIndex('bookId', 'bookId', { unique: false });
        transStore.createIndex('bookId_chapterIndex', ['bookId', 'chapterIndex'], { unique: false });
      }

      if (!db.objectStoreNames.contains('site_cookies')) {
        db.createObjectStore('site_cookies', { keyPath: 'domain' });
      }
    };

    request.onblocked = () => {
      dbPromise = null;
      reject(
        new Error(
          'Cơ sở dữ liệu đang bị khóa bởi một cửa sổ LYNX Reader khác. Vui lòng đóng các cửa sổ khác và tải lại.'
        )
      );
    };

    request.onsuccess = async () => {
      const db = request.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          // ignore
        }
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };

      await migrateLegacyDatabaseIfNeeded(db);
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(new Error(formatIndexedDbError(request.error, 'Không thể mở cơ sở dữ liệu cục bộ')));
    };
  });

  return dbPromise;
}

// Book operations
export async function getAllBooks(): Promise<Book[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readonly');
    const store = tx.objectStore('books');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc danh sách truyện')));
  });
}

export async function getBookById(id: string): Promise<Book | undefined> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readonly');
    const store = tx.objectStore('books');
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc thông tin truyện')));
  });
}

export async function saveBook(book: Book): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('books', 'readwrite');
  tx.objectStore('books').put(book);
  return awaitTransactionCompletion(tx, 'Không thể lưu thông tin truyện');
}

export async function deleteBook(bookId: string): Promise<void> {
  const db = await getDB();
  const targetStores = [
    'books',
    'chapters',
    'bookmarks',
    'highlights',
    'dictionaries',
    'chapter_versions',
    'chapter_translations',
  ].filter((name) => db.objectStoreNames.contains(name));

  if (targetStores.length === 0) return;

  const tx = db.transaction(targetStores, 'readwrite');

  if (targetStores.includes('books')) {
    tx.objectStore('books').delete(bookId);
  }

  const deleteByBookIdIndex = (storeName: string) => {
    if (!targetStores.includes(storeName)) return;
    const store = tx.objectStore(storeName);
    if (!store.indexNames.contains('bookId')) return;
    const index = store.index('bookId');
    const req = index.openCursor(IDBKeyRange.only(bookId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  };

  deleteByBookIdIndex('chapters');
  deleteByBookIdIndex('bookmarks');
  deleteByBookIdIndex('highlights');
  deleteByBookIdIndex('dictionaries');
  deleteByBookIdIndex('chapter_versions');
  deleteByBookIdIndex('chapter_translations');

  return awaitTransactionCompletion(tx, 'Không thể xóa truyện khỏi cơ sở dữ liệu');
}

// Chapter operations
export async function getChaptersByBookId(bookId: string): Promise<Chapter[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chapters', 'readonly');
    const store = tx.objectStore('chapters');
    const index = store.index('bookId');
    const request = index.getAll(IDBKeyRange.only(bookId));
    request.onsuccess = () => {
      const list: Chapter[] = request.result || [];
      list.sort((a, b) => a.chapterIndex - b.chapterIndex);
      resolve(list);
    };
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc danh sách chương')));
  });
}

export async function getChapter(bookId: string, chapterIndex: number): Promise<Chapter | undefined> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chapters', 'readonly');
    const store = tx.objectStore('chapters');
    const index = store.index('bookId_chapterIndex');
    const request = index.get([bookId, chapterIndex]);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc nội dung chương')));
  });
}

export async function saveChapters(chapters: Chapter[]): Promise<void> {
  if (chapters.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('chapters', 'readwrite');
  const store = tx.objectStore('chapters');
  for (const chapter of chapters) {
    const normalizedChapter: Chapter = {
      ...chapter,
      originalContent: chapter.originalContent || chapter.content,
      originalTitle: chapter.originalTitle || chapter.title,
      wordCount: chapter.wordCount || countWords(chapter.content),
    };
    store.put(normalizedChapter);
  }
  return awaitTransactionCompletion(tx, 'Không thể lưu danh sách chương');
}

export async function updateChapter(
  chapter: Chapter,
  createVersionSnapshot = false,
  versionSummary?: string
): Promise<void> {
  const db = await getDB();
  const wordCount = countWords(chapter.content);
  const normalizedChapter: Chapter = {
    ...chapter,
    wordCount,
    lastEditedTimestamp: Date.now(),
    originalContent: chapter.originalContent || chapter.content,
    originalTitle: chapter.originalTitle || chapter.title,
  };

  const stores = createVersionSnapshot ? ['chapters', 'chapter_versions'] : ['chapters'];
  const tx = db.transaction(stores, 'readwrite');
  tx.objectStore('chapters').put(normalizedChapter);

  if (createVersionSnapshot) {
    const vStore = tx.objectStore('chapter_versions');
    const versionId = `v-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const snapshot: ChapterVersion = {
      id: versionId,
      chapterId: normalizedChapter.id,
      bookId: normalizedChapter.bookId,
      chapterIndex: normalizedChapter.chapterIndex,
      title: normalizedChapter.title,
      content: normalizedChapter.content,
      timestamp: Date.now(),
      summary: versionSummary || 'Đã chỉnh sửa nội dung',
    };
    vStore.put(snapshot);
  }

  return awaitTransactionCompletion(tx, 'Không thể cập nhật nội dung chương');
}

export async function batchUpdateChapters(chapters: Chapter[]): Promise<void> {
  if (chapters.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('chapters', 'readwrite');
  const store = tx.objectStore('chapters');
  for (const ch of chapters) {
    const wordCount = ch.content.trim().split(/\s+/).filter(Boolean).length;
    store.put({
      ...ch,
      wordCount,
      lastEditedTimestamp: Date.now(),
      originalContent: ch.originalContent || ch.content,
      originalTitle: ch.originalTitle || ch.title,
    });
  }
  return awaitTransactionCompletion(tx, 'Không thể cập nhật hàng loạt chương');
}

export async function deleteChapterById(chapterId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['chapters', 'chapter_versions', 'chapter_translations'], 'readwrite');
  tx.objectStore('chapters').delete(chapterId);
  tx.objectStore('chapter_translations').delete(chapterId);

  const vStore = tx.objectStore('chapter_versions');
  const vIndex = vStore.index('chapterId');
  const vReq = vIndex.openCursor(IDBKeyRange.only(chapterId));
  vReq.onsuccess = () => {
    const cursor = vReq.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  return awaitTransactionCompletion(tx, 'Không thể xóa chương');
}

export async function replaceBookChapters(bookId: string, chapters: Chapter[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['chapters', 'chapter_translations'], 'readwrite');
  const store = tx.objectStore('chapters');
  const index = store.index('bookId');
  const req = index.openCursor(IDBKeyRange.only(bookId));
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    } else {
      for (const ch of chapters) {
        const normalized: Chapter = {
          ...ch,
          originalContent: ch.originalContent || ch.content,
          originalTitle: ch.originalTitle || ch.title,
          wordCount: ch.wordCount || countWords(ch.content),
        };
        store.put(normalized);
      }
    }
  };

  const tStore = tx.objectStore('chapter_translations');
  const tIndex = tStore.index('bookId');
  const tReq = tIndex.openCursor(IDBKeyRange.only(bookId));
  tReq.onsuccess = () => {
    const cursor = tReq.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  return awaitTransactionCompletion(tx, 'Không thể thay thế danh sách chương');
}

// Chapter Translations (Separate store; never mutates original chapters)
export async function getChapterTranslation(chapterId: string): Promise<ChapterTranslation | undefined> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chapter_translations', 'readonly');
    const store = tx.objectStore('chapter_translations');
    const request = store.get(chapterId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc bản dịch chương')));
  });
}

export async function getBookTranslations(bookId: string): Promise<ChapterTranslation[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chapter_translations', 'readonly');
    const store = tx.objectStore('chapter_translations');
    const index = store.index('bookId');
    const request = index.getAll(IDBKeyRange.only(bookId));
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc bản dịch truyện')));
  });
}

export async function saveChapterTranslation(translation: ChapterTranslation): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('chapter_translations', 'readwrite');
  tx.objectStore('chapter_translations').put(translation);
  return awaitTransactionCompletion(tx, 'Không thể lưu bản dịch chương');
}

export async function saveBookTranslations(translations: ChapterTranslation[]): Promise<void> {
  if (translations.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('chapter_translations', 'readwrite');
  const store = tx.objectStore('chapter_translations');
  for (const t of translations) {
    store.put(t);
  }
  return awaitTransactionCompletion(tx, 'Không thể lưu hàng loạt bản dịch');
}

export async function deleteChapterTranslation(chapterId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('chapter_translations', 'readwrite');
  tx.objectStore('chapter_translations').delete(chapterId);
  return awaitTransactionCompletion(tx, 'Không thể xóa bản dịch chương');
}

// Chapter Versions
export async function getChapterVersions(chapterId: string): Promise<ChapterVersion[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chapter_versions', 'readonly');
    const store = tx.objectStore('chapter_versions');
    const index = store.index('chapterId');
    const request = index.getAll(IDBKeyRange.only(chapterId));
    request.onsuccess = () => {
      const list: ChapterVersion[] = request.result || [];
      list.sort((a, b) => b.timestamp - a.timestamp);
      resolve(list);
    };
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc lịch sử chỉnh sửa')));
  });
}

export async function getBookChapterVersions(bookId: string): Promise<ChapterVersion[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chapter_versions', 'readonly');
    const store = tx.objectStore('chapter_versions');
    const index = store.index('bookId');
    const request = index.getAll(IDBKeyRange.only(bookId));
    request.onsuccess = () => resolve((request.result || []) as ChapterVersion[]);
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc lịch sử chỉnh sửa của truyện')));
  });
}

export async function saveChapterVersion(version: ChapterVersion): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('chapter_versions', 'readwrite');
  tx.objectStore('chapter_versions').put(version);
  return awaitTransactionCompletion(tx, 'Không thể lưu phiên bản chương');
}

export async function deleteChapterVersion(versionId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('chapter_versions', 'readwrite');
  tx.objectStore('chapter_versions').delete(versionId);
  return awaitTransactionCompletion(tx, 'Không thể xóa phiên bản chương');
}

// Bookmarks
export async function getBookmarks(bookId: string): Promise<Bookmark[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readonly');
    const store = tx.objectStore('bookmarks');
    const index = store.index('bookId');
    const request = index.getAll(IDBKeyRange.only(bookId));
    request.onsuccess = () => {
      const res: Bookmark[] = request.result || [];
      res.sort((a, b) => b.createdAt - a.createdAt);
      resolve(res);
    };
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc danh sách bookmark')));
  });
}

export async function saveBookmark(bookmark: Bookmark): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('bookmarks', 'readwrite');
  tx.objectStore('bookmarks').put(bookmark);
  return awaitTransactionCompletion(tx, 'Không thể lưu bookmark');
}

export async function deleteBookmark(bookmarkId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('bookmarks', 'readwrite');
  tx.objectStore('bookmarks').delete(bookmarkId);
  return awaitTransactionCompletion(tx, 'Không thể xóa bookmark');
}

// Highlights
export async function getHighlights(bookId: string): Promise<Highlight[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readonly');
    const store = tx.objectStore('highlights');
    const index = store.index('bookId');
    const request = index.getAll(IDBKeyRange.only(bookId));
    request.onsuccess = () => {
      const res: Highlight[] = request.result || [];
      res.sort((a, b) => b.createdAt - a.createdAt);
      resolve(res);
    };
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc danh sách ghi chú')));
  });
}

export async function saveHighlight(highlight: Highlight): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('highlights', 'readwrite');
  tx.objectStore('highlights').put(highlight);
  return awaitTransactionCompletion(tx, 'Không thể lưu đoạn đánh dấu');
}

export async function deleteHighlight(highlightId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('highlights', 'readwrite');
  tx.objectStore('highlights').delete(highlightId);
  return awaitTransactionCompletion(tx, 'Không thể xóa đoạn đánh dấu');
}

// Dictionaries
export async function getDictionaries(bookId: string): Promise<DictionaryEntry[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('dictionaries', 'readonly');
    const store = tx.objectStore('dictionaries');
    const index = store.index('bookId');
    const request = index.getAll(IDBKeyRange.only(bookId));
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(new Error(formatIndexedDbError(request.error, 'Không thể đọc từ điển')));
  });
}

export async function getMergedDictionaries(bookId: string): Promise<{
  globalEntries: DictionaryEntry[];
  bookEntries: DictionaryEntry[];
  merged: DictionaryEntry[];
}> {
  const [globalEntries, bookEntries] = await Promise.all([
    getDictionaries(GLOBAL_DICTIONARY_BOOK_ID),
    getDictionaries(bookId),
  ]);
  return {
    globalEntries,
    bookEntries,
    merged: mergeDictionariesByPrecedence(globalEntries, bookEntries),
  };
}

export async function saveDictionaryEntry(entry: DictionaryEntry): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('dictionaries', 'readwrite');
  tx.objectStore('dictionaries').put(entry);
  return awaitTransactionCompletion(tx, 'Không thể lưu mục từ điển');
}

export async function deleteDictionaryEntry(entryId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('dictionaries', 'readwrite');
  tx.objectStore('dictionaries').delete(entryId);
  return awaitTransactionCompletion(tx, 'Không thể xóa mục từ điển');
}

// Settings
export async function getSettings(): Promise<ReaderSettings> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction('settings', 'readonly');
    const store = tx.objectStore('settings');
    const request = store.get('readerSettings');
    request.onsuccess = () => {
      if (request.result && request.result.value) {
        resolve({ ...DEFAULT_SETTINGS, ...request.result.value });
      } else {
        resolve(DEFAULT_SETTINGS);
      }
    };
    request.onerror = () => resolve(DEFAULT_SETTINGS);
  });
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key: 'readerSettings', value: settings });
  return awaitTransactionCompletion(tx, 'Không thể lưu cài đặt đọc');
}

// Site Cookies (Per-Domain Browser Cookie Vault)
const TWO_PART_TLDS = new Set([
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'com.vn',
  'net.vn',
  'org.vn',
  'edu.vn',
  'co.uk',
  'org.uk',
  'com.cn',
  'com.tw',
  'com.hk',
  'com.au',
]);

export function extractBaseDomain(urlOrHost: string): string {
  let host = urlOrHost.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      // keep as-is
    }
  }
  host = host.replace(/^\.+/, '').split(':')[0];
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${lastTwo}`;
  }
  return lastTwo;
}

export async function getAllSiteCookies(): Promise<SiteCookieJar[]> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction('site_cookies', 'readonly');
    const store = tx.objectStore('site_cookies');
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result || []) as SiteCookieJar[]);
    req.onerror = () => resolve([]);
  });
}

export async function getSiteCookieJar(domainOrUrl: string): Promise<SiteCookieJar | undefined> {
  const baseDomain = extractBaseDomain(domainOrUrl);
  if (!baseDomain) return undefined;
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction('site_cookies', 'readonly');
    const store = tx.objectStore('site_cookies');
    const req = store.get(baseDomain);
    req.onsuccess = () => resolve(req.result as SiteCookieJar | undefined);
    req.onerror = () => resolve(undefined);
  });
}

export async function saveSiteCookieJar(jar: SiteCookieJar): Promise<void> {
  const baseDomain = extractBaseDomain(jar.domain);
  if (!baseDomain) return;
  const db = await getDB();
  const tx = db.transaction('site_cookies', 'readwrite');
  tx.objectStore('site_cookies').put({ ...jar, domain: baseDomain });
  return awaitTransactionCompletion(tx, 'Không thể lưu cookie trang web');
}

export async function deleteSiteCookieJar(domainOrUrl: string): Promise<void> {
  const baseDomain = extractBaseDomain(domainOrUrl);
  if (!baseDomain) return;
  const db = await getDB();
  const tx = db.transaction('site_cookies', 'readwrite');
  tx.objectStore('site_cookies').delete(baseDomain);
  return awaitTransactionCompletion(tx, 'Không thể xóa cookie trang web');
}

export async function getCookieHeaderForUrl(url: string): Promise<string | undefined> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname || '/';
    const isHttps = parsed.protocol === 'https:';
    const jar = await getSiteCookieJar(hostname);
    if (!jar || jar.cookies.length === 0) return undefined;

    const now = Date.now();
    const matching = jar.cookies.filter((c) => {
      if (c.expiresAt && c.expiresAt <= now) return false;
      if (c.secure && !isHttps) return false;
      const cDom = c.domain.toLowerCase().replace(/^\.+/, '');
      const domainMatch = hostname === cDom || hostname.endsWith(`.${cDom}`);
      const cPath = c.path || '/';
      const pathMatch =
        cPath === '/' ||
        pathname === cPath ||
        pathname.startsWith(cPath.endsWith('/') ? cPath : `${cPath}/`);
      return domainMatch && pathMatch;
    });

    if (matching.length === 0) return undefined;
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return undefined;
  }
}

// Export / Inspect / Restore Full Database Backup
// NOTE: `site_cookies` is intentionally omitted from backup exports to protect active session credentials.
export async function exportDatabaseBackup(
  onProgress?: (progress: BackupProgress) => void
): Promise<string> {
  const books = await getAllBooks();
  const total = books.length + 2;

  onProgress?.({
    phase: 'reading',
    processed: 0,
    total,
    message: `Đang đọc danh sách ${books.length} truyện...`,
  });

  const allChapters: Chapter[] = [];
  const allChapterVersions: ChapterVersion[] = [];
  const allBookmarks: Bookmark[] = [];
  const allHighlights: Highlight[] = [];
  const allDictionaries: DictionaryEntry[] = [
    ...(await getDictionaries(GLOBAL_DICTIONARY_BOOK_ID)),
  ];
  const allTranslations: ChapterTranslation[] = [];

  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const [chapters, versions, bookmarks, highlights, dicts, translations] = await Promise.all([
      getChaptersByBookId(book.id),
      getBookChapterVersions(book.id),
      getBookmarks(book.id),
      getHighlights(book.id),
      getDictionaries(book.id),
      getBookTranslations(book.id),
    ]);

    allChapters.push(...chapters);
    allChapterVersions.push(...versions);
    allBookmarks.push(...bookmarks);
    allHighlights.push(...highlights);
    allDictionaries.push(...dicts);
    allTranslations.push(...translations);

    onProgress?.({
      phase: 'reading',
      processed: i + 1,
      total,
      message: `Đang đóng gói "${book.title}" (${i + 1}/${books.length})...`,
    });

    if ((i + 1) % 5 === 0) {
      await yieldToMain();
    }
  }

  const settings = await getSettings();

  onProgress?.({
    phase: 'writing',
    processed: books.length + 1,
    total,
    message: 'Đang tạo tệp sao lưu JSON...',
  });
  await yieldToMain();

  const backup = {
    version: CURRENT_BACKUP_VERSION,
    app: 'LYNX Reader',
    exportedAt: new Date().toISOString(),
    books,
    chapters: allChapters,
    chapter_versions: allChapterVersions,
    chapter_translations: allTranslations,
    bookmarks: allBookmarks,
    highlights: allHighlights,
    dictionaries: allDictionaries,
    settings,
  };

  const json = JSON.stringify(backup, null, 2);
  onProgress?.({
    phase: 'writing',
    processed: total,
    total,
    message: 'Đã hoàn tất xuất sao lưu.',
  });
  return json;
}

function validateAndNormalizeBook(raw: unknown, idx: number): Book {
  if (!isPlainObject(raw)) {
    throw new Error(`Mục sách #${idx + 1} không đúng định dạng đối tượng.`);
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    throw new Error(`Mục sách #${idx + 1} thiếu mã định danh (id) hợp lệ.`);
  }
  if (typeof raw.title !== 'string') {
    throw new Error(`Sách "${id}" thiếu tiêu đề (title) kiểu chuỗi.`);
  }

  const rawFormat = typeof raw.format === 'string' ? raw.format.toUpperCase() : 'TXT';
  const format: BookFormat = VALID_BOOK_FORMATS.has(rawFormat as BookFormat)
    ? (rawFormat as BookFormat)
    : 'TXT';

  const rawStatus = typeof raw.status === 'string' ? raw.status : 'unread';
  const status: BookStatus = VALID_BOOK_STATUSES.has(rawStatus as BookStatus)
    ? (rawStatus as BookStatus)
    : 'unread';

  const totalChapters =
    typeof raw.totalChapters === 'number' && Number.isFinite(raw.totalChapters) && raw.totalChapters >= 0
      ? Math.floor(raw.totalChapters)
      : 0;
  const currentChapterIndex =
    typeof raw.currentChapterIndex === 'number' &&
    Number.isFinite(raw.currentChapterIndex) &&
    raw.currentChapterIndex >= 0
      ? Math.floor(raw.currentChapterIndex)
      : 0;
  const scrollProgress =
    typeof raw.scrollProgress === 'number' && Number.isFinite(raw.scrollProgress)
      ? Math.min(1, Math.max(0, raw.scrollProgress))
      : 0;

  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== 'string'))) {
    throw new Error(`Sách "${raw.title}" có trường tags không hợp lệ.`);
  }

  return {
    ...(raw as unknown as Book),
    id,
    title: raw.title,
    author: typeof raw.author === 'string' ? raw.author : 'Khuyết danh',
    description: typeof raw.description === 'string' ? raw.description : '',
    format,
    status,
    totalChapters,
    currentChapterIndex,
    scrollProgress,
    lastReadTimestamp:
      typeof raw.lastReadTimestamp === 'number' && Number.isFinite(raw.lastReadTimestamp)
        ? raw.lastReadTimestamp
        : 0,
    addedTimestamp:
      typeof raw.addedTimestamp === 'number' && Number.isFinite(raw.addedTimestamp)
        ? raw.addedTimestamp
        : Date.now(),
    fileSize:
      typeof raw.fileSize === 'number' && Number.isFinite(raw.fileSize) && raw.fileSize >= 0
        ? raw.fileSize
        : 0,
    sourceFileName: typeof raw.sourceFileName === 'string' ? raw.sourceFileName : '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
  };
}

function validateAndNormalizeChapter(raw: unknown, idx: number, bookIds: Set<string>): Chapter {
  if (!isPlainObject(raw)) {
    throw new Error(`Chương #${idx + 1} không đúng định dạng đối tượng.`);
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const bookId = typeof raw.bookId === 'string' ? raw.bookId.trim() : '';
  if (!id || !bookId) {
    throw new Error(`Chương #${idx + 1} thiếu id hoặc bookId hợp lệ.`);
  }
  if (!bookIds.has(bookId)) {
    throw new Error(`Chương "${id}" tham chiếu tới sách không tồn tại trong bản sao lưu (bookId=${bookId}).`);
  }
  if (typeof raw.chapterIndex !== 'number' || !Number.isInteger(raw.chapterIndex) || raw.chapterIndex < 0) {
    throw new Error(`Chương "${id}" có chapterIndex không hợp lệ.`);
  }
  if (typeof raw.title !== 'string' || typeof raw.content !== 'string') {
    throw new Error(`Chương "${id}" thiếu tiêu đề hoặc nội dung dạng chuỗi.`);
  }
  const wordCount =
    typeof raw.wordCount === 'number' && Number.isFinite(raw.wordCount) && raw.wordCount >= 0
      ? Math.floor(raw.wordCount)
      : countWords(raw.content);

  return {
    ...(raw as unknown as Chapter),
    id,
    bookId,
    chapterIndex: raw.chapterIndex,
    title: raw.title,
    content: raw.content,
    wordCount,
    originalContent: typeof raw.originalContent === 'string' ? raw.originalContent : raw.content,
    originalTitle: typeof raw.originalTitle === 'string' ? raw.originalTitle : raw.title,
  };
}

function validateAndNormalizeChapterVersion(
  raw: unknown,
  idx: number,
  bookIds: Set<string>
): ChapterVersion {
  if (!isPlainObject(raw)) {
    throw new Error(`Lịch sử phiên bản #${idx + 1} không đúng định dạng đối tượng.`);
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const chapterId = typeof raw.chapterId === 'string' ? raw.chapterId.trim() : '';
  const bookId = typeof raw.bookId === 'string' ? raw.bookId.trim() : '';
  if (!id || !chapterId || !bookId) {
    throw new Error(`Lịch sử phiên bản #${idx + 1} thiếu id, chapterId hoặc bookId.`);
  }
  if (!bookIds.has(bookId)) {
    throw new Error(`Lịch sử phiên bản "${id}" tham chiếu tới sách không tồn tại (bookId=${bookId}).`);
  }
  if (typeof raw.title !== 'string' || typeof raw.content !== 'string') {
    throw new Error(`Lịch sử phiên bản "${id}" thiếu tiêu đề hoặc nội dung.`);
  }
  const chapterIndex =
    typeof raw.chapterIndex === 'number' && Number.isInteger(raw.chapterIndex) && raw.chapterIndex >= 0
      ? raw.chapterIndex
      : 0;
  const timestamp =
    typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now();

  return {
    id,
    chapterId,
    bookId,
    chapterIndex,
    title: raw.title,
    content: raw.content,
    timestamp,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
  };
}

function validateAndNormalizeTranslation(
  raw: unknown,
  idx: number,
  bookIds: Set<string>,
  chapterIds: Set<string>
): ChapterTranslation {
  if (!isPlainObject(raw)) {
    throw new Error(`Bản dịch #${idx + 1} không đúng định dạng đối tượng.`);
  }
  const chapterId = typeof raw.chapterId === 'string' ? raw.chapterId.trim() : '';
  const bookId = typeof raw.bookId === 'string' ? raw.bookId.trim() : '';
  if (!chapterId || !bookId) {
    throw new Error(`Bản dịch #${idx + 1} thiếu chapterId hoặc bookId.`);
  }
  if (!bookIds.has(bookId)) {
    throw new Error(`Bản dịch của chương "${chapterId}" tham chiếu tới sách không tồn tại (${bookId}).`);
  }
  if (chapterIds.size > 0 && !chapterIds.has(chapterId)) {
    throw new Error(`Bản dịch tham chiếu tới chương không tồn tại trong bản sao lưu (chapterId=${chapterId}).`);
  }
  if (
    typeof raw.translatedTitle !== 'string' ||
    typeof raw.translatedContent !== 'string' ||
    typeof raw.sourceTitle !== 'string' ||
    typeof raw.sourceContent !== 'string'
  ) {
    throw new Error(`Bản dịch chương "${chapterId}" thiếu nội dung nguồn hoặc nội dung dịch.`);
  }

  return {
    chapterId,
    bookId,
    chapterIndex:
      typeof raw.chapterIndex === 'number' && Number.isInteger(raw.chapterIndex) && raw.chapterIndex >= 0
        ? raw.chapterIndex
        : 0,
    translatedTitle: raw.translatedTitle,
    translatedContent: raw.translatedContent,
    sourceTitle: raw.sourceTitle,
    sourceContent: raw.sourceContent,
    sourceHash: typeof raw.sourceHash === 'string' ? raw.sourceHash : '',
    dictionarySignature:
      typeof raw.dictionarySignature === 'string' ? raw.dictionarySignature : undefined,
    provider: raw.provider === 'sangtacviet' ? 'sangtacviet' : 'lynx',
    translatedAt:
      typeof raw.translatedAt === 'number' && Number.isFinite(raw.translatedAt)
        ? raw.translatedAt
        : Date.now(),
  };
}

function validateAndNormalizeBookmark(raw: unknown, idx: number, bookIds: Set<string>): Bookmark {
  if (!isPlainObject(raw)) {
    throw new Error(`Bookmark #${idx + 1} không đúng định dạng đối tượng.`);
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const bookId = typeof raw.bookId === 'string' ? raw.bookId.trim() : '';
  if (!id || !bookId) {
    throw new Error(`Bookmark #${idx + 1} thiếu id hoặc bookId.`);
  }
  if (!bookIds.has(bookId)) {
    throw new Error(`Bookmark "${id}" tham chiếu tới sách không tồn tại (${bookId}).`);
  }
  if (typeof raw.chapterIndex !== 'number' || !Number.isInteger(raw.chapterIndex) || raw.chapterIndex < 0) {
    throw new Error(`Bookmark "${id}" có chapterIndex không hợp lệ.`);
  }

  return {
    id,
    bookId,
    chapterIndex: raw.chapterIndex,
    chapterTitle: typeof raw.chapterTitle === 'string' ? raw.chapterTitle : '',
    progressPercent:
      typeof raw.progressPercent === 'number' && Number.isFinite(raw.progressPercent)
        ? Math.min(100, Math.max(0, raw.progressPercent))
        : 0,
    textSnippet: typeof raw.textSnippet === 'string' ? raw.textSnippet : '',
    note: typeof raw.note === 'string' ? raw.note : undefined,
    createdAt:
      typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

function validateAndNormalizeHighlight(raw: unknown, idx: number, bookIds: Set<string>): Highlight {
  if (!isPlainObject(raw)) {
    throw new Error(`Ghi chú đánh dấu #${idx + 1} không đúng định dạng đối tượng.`);
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const bookId = typeof raw.bookId === 'string' ? raw.bookId.trim() : '';
  if (!id || !bookId) {
    throw new Error(`Ghi chú đánh dấu #${idx + 1} thiếu id hoặc bookId.`);
  }
  if (!bookIds.has(bookId)) {
    throw new Error(`Ghi chú đánh dấu "${id}" tham chiếu tới sách không tồn tại (${bookId}).`);
  }
  if (typeof raw.text !== 'string') {
    throw new Error(`Ghi chú đánh dấu "${id}" thiếu nội dung văn bản.`);
  }
  const color: Highlight['color'] =
    typeof raw.color === 'string' && VALID_HIGHLIGHT_COLORS.has(raw.color as Highlight['color'])
      ? (raw.color as Highlight['color'])
      : 'yellow';

  return {
    id,
    bookId,
    chapterIndex:
      typeof raw.chapterIndex === 'number' && Number.isInteger(raw.chapterIndex) && raw.chapterIndex >= 0
        ? raw.chapterIndex
        : 0,
    text: raw.text,
    color,
    note: typeof raw.note === 'string' ? raw.note : undefined,
    createdAt:
      typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

function validateAndNormalizeDictionary(
  raw: unknown,
  idx: number,
  bookIds: Set<string>
): DictionaryEntry {
  if (!isPlainObject(raw)) {
    throw new Error(`Mục từ điển #${idx + 1} không đúng định dạng đối tượng.`);
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const bookId = typeof raw.bookId === 'string' ? raw.bookId.trim() : '';
  if (!id || !bookId) {
    throw new Error(`Mục từ điển #${idx + 1} thiếu id hoặc bookId.`);
  }
  if (bookId !== GLOBAL_DICTIONARY_BOOK_ID && !bookIds.has(bookId)) {
    throw new Error(`Mục từ điển "${id}" tham chiếu tới sách không tồn tại (${bookId}).`);
  }
  if (typeof raw.original !== 'string' || typeof raw.replacement !== 'string') {
    throw new Error(`Mục từ điển "${id}" thiếu từ gốc hoặc từ thay thế.`);
  }
  const type: DictionaryEntryType =
    typeof raw.type === 'string' && VALID_DICT_TYPES.has(raw.type as DictionaryEntryType)
      ? (raw.type as DictionaryEntryType)
      : 'replace';

  return {
    id,
    bookId,
    type,
    original: raw.original,
    replacement: raw.replacement,
    note: typeof raw.note === 'string' ? raw.note : undefined,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
  };
}

export async function inspectAndValidateBackup(
  jsonString: string,
  onProgress?: (progress: BackupProgress) => void
): Promise<PreparedBackupData> {
  if (typeof jsonString !== 'string' || !jsonString.trim()) {
    throw new Error('Tệp sao lưu rỗng.');
  }

  onProgress?.({
    phase: 'validating',
    processed: 0,
    total: 1,
    message: 'Đang đọc và phân tích cấu trúc tệp sao lưu...',
  });

  let data: unknown;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Tệp không phải định dạng JSON hợp lệ hoặc bị cắt cụt.');
  }

  if (!isPlainObject(data)) {
    throw new Error('Dữ liệu sao lưu không hợp lệ (gốc tệp phải là đối tượng JSON).');
  }

  if (typeof data.version !== 'number' || !Number.isInteger(data.version)) {
    throw new Error('Tệp sao lưu thiếu trường phiên bản định dạng (version) hợp lệ.');
  }
  if (!SUPPORTED_BACKUP_VERSIONS.has(data.version)) {
    throw new Error(
      `Phiên bản sao lưu v${data.version} không được hỗ trợ (chỉ hỗ trợ v1, v2).`
    );
  }

  if (!Array.isArray(data.books)) {
    throw new Error('Dữ liệu sao lưu không hợp lệ: thiếu danh sách books.');
  }
  if (data.chapters !== undefined && !Array.isArray(data.chapters)) {
    throw new Error('Dữ liệu sao lưu không hợp lệ: trường chapters phải là mảng.');
  }

  const optionalArrays: Array<[string, unknown]> = [
    ['chapter_versions', data.chapter_versions],
    ['chapter_translations', data.chapter_translations],
    ['bookmarks', data.bookmarks],
    ['highlights', data.highlights],
    ['dictionaries', data.dictionaries],
  ];
  for (const [field, val] of optionalArrays) {
    if (val !== undefined && !Array.isArray(val)) {
      throw new Error(`Dữ liệu sao lưu không hợp lệ: trường ${field} phải là mảng.`);
    }
  }

  if (data.settings !== undefined && data.settings !== null && !isPlainObject(data.settings)) {
    throw new Error('Dữ liệu sao lưu không hợp lệ: trường settings phải là đối tượng.');
  }

  const rawBooks = data.books as unknown[];
  const rawChapters = (data.chapters as unknown[] | undefined) || [];
  const rawVersions = (data.chapter_versions as unknown[] | undefined) || [];
  const rawTranslations = (data.chapter_translations as unknown[] | undefined) || [];
  const rawBookmarks = (data.bookmarks as unknown[] | undefined) || [];
  const rawHighlights = (data.highlights as unknown[] | undefined) || [];
  const rawDictionaries = (data.dictionaries as unknown[] | undefined) || [];

  const totalItems =
    rawBooks.length +
    rawChapters.length +
    rawVersions.length +
    rawTranslations.length +
    rawBookmarks.length +
    rawHighlights.length +
    rawDictionaries.length;

  let checked = 0;
  const stepYield = async (label: string) => {
    checked++;
    if (checked % 500 === 0 || checked === totalItems) {
      onProgress?.({
        phase: 'validating',
        processed: checked,
        total: Math.max(1, totalItems),
        message: label,
      });
      await yieldToMain();
    }
  };

  // 1. Validate books & build bookIds set
  const books: Book[] = [];
  const bookIds = new Set<string>();
  for (let i = 0; i < rawBooks.length; i++) {
    const book = validateAndNormalizeBook(rawBooks[i], i);
    if (bookIds.has(book.id)) {
      throw new Error(`Phát hiện trùng lặp ID sách trong tệp sao lưu: "${book.id}".`);
    }
    bookIds.add(book.id);
    books.push(book);
    await stepYield(`Đang kiểm tra danh sách truyện (${i + 1}/${rawBooks.length})...`);
  }

  // 2. Validate chapters & build chapterIds + (bookId, chapterIndex) uniqueness check
  const chapters: Chapter[] = [];
  const chapterIds = new Set<string>();
  const bookChapterIndexKeys = new Set<string>();
  for (let i = 0; i < rawChapters.length; i++) {
    const ch = validateAndNormalizeChapter(rawChapters[i], i, bookIds);
    if (chapterIds.has(ch.id)) {
      throw new Error(`Phát hiện trùng lặp ID chương trong tệp sao lưu: "${ch.id}".`);
    }
    const idxKey = `${ch.bookId}\u0000${ch.chapterIndex}`;
    if (bookChapterIndexKeys.has(idxKey)) {
      throw new Error(
        `Phát hiện hai chương cùng chỉ số #${ch.chapterIndex} trong sách "${ch.bookId}".`
      );
    }
    chapterIds.add(ch.id);
    bookChapterIndexKeys.add(idxKey);
    chapters.push(ch);
    await stepYield(`Đang kiểm tra danh sách chương (${i + 1}/${rawChapters.length})...`);
  }

  // 3. Validate chapter_versions
  const chapterVersions: ChapterVersion[] = [];
  const versionIds = new Set<string>();
  for (let i = 0; i < rawVersions.length; i++) {
    const ver = validateAndNormalizeChapterVersion(rawVersions[i], i, bookIds);
    if (versionIds.has(ver.id)) {
      throw new Error(`Phát hiện trùng lặp ID lịch sử phiên bản: "${ver.id}".`);
    }
    versionIds.add(ver.id);
    chapterVersions.push(ver);
    await stepYield(`Đang kiểm tra lịch sử chỉnh sửa (${i + 1}/${rawVersions.length})...`);
  }

  // 4. Validate chapter_translations
  const chapterTranslations: ChapterTranslation[] = [];
  const transChapterIds = new Set<string>();
  for (let i = 0; i < rawTranslations.length; i++) {
    const tr = validateAndNormalizeTranslation(rawTranslations[i], i, bookIds, chapterIds);
    if (transChapterIds.has(tr.chapterId)) {
      throw new Error(`Phát hiện trùng lặp bản dịch cho chương "${tr.chapterId}".`);
    }
    transChapterIds.add(tr.chapterId);
    chapterTranslations.push(tr);
    await stepYield(`Đang kiểm tra bản dịch (${i + 1}/${rawTranslations.length})...`);
  }

  // 5. Validate bookmarks
  const bookmarks: Bookmark[] = [];
  const bookmarkIds = new Set<string>();
  for (let i = 0; i < rawBookmarks.length; i++) {
    const bm = validateAndNormalizeBookmark(rawBookmarks[i], i, bookIds);
    if (bookmarkIds.has(bm.id)) {
      throw new Error(`Phát hiện trùng lặp ID bookmark: "${bm.id}".`);
    }
    bookmarkIds.add(bm.id);
    bookmarks.push(bm);
    await stepYield(`Đang kiểm tra bookmark (${i + 1}/${rawBookmarks.length})...`);
  }

  // 6. Validate highlights
  const highlights: Highlight[] = [];
  const highlightIds = new Set<string>();
  for (let i = 0; i < rawHighlights.length; i++) {
    const hl = validateAndNormalizeHighlight(rawHighlights[i], i, bookIds);
    if (highlightIds.has(hl.id)) {
      throw new Error(`Phát hiện trùng lặp ID ghi chú đánh dấu: "${hl.id}".`);
    }
    highlightIds.add(hl.id);
    highlights.push(hl);
    await stepYield(`Đang kiểm tra ghi chú đánh dấu (${i + 1}/${rawHighlights.length})...`);
  }

  // 7. Validate dictionaries
  const dictionaries: DictionaryEntry[] = [];
  const dictIds = new Set<string>();
  let globalDictionariesCount = 0;
  for (let i = 0; i < rawDictionaries.length; i++) {
    const d = validateAndNormalizeDictionary(rawDictionaries[i], i, bookIds);
    if (dictIds.has(d.id)) {
      throw new Error(`Phát hiện trùng lặp ID mục từ điển: "${d.id}".`);
    }
    dictIds.add(d.id);
    if (d.bookId === GLOBAL_DICTIONARY_BOOK_ID) {
      globalDictionariesCount++;
    }
    dictionaries.push(d);
    await stepYield(`Đang kiểm tra từ điển (${i + 1}/${rawDictionaries.length})...`);
  }

  const normalizedSettings: ReaderSettings | undefined = data.settings
    ? { ...DEFAULT_SETTINGS, ...(data.settings as Partial<ReaderSettings>) }
    : undefined;

  const preview: BackupPreview = {
    version: data.version,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : undefined,
    booksCount: books.length,
    chaptersCount: chapters.length,
    chapterVersionsCount: chapterVersions.length,
    translationsCount: chapterTranslations.length,
    bookmarksCount: bookmarks.length,
    highlightsCount: highlights.length,
    dictionariesCount: dictionaries.length,
    globalDictionariesCount,
    hasSettings: Boolean(normalizedSettings),
    includesSiteCookies: false,
  };

  onProgress?.({
    phase: 'validating',
    processed: Math.max(1, totalItems),
    total: Math.max(1, totalItems),
    message: 'Kiểm tra tệp sao lưu hoàn tất.',
  });

  return {
    preview,
    books,
    chapters,
    chapterVersions,
    chapterTranslations,
    bookmarks,
    highlights,
    dictionaries,
    settings: normalizedSettings,
  };
}

function clearByBookIdsViaIndex(
  store: IDBObjectStore,
  bookIds: string[],
  onAllCleared: () => void
): void {
  if (bookIds.length === 0 || !store.indexNames.contains('bookId')) {
    onAllCleared();
    return;
  }

  const index = store.index('bookId');
  let pending = bookIds.length;

  for (const bookId of bookIds) {
    const req = index.openCursor(IDBKeyRange.only(bookId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        pending--;
        if (pending === 0) {
          onAllCleared();
        }
      }
    };
  }
}

export async function restoreDatabaseBackup(
  input: string | PreparedBackupData,
  options?: {
    mode?: BackupRestoreMode;
    onProgress?: (progress: BackupProgress) => void;
  }
): Promise<BackupRestoreResult> {
  const mode: BackupRestoreMode = options?.mode === 'replace' ? 'replace' : 'merge';
  const onProgress = options?.onProgress;

  const prepared =
    typeof input === 'string'
      ? await inspectAndValidateBackup(input, onProgress)
      : input;

  const db = await getDB();
  const totalWrites =
    prepared.books.length +
    prepared.chapters.length +
    prepared.chapterVersions.length +
    prepared.chapterTranslations.length +
    prepared.bookmarks.length +
    prepared.highlights.length +
    prepared.dictionaries.length +
    (prepared.settings ? 1 : 0);

  onProgress?.({
    phase: 'writing',
    processed: 0,
    total: Math.max(1, totalWrites),
    message:
      mode === 'replace'
        ? 'Đang thay thế dữ liệu thư viện trong một giao dịch an toàn...'
        : 'Đang gộp dữ liệu sao lưu vào thư viện hiện có...',
  });

  const storeNames = LIBRARY_STORES.filter((s) => db.objectStoreNames.contains(s));
  const tx = db.transaction(storeNames, 'readwrite');

  let written = 0;
  let lastReported = 0;
  const trackPut = (req: IDBRequest) => {
    req.onsuccess = () => {
      written++;
      if (written - lastReported >= 100 || written >= totalWrites) {
        lastReported = written;
        onProgress?.({
          phase: 'writing',
          processed: written,
          total: Math.max(1, totalWrites),
          message: `Đang ghi dữ liệu (${written}/${Math.max(1, totalWrites)})...`,
        });
      }
    };
  };

  if (mode === 'replace') {
    for (const storeName of storeNames) {
      tx.objectStore(storeName).clear();
    }
  }

  const writeAllBackupData = () => {
    if (tx.objectStoreNames.contains('books')) {
      const bookStore = tx.objectStore('books');
      for (const b of prepared.books) {
        trackPut(bookStore.put(b));
      }
    }

    if (tx.objectStoreNames.contains('chapters')) {
      const chStore = tx.objectStore('chapters');
      for (const ch of prepared.chapters) {
        trackPut(chStore.put(ch));
      }
    }

    if (tx.objectStoreNames.contains('chapter_versions')) {
      const vStore = tx.objectStore('chapter_versions');
      for (const ver of prepared.chapterVersions) {
        trackPut(vStore.put(ver));
      }
    }

    if (tx.objectStoreNames.contains('chapter_translations')) {
      const tStore = tx.objectStore('chapter_translations');
      for (const tr of prepared.chapterTranslations) {
        trackPut(tStore.put(tr));
      }
    }

    if (tx.objectStoreNames.contains('bookmarks')) {
      const bStore = tx.objectStore('bookmarks');
      for (const bm of prepared.bookmarks) {
        trackPut(bStore.put(bm));
      }
    }

    if (tx.objectStoreNames.contains('highlights')) {
      const hStore = tx.objectStore('highlights');
      for (const hl of prepared.highlights) {
        trackPut(hStore.put(hl));
      }
    }

    if (tx.objectStoreNames.contains('dictionaries')) {
      const dStore = tx.objectStore('dictionaries');
      for (const d of prepared.dictionaries) {
        trackPut(dStore.put(d));
      }
    }

    if (prepared.settings && tx.objectStoreNames.contains('settings')) {
      const sStore = tx.objectStore('settings');
      trackPut(sStore.put({ key: 'readerSettings', value: prepared.settings }));
    }
  };

  if (mode === 'merge') {
    // For books already present in DB whose IDs appear in the backup, clear their existing
    // chapters & translations first within this same atomic transaction so unique index
    // (bookId, chapterIndex) never collides on re-split books, while unrelated books stay intact.
    const incomingBookIds = prepared.books.map((b) => b.id);
    if (incomingBookIds.length > 0 && tx.objectStoreNames.contains('chapters')) {
      const chStore = tx.objectStore('chapters');
      const trStore = tx.objectStoreNames.contains('chapter_translations')
        ? tx.objectStore('chapter_translations')
        : null;

      let pendingCleanups = trStore ? 2 : 1;
      const onCleanupStep = () => {
        pendingCleanups--;
        if (pendingCleanups === 0) {
          writeAllBackupData();
        }
      };
      clearByBookIdsViaIndex(chStore, incomingBookIds, onCleanupStep);
      if (trStore) {
        clearByBookIdsViaIndex(trStore, incomingBookIds, onCleanupStep);
      }
    } else {
      writeAllBackupData();
    }
  } else {
    writeAllBackupData();
  }

  await awaitTransactionCompletion(
    tx,
    'Không thể hoàn tất giao dịch khôi phục dữ liệu. Dữ liệu cũ vẫn được giữ nguyên.'
  );

  onProgress?.({
    phase: 'writing',
    processed: Math.max(1, totalWrites),
    total: Math.max(1, totalWrites),
    message: 'Khôi phục dữ liệu hoàn tất.',
  });

  return {
    mode,
    preview: prepared.preview,
  };
}
