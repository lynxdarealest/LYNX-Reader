import React from 'react';
import {
  X,
  Settings,
  Download,
  Upload,
  HardDrive,
  Keyboard,
  Info,
  Check,
  AlertTriangle,
  Type,
  Loader2,
  ShieldAlert,
  FileJson,
  RefreshCw,
} from 'lucide-react';
import { ReaderSettings } from '../types';
import {
  BackupProgress,
  BackupRestoreMode,
  PreparedBackupData,
  StorageDiagnosticStatus,
  exportDatabaseBackup,
  getStorageDiagnostics,
  inspectAndValidateBackup,
  restoreDatabaseBackup,
  retryLegacyMigration,
} from '../services/storage';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: ReaderSettings;
  onUpdateSettings: (newSettings: Partial<ReaderSettings>) => void;
  onDataRestored: () => void | Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onDataRestored,
}) => {
  const [activeTab, setActiveTab] = React.useState<'general' | 'storage' | 'shortcuts' | 'about'>('storage');
  const [isExporting, setIsExporting] = React.useState(false);
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [isRestoring, setIsRestoring] = React.useState(false);
  const [isRetryingMigration, setIsRetryingMigration] = React.useState(false);
  const [backupProgress, setBackupProgress] = React.useState<BackupProgress | null>(null);
  const [pendingBackup, setPendingBackup] = React.useState<{
    fileName: string;
    fileSize: number;
    data: PreparedBackupData;
  } | null>(null);
  const [restoreMode, setRestoreMode] = React.useState<BackupRestoreMode>('merge');
  const [replaceConfirmed, setReplaceConfirmed] = React.useState(false);
  const [storageStatus, setStorageStatus] = React.useState<StorageDiagnosticStatus | null>(null);
  const [statusMessage, setStatusMessage] = React.useState<{ text: string; isError?: boolean } | null>(null);
  const fileRestoreInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isOpen) {
      setStorageStatus(getStorageDiagnostics());
    } else {
      setPendingBackup(null);
      setBackupProgress(null);
      setRestoreMode('merge');
      setReplaceConfirmed(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isBusy = isExporting || isInspecting || isRestoring || isRetryingMigration;

  const handleExportBackup = async () => {
    setIsExporting(true);
    setStatusMessage(null);
    setBackupProgress(null);
    try {
      const json = await exportDatabaseBackup((p) => setBackupProgress(p));
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `LYNX_Reader_Backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMessage({
        text: 'Đã xuất tệp sao lưu thư viện (v2, bao gồm lịch sử chỉnh sửa chương; không chứa cookie web).',
      });
    } catch (err: any) {
      setStatusMessage({
        text: 'Lỗi khi sao lưu dữ liệu: ' + (err?.message || 'Không xác định'),
        isError: true,
      });
    } finally {
      setIsExporting(false);
      setBackupProgress(null);
    }
  };

  const handleSelectRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsInspecting(true);
    setStatusMessage(null);
    setPendingBackup(null);
    setRestoreMode('merge');
    setReplaceConfirmed(false);
    setBackupProgress({
      phase: 'reading',
      processed: 0,
      total: 1,
      message: `Đang đọc tệp "${file.name}"...`,
    });

    try {
      const text = await file.text();
      const prepared = await inspectAndValidateBackup(text, (p) => setBackupProgress(p));
      setPendingBackup({
        fileName: file.name,
        fileSize: file.size,
        data: prepared,
      });
    } catch (err: any) {
      setStatusMessage({
        text: 'Tệp sao lưu không hợp lệ (chưa có dữ liệu nào bị thay đổi): ' + (err?.message || 'Lỗi phân tích'),
        isError: true,
      });
    } finally {
      setIsInspecting(false);
      setBackupProgress(null);
      e.target.value = '';
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingBackup || isRestoring) return;
    if (restoreMode === 'replace' && !replaceConfirmed) return;

    setIsRestoring(true);
    setStatusMessage(null);
    try {
      const result = await restoreDatabaseBackup(pendingBackup.data, {
        mode: restoreMode,
        onProgress: (p) => setBackupProgress(p),
      });
      await onDataRestored();
      setPendingBackup(null);
      setReplaceConfirmed(false);
      setStatusMessage({
        text:
          result.mode === 'replace'
            ? `Đã thay thế toàn bộ thư viện bằng ${result.preview.booksCount} truyện và ${result.preview.chaptersCount} chương thành công.`
            : `Đã gộp ${result.preview.booksCount} truyện và ${result.preview.chaptersCount} chương vào thư viện thành công.`,
      });
    } catch (err: any) {
      setStatusMessage({
        text:
          'Không thể hoàn tất khôi phục (dữ liệu trước khi khôi phục được bảo toàn): ' +
          (err?.message || 'Lỗi giao dịch lưu trữ'),
        isError: true,
      });
    } finally {
      setIsRestoring(false);
      setBackupProgress(null);
    }
  };

  const handleRetryMigration = async () => {
    setIsRetryingMigration(true);
    setStatusMessage(null);
    try {
      const next = await retryLegacyMigration();
      setStorageStatus(next);
      if (next.migrationState === 'completed') {
        await onDataRestored();
        setStatusMessage({
          text: `Đã di trú thành công ${next.migratedRecords} bản ghi từ cơ sở dữ liệu cũ.`,
        });
      } else if (next.migrationState === 'failed') {
        setStatusMessage({
          text: next.migrationError || 'Di trú dữ liệu cũ chưa thành công.',
          isError: true,
        });
      } else {
        setStatusMessage({
          text: 'Không có dữ liệu cũ cần di trú.',
        });
      }
    } catch (err: any) {
      setStatusMessage({
        text: 'Lỗi khi thử di trú lại: ' + (err?.message || 'Không xác định'),
        isError: true,
      });
    } finally {
      setIsRetryingMigration(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden select-none">
        {/* Header */}
        <div className="px-5 py-3 border-b border-neutral-800 flex items-center justify-between bg-neutral-950">
          <div className="flex items-center space-x-2">
            <Settings className="w-4 h-4 text-amber-500" />
            <h2 className="text-sm font-bold text-neutral-100">Cài đặt</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isRestoring}
            className="p-1 text-neutral-400 hover:text-neutral-200 rounded-lg hover:bg-neutral-800 transition-colors cursor-pointer disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center space-x-1 px-4 pt-2 border-b border-neutral-800 bg-neutral-950/60 text-xs">
          {[
            { id: 'storage', label: 'Dữ liệu', icon: HardDrive },
            { id: 'general', label: 'Tùy chọn', icon: Type },
            { id: 'shortcuts', label: 'Phím tắt', icon: Keyboard },
            { id: 'about', label: 'Thông tin', icon: Info },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-t-lg transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-neutral-900 text-amber-400 border-t-2 border-amber-500 font-semibold'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Body Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {statusMessage && (
            <div
              className={`p-3 rounded-lg border text-xs flex items-start space-x-2 ${
                statusMessage.isError
                  ? 'bg-red-900/30 border-red-700/50 text-red-300'
                  : 'bg-emerald-900/30 border-emerald-700/50 text-emerald-300'
              }`}
            >
              {statusMessage.isError ? (
                <AlertTriangle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
              ) : (
                <Check className="w-4 h-4 shrink-0 text-emerald-400 mt-0.5" />
              )}
              <span className="leading-relaxed">{statusMessage.text}</span>
            </div>
          )}

          {activeTab === 'storage' && (
            <div className="space-y-4">
              {storageStatus?.migrationState === 'failed' && (
                <div className="p-4 bg-red-950/35 border border-red-800/60 rounded-xl space-y-2.5">
                  <div className="flex items-start space-x-2 text-red-300">
                    <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                    <div className="space-y-1">
                      <p className="font-semibold">Di trú dữ liệu từ phiên bản cũ chưa hoàn tất</p>
                      <p className="text-[11px] text-red-200/80 leading-relaxed">
                        {storageStatus.migrationError ||
                          'Không thể sao chép toàn bộ dữ liệu từ VBookDesktopDB sang LynxReaderDB.'}
                      </p>
                      <p className="text-[11px] text-neutral-300 leading-relaxed">
                        Dữ liệu gốc trong <code className="text-amber-300">VBookDesktopDB</code> vẫn được giữ nguyên. Không xóa dữ liệu trình duyệt/WebView; hãy xuất tệp sao lưu thư viện hiện tại trước khi thử di trú lại.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleRetryMigration}
                    disabled={isBusy}
                    className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-red-700/80 hover:bg-red-600 text-white rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRetryingMigration ? 'animate-spin' : ''}`} />
                    <span>Thử di trú lại</span>
                  </button>
                </div>
              )}

              <div className="p-4 bg-neutral-950 rounded-xl border border-neutral-800 space-y-3">
                <div>
                  <h3 className="font-semibold text-neutral-200 text-sm">Sao lưu & Khôi phục</h3>
                  <p className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
                    Sao lưu bao gồm: truyện, chương, lịch sử chỉnh sửa chương, bản dịch, bookmark, đoạn đánh dấu, từ điển và cài đặt đọc. Cookie đăng nhập web không được xuất vào tệp sao lưu để bảo vệ phiên đăng nhập.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    onClick={handleExportBackup}
                    disabled={isBusy}
                    className="flex items-center space-x-1.5 px-3.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {isExporting ? (
                      <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5 text-amber-500" />
                    )}
                    <span>{isExporting ? 'Đang xuất...' : 'Xuất file sao lưu (.json)'}</span>
                  </button>

                  <button
                    onClick={() => fileRestoreInputRef.current?.click()}
                    disabled={isBusy}
                    className="flex items-center space-x-1.5 px-3.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {isInspecting ? (
                      <Loader2 className="w-3.5 h-3.5 text-emerald-500 animate-spin" />
                    ) : (
                      <Upload className="w-3.5 h-3.5 text-emerald-500" />
                    )}
                    <span>{isInspecting ? 'Đang kiểm tra tệp...' : 'Chọn tệp khôi phục (.json)'}</span>
                  </button>
                  <input
                    ref={fileRestoreInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={handleSelectRestoreFile}
                  />
                </div>

                {backupProgress && (
                  <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] text-neutral-300">
                      <span>{backupProgress.message}</span>
                      <span className="font-mono text-amber-400">
                        {Math.min(
                          100,
                          Math.round((backupProgress.processed / Math.max(1, backupProgress.total)) * 100)
                        )}
                        %
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-500 transition-all duration-150"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.round((backupProgress.processed / Math.max(1, backupProgress.total)) * 100)
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {pendingBackup && (
                  <div className="p-4 bg-neutral-900 border border-neutral-700 rounded-xl space-y-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center space-x-2 min-w-0">
                        <FileJson className="w-4 h-4 text-amber-400 shrink-0" />
                        <div className="min-w-0">
                          <div className="font-semibold text-neutral-100 truncate">
                            {pendingBackup.fileName}
                          </div>
                          <div className="text-[11px] text-neutral-400">
                            {formatBytes(pendingBackup.fileSize)} • Định dạng v{pendingBackup.data.preview.version}
                            {pendingBackup.data.preview.exportedAt
                              ? ` • Xuất lúc ${new Date(pendingBackup.data.preview.exportedAt).toLocaleString('vi-VN')}`
                              : ''}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingBackup(null);
                          setReplaceConfirmed(false);
                        }}
                        disabled={isRestoring}
                        className="p-1 text-neutral-400 hover:text-neutral-200 rounded hover:bg-neutral-800 disabled:opacity-40"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Preview Counts */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                      <div className="p-2 bg-neutral-950 rounded-lg border border-neutral-800">
                        <div className="text-neutral-400">Truyện</div>
                        <div className="text-sm font-bold text-neutral-100 font-mono">
                          {pendingBackup.data.preview.booksCount}
                        </div>
                      </div>
                      <div className="p-2 bg-neutral-950 rounded-lg border border-neutral-800">
                        <div className="text-neutral-400">Chương</div>
                        <div className="text-sm font-bold text-neutral-100 font-mono">
                          {pendingBackup.data.preview.chaptersCount}
                        </div>
                      </div>
                      <div className="p-2 bg-neutral-950 rounded-lg border border-neutral-800">
                        <div className="text-neutral-400">Bản dịch</div>
                        <div className="text-sm font-bold text-neutral-100 font-mono">
                          {pendingBackup.data.preview.translationsCount}
                        </div>
                      </div>
                      <div className="p-2 bg-neutral-950 rounded-lg border border-neutral-800">
                        <div className="text-neutral-400">Lịch sử sửa</div>
                        <div className="text-sm font-bold text-neutral-100 font-mono">
                          {pendingBackup.data.preview.chapterVersionsCount}
                        </div>
                      </div>
                      <div className="p-2 bg-neutral-950 rounded-lg border border-neutral-800">
                        <div className="text-neutral-400">Bookmark</div>
                        <div className="text-sm font-bold text-neutral-100 font-mono">
                          {pendingBackup.data.preview.bookmarksCount}
                        </div>
                      </div>
                      <div className="p-2 bg-neutral-950 rounded-lg border border-neutral-800">
                        <div className="text-neutral-400">Đánh dấu</div>
                        <div className="text-sm font-bold text-neutral-100 font-mono">
                          {pendingBackup.data.preview.highlightsCount}
                        </div>
                      </div>
                      <div className="p-2 bg-neutral-950 rounded-lg border border-neutral-800">
                        <div className="text-neutral-400">Từ điển</div>
                        <div className="text-sm font-bold text-neutral-100 font-mono">
                          {pendingBackup.data.preview.dictionariesCount}
                        </div>
                      </div>
                      <div className="p-2 bg-neutral-950 rounded-lg border border-neutral-800">
                        <div className="text-neutral-400">Cài đặt đọc</div>
                        <div className="text-sm font-bold text-neutral-100">
                          {pendingBackup.data.preview.hasSettings ? 'Có' : 'Không'}
                        </div>
                      </div>
                    </div>

                    {/* Restore Mode Selection */}
                    <div className="space-y-2">
                      <div className="font-semibold text-neutral-200">Chọn chế độ khôi phục:</div>

                      <label
                        className={`flex items-start space-x-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                          restoreMode === 'merge'
                            ? 'bg-emerald-950/25 border-emerald-700/60'
                            : 'bg-neutral-950 border-neutral-800 hover:border-neutral-700'
                        }`}
                      >
                        <input
                          type="radio"
                          name="restoreMode"
                          checked={restoreMode === 'merge'}
                          onChange={() => {
                            setRestoreMode('merge');
                            setReplaceConfirmed(false);
                          }}
                          disabled={isRestoring}
                          className="mt-0.5 accent-emerald-500"
                        />
                        <div className="space-y-0.5">
                          <div className="font-semibold text-neutral-100">
                            Gộp vào dữ liệu hiện có (Khuyên dùng)
                          </div>
                          <div className="text-[11px] text-neutral-400 leading-relaxed">
                            Giữ nguyên các truyện hiện có không nằm trong tệp sao lưu. Nếu trùng mã truyện, nội dung truyện, chương và bản dịch của truyện đó sẽ được cập nhật theo bản sao lưu.
                          </div>
                        </div>
                      </label>

                      <label
                        className={`flex items-start space-x-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                          restoreMode === 'replace'
                            ? 'bg-red-950/30 border-red-700/70'
                            : 'bg-neutral-950 border-neutral-800 hover:border-neutral-700'
                        }`}
                      >
                        <input
                          type="radio"
                          name="restoreMode"
                          checked={restoreMode === 'replace'}
                          onChange={() => setRestoreMode('replace')}
                          disabled={isRestoring}
                          className="mt-0.5 accent-red-500"
                        />
                        <div className="space-y-0.5">
                          <div className="font-semibold text-red-300">
                            Thay thế toàn bộ dữ liệu hiện có
                          </div>
                          <div className="text-[11px] text-neutral-400 leading-relaxed">
                            Xóa toàn bộ truyện, chương, lịch sử chỉnh sửa, bản dịch, bookmark, đánh dấu, từ điển và cài đặt đọc đang có trên máy trước khi nạp tệp sao lưu (cookie đăng nhập web được giữ nguyên).
                          </div>
                        </div>
                      </label>
                    </div>

                    {restoreMode === 'replace' && (
                      <div className="p-3 bg-red-950/40 border border-red-700/60 rounded-lg space-y-2">
                        <div className="flex items-start space-x-2 text-red-300 text-[11px]">
                          <AlertTriangle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
                          <span>
                            Hành động này sẽ xóa toàn bộ thư viện hiện tại trước khi ghi dữ liệu mới và không thể hoàn tác. Hãy chắc chắn bạn đã xuất sao lưu nếu cần giữ dữ liệu hiện tại.
                          </span>
                        </div>
                        <label className="flex items-center space-x-2 text-neutral-200 cursor-pointer text-[11px]">
                          <input
                            type="checkbox"
                            checked={replaceConfirmed}
                            onChange={(e) => setReplaceConfirmed(e.target.checked)}
                            disabled={isRestoring}
                            className="accent-red-500 rounded"
                          />
                          <span>Tôi hiểu dữ liệu thư viện hiện tại sẽ bị xóa hoàn toàn.</span>
                        </label>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setPendingBackup(null);
                          setReplaceConfirmed(false);
                        }}
                        disabled={isRestoring}
                        className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
                      >
                        Hủy
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmRestore}
                        disabled={isRestoring || (restoreMode === 'replace' && !replaceConfirmed)}
                        className={`flex items-center space-x-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors cursor-pointer disabled:opacity-50 ${
                          restoreMode === 'replace'
                            ? 'bg-red-600 hover:bg-red-500'
                            : 'bg-emerald-600 hover:bg-emerald-500'
                        }`}
                      >
                        {isRestoring ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Đang khôi phục...</span>
                          </>
                        ) : (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>
                              {restoreMode === 'replace'
                                ? 'Xác nhận thay thế toàn bộ'
                                : 'Xác nhận gộp dữ liệu'}
                            </span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="space-y-4">
              <div className="p-4 bg-neutral-950 rounded-xl border border-neutral-800 space-y-3">
                <h4 className="font-semibold text-neutral-200">Tùy chọn đọc</h4>

                <label className="flex items-center justify-between text-neutral-300 cursor-pointer">
                  <span>Tự động chuyển chương khi đọc hết (TTS)</span>
                  <input
                    type="checkbox"
                    checked={settings.ttsAutoNextChapter}
                    onChange={(e) => onUpdateSettings({ ttsAutoNextChapter: e.target.checked })}
                    className="accent-amber-500 rounded"
                  />
                </label>

                <label className="flex items-center justify-between text-neutral-300 cursor-pointer pt-2 border-t border-neutral-850">
                  <span>Áp dụng từ điển riêng khi đọc truyện</span>
                  <input
                    type="checkbox"
                    checked={settings.applyDictionary}
                    onChange={(e) => onUpdateSettings({ applyDictionary: e.target.checked })}
                    className="accent-amber-500 rounded"
                  />
                </label>
              </div>
            </div>
          )}

          {activeTab === 'shortcuts' && (
            <div className="p-4 bg-neutral-950 rounded-xl border border-neutral-800 space-y-3">
              <div className="flex items-center justify-between mb-1">
                <h4 className="font-semibold text-neutral-200">Phím tắt</h4>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[
                  { key: '] / [', desc: 'Chương sau / Chương trước' },
                  { key: '→ / ← / Cách', desc: 'Trang tiếp / Trang trước' },
                  { key: 'J / K', desc: 'Cuộn từng đoạn xuống / lên' },
                  { key: 'C', desc: 'Đổi chủ đề tiếp theo' },
                  { key: 'L', desc: 'Chuyển nhanh Sáng / Tối' },
                  { key: '1 - 6', desc: 'Chọn nhanh Paper, Sepia, Light...' },
                  { key: '+ / -', desc: 'Tăng / Giảm cỡ chữ' },
                  { key: 'R', desc: 'Chuyển đổi chế độ đọc' },
                  { key: 'H', desc: 'Ẩn / Hiện thanh công cụ (Zen)' },
                  { key: 'M / S', desc: 'Mục lục chương / Cài đặt' },
                  { key: 'B / Shift+B', desc: 'Đánh dấu / Danh sách bookmark' },
                  { key: 'T / P', desc: 'Bật TTS / Phát & Tạm dừng đọc' },
                  { key: 'F11 / F', desc: 'Toàn màn hình' },
                  { key: 'Esc', desc: 'Thoát về thư viện' },
                ].map((s, idx) => (
                  <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-neutral-900 border border-neutral-800">
                    <span className="text-neutral-300 text-[11px]">{s.desc}</span>
                    <kbd className="px-2 py-0.5 rounded bg-neutral-800 border border-neutral-700 font-mono text-[10px] text-amber-400 font-semibold">
                      {s.key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="p-4 bg-neutral-950 rounded-xl border border-neutral-800 space-y-3 text-neutral-300 leading-relaxed">
              <div className="flex items-center space-x-3">
                <div className="w-9 h-9 rounded-lg bg-amber-600/20 text-amber-500 border border-amber-500/30 flex items-center justify-center font-bold text-sm">
                  LR
                </div>
                <div>
                  <h3 className="font-bold text-neutral-100 text-sm">LYNX Reader</h3>
                  <p className="text-[11px] text-neutral-400 font-mono">Phiên bản 0.1.0</p>
                </div>
              </div>
              <p className="text-[11px] text-neutral-400">
                Ứng dụng đọc truyện chữ cục bộ. Dữ liệu thư viện lưu trên thiết bị của bạn bằng IndexedDB. Phiên bản mới hiện cần tải thủ công từ GitHub Releases (chưa hỗ trợ tự động cập nhật trong ứng dụng).
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-neutral-800 bg-neutral-950 flex items-center justify-end">
          <button
            onClick={onClose}
            disabled={isRestoring}
            className="px-4 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
