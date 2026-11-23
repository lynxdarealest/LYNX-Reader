import React from 'react';
import {
  X,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe,
  Cookie,
  Download,
  Trash2,
  Check,
  ShieldCheck,
  Plus,
  Loader2,
  ExternalLink,
  KeyRound,
  AlertTriangle,
} from 'lucide-react';
import { SiteCookieJar } from '../types';
import type { ElectronWebviewElement } from '../types/desktop';
import { extractBaseDomain, getAllSiteCookies } from '../services/storage';
import {
  hydrateServerCookiesFromIndexedDB,
  syncServerCookiesToIndexedDB,
  saveManualDomainCookie,
  clearDomainCookies,
} from '../services/webScraper';
import { listen } from '@tauri-apps/api/event';

interface BrowserModalProps {
  isOpen: boolean;
  initialUrl?: string;
  onClose: () => void;
  onImportFromUrl: (url: string) => void;
}

function normalizeInputUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const DEFAULT_BROWSER_HOME = 'https://www.pixiv.net/';
const QUICK_SITES = [
  { label: 'Pixiv Novel', url: 'https://www.pixiv.net/novel/' },
  { label: 'Syosetsu', url: 'https://ncode.syosetu.com/' },
  { label: 'Kakuyomu', url: 'https://kakuyomu.jp/' },
];

export const BrowserModal: React.FC<BrowserModalProps> = ({
  isOpen,
  initialUrl,
  onClose,
  onImportFromUrl,
}) => {
  const isElectronMode =
    typeof window !== 'undefined' && Boolean(window.desktopBridge?.isElectron);
  const isTauriMode =
    typeof window !== 'undefined' && Boolean(window.desktopBridge?.isTauri);
  const isDesktopMode = isElectronMode || isTauriMode;

  const defaultUrl = (initialUrl ? normalizeInputUrl(initialUrl) : '') || DEFAULT_BROWSER_HOME;
  const [history, setHistory] = React.useState<string[]>([defaultUrl]);
  const [historyIndex, setHistoryIndex] = React.useState<number>(0);
  const [iframeSrcUrl, setIframeSrcUrl] = React.useState(defaultUrl);
  const [liveUrl, setLiveUrl] = React.useState(defaultUrl);
  const [addressInput, setAddressInput] = React.useState(defaultUrl);
  const [pageTitle, setPageTitle] = React.useState('');
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const [isLoadingFrame, setIsLoadingFrame] = React.useState(Boolean(defaultUrl));
  const [proxyAvailable, setProxyAvailable] = React.useState<boolean | null>(
    isDesktopMode ? true : null
  );
  const [challengeBlockedUrl, setChallengeBlockedUrl] = React.useState<string | null>(null);
  const [browserError, setBrowserError] = React.useState<string | null>(null);

  const [cookieJars, setCookieJars] = React.useState<SiteCookieJar[]>([]);
  const [showCookiePopover, setShowCookiePopover] = React.useState(false);
  const [manualCookieInput, setManualCookieInput] = React.useState('');
  const [quickBannerCookie, setQuickBannerCookie] = React.useState('');
  const [cookieFeedback, setCookieFeedback] = React.useState<string | null>(null);
  const [browserLang, setBrowserLang] = React.useState<'en' | 'ja'>('en');

  const cookiePopoverRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const webviewRef = React.useRef<ElectronWebviewElement | null>(null);

  const refreshJars = React.useCallback(async () => {
    const synced = await syncServerCookiesToIndexedDB();
    setCookieJars(synced);
  }, []);

  const measureViewportBounds = React.useCallback(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return undefined;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, []);

  const openOrSyncTauriBrowser = React.useCallback(
    async (targetUrl: string) => {
      if (!window.desktopBridge?.isTauri) return;
      setBrowserError(null);
      const bounds = measureViewportBounds();
      try {
        await window.desktopBridge.openBrowserWindow?.(targetUrl, bounds);
      } catch (err: any) {
        const msg =
          typeof err === 'string'
            ? err
            : err?.message || 'Không thể mở trang web trong trình duyệt tích hợp.';
        setBrowserError(msg);
        setIsLoadingFrame(false);
      }
    },
    [measureViewportBounds]
  );

  React.useEffect(() => {
    if (!isOpen) return;
    const startUrl =
      (initialUrl ? normalizeInputUrl(initialUrl) : '') || DEFAULT_BROWSER_HOME;
    setHistory([startUrl]);
    setHistoryIndex(0);
    setIframeSrcUrl(startUrl);
    setLiveUrl(startUrl);
    setAddressInput(startUrl);
    setPageTitle('');
    setIsLoadingFrame(true);
    setShowCookiePopover(false);
    setCookieFeedback(null);
    setChallengeBlockedUrl(null);
    setBrowserError(null);

    hydrateServerCookiesFromIndexedDB(true).then(() => {
      getAllSiteCookies().then(setCookieJars);
    });

    if (window.desktopBridge?.isElectron || window.desktopBridge?.isTauri) {
      setProxyAvailable(true);
      window.desktopBridge
        .getPreferredLang()
        .then((lang) => {
          if (lang === 'ja' || lang === 'en') setBrowserLang(lang);
        })
        .catch(() => {});

      if (window.desktopBridge?.isTauri) {
        let cancelled = false;
        const raf1 = requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!cancelled) {
              openOrSyncTauriBrowser(startUrl);
            }
          });
        });
        return () => {
          cancelled = true;
          cancelAnimationFrame(raf1);
          window.desktopBridge?.browserAction?.('close').catch(() => {});
        };
      }
      return;
    }

    if (window.location.protocol === 'file:') {
      setProxyAvailable(false);
      setIsLoadingFrame(false);
      return;
    }

    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProxyAvailable(Boolean(d?.ok)))
      .catch(() => setProxyAvailable(false));

    fetch('/api/browser/preferences')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.lang === 'ja' || d?.lang === 'en') setBrowserLang(d.lang);
      })
      .catch(() => {});
  }, [isOpen, initialUrl, openOrSyncTauriBrowser]);

  // Attach native Electron <webview> listeners when running inside .exe
  React.useEffect(() => {
    if (!isOpen || !isElectronMode) return;
    const wv = webviewRef.current;
    if (!wv) return;

    const handleStartLoading = () => setIsLoadingFrame(true);
    const handleStopLoading = () => {
      setIsLoadingFrame(false);
      try {
        const u = wv.getURL();
        const t = wv.getTitle();
        if (u) {
          setLiveUrl(u);
          setAddressInput(u);
        }
        if (t) setPageTitle(t);
      } catch {
        // ignore
      }
      refreshJars();
    };
    const handleNavigate = (e: Event) => {
      const navEvent = e as Event & { url?: string };
      if (navEvent.url) {
        setLiveUrl(navEvent.url);
        setAddressInput(navEvent.url);
        setChallengeBlockedUrl(null);
        refreshJars();
      }
    };
    const handleTitleUpdate = (e: Event) => {
      const titleEvent = e as Event & { title?: string };
      if (titleEvent.title) setPageTitle(titleEvent.title);
    };

    wv.addEventListener('did-start-loading', handleStartLoading);
    wv.addEventListener('did-stop-loading', handleStopLoading);
    wv.addEventListener('did-navigate', handleNavigate);
    wv.addEventListener('did-navigate-in-page', handleNavigate);
    wv.addEventListener('page-title-updated', handleTitleUpdate);

    return () => {
      wv.removeEventListener('did-start-loading', handleStartLoading);
      wv.removeEventListener('did-stop-loading', handleStopLoading);
      wv.removeEventListener('did-navigate', handleNavigate);
      wv.removeEventListener('did-navigate-in-page', handleNavigate);
      wv.removeEventListener('page-title-updated', handleTitleUpdate);
    };
  }, [isOpen, isElectronMode, iframeSrcUrl, refreshJars]);

  // Listen to Tauri native WebView2 browser window events
  React.useEffect(() => {
    if (!isOpen || !isTauriMode) return;
    let active = true;
    const unlisteners: Array<() => void> = [];

    Promise.all([
      listen<{ url?: string; title?: string }>('browser-navigated', (event) => {
        if (!active) return;
        const u = event.payload?.url;
        const t = event.payload?.title;
        if (u) {
          setLiveUrl(u);
          setAddressInput(u);
        }
        if (t) setPageTitle(t);
        setIsLoadingFrame(false);
      }),
      listen<{ loading?: boolean; url?: string }>('browser-loading', (event) => {
        if (!active) return;
        setIsLoadingFrame(Boolean(event.payload?.loading));
      }),
      listen<SiteCookieJar[]>('browser-cookies-updated', (event) => {
        if (!active) return;
        if (Array.isArray(event.payload)) {
          setCookieJars(event.payload);
        }
        refreshJars();
      }),
    ])
      .then((fns) => {
        if (!active) {
          fns.forEach((fn) => fn());
        } else {
          unlisteners.push(...fns);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
      unlisteners.forEach((fn) => fn());
    };
  }, [isOpen, isTauriMode, refreshJars]);

  // Listen to proxied iframe postMessage updates
  React.useEffect(() => {
    if (!isOpen || isDesktopMode) return;
    const handleMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'reader-browser-state') {
        const nextUrl = typeof e.data.url === 'string' ? e.data.url : '';
        const nextTitle = typeof e.data.title === 'string' ? e.data.title : '';
        if (nextUrl) {
          setLiveUrl(nextUrl);
          setAddressInput(nextUrl);
        }
        if (nextTitle) {
          setPageTitle(nextTitle);
        }
        setChallengeBlockedUrl(e.data.challengeBlocked ? nextUrl || liveUrl : null);
        refreshJars();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isOpen, isDesktopMode, liveUrl, refreshJars]);

  // Keep embedded Tauri child webview aligned with the modal viewport
  React.useEffect(() => {
    if (!isOpen || !isTauriMode) return;
    const syncBounds = () => {
      const bounds = measureViewportBounds();
      if (bounds) {
        window.desktopBridge?.setBrowserBounds?.(bounds).catch(() => {});
      }
    };
    const el = viewportRef.current;
    const ro = el ? new ResizeObserver(syncBounds) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener('resize', syncBounds);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [isOpen, isTauriMode, measureViewportBounds]);

  // Hide embedded native WebView2 child surface when an HTML popover or error overlay is open
  React.useEffect(() => {
    if (!isOpen || !isTauriMode) return;
    if (showCookiePopover || browserError) {
      window.desktopBridge?.browserAction?.('hide').catch(() => {});
    } else {
      window.desktopBridge?.browserAction?.('show').catch(() => {});
      const bounds = measureViewportBounds();
      if (bounds) {
        window.desktopBridge?.setBrowserBounds?.(bounds).catch(() => {});
      }
    }
  }, [isOpen, isTauriMode, showCookiePopover, browserError, measureViewportBounds]);

  React.useEffect(() => {
    if (!showCookiePopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (cookiePopoverRef.current && !cookiePopoverRef.current.contains(e.target as Node)) {
        setShowCookiePopover(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showCookiePopover]);

  if (!isOpen) return null;

  const navigateTo = (rawUrl: string) => {
    const target = normalizeInputUrl(rawUrl);
    if (!target) return;
    setChallengeBlockedUrl(null);
    setBrowserError(null);
    setShowCookiePopover(false);
    setHistory((prev) => [...prev.slice(0, historyIndex + 1), target]);
    setHistoryIndex((prev) => prev + 1);
    setIframeSrcUrl(target);
    setLiveUrl(target);
    setAddressInput(target);
    setIsLoadingFrame(true);
    if (isElectronMode && webviewRef.current) {
      webviewRef.current.loadURL(target).catch(() => {});
    } else if (isTauriMode) {
      const bounds = measureViewportBounds();
      window.desktopBridge
        ?.navigateBrowserWindow?.(target, bounds)
        .catch((err: any) => {
          setBrowserError(
            typeof err === 'string' ? err : err?.message || 'Không thể tải trang web này.'
          );
          setIsLoadingFrame(false);
        });
    }
  };

  const handleBack = () => {
    if (isElectronMode && webviewRef.current) {
      if (webviewRef.current.canGoBack()) {
        webviewRef.current.goBack();
      }
      return;
    }
    if (isTauriMode) {
      window.desktopBridge?.browserAction?.('back').catch(() => {});
      return;
    }
    if (historyIndex <= 0) return;
    const nextIdx = historyIndex - 1;
    const target = history[nextIdx];
    setChallengeBlockedUrl(null);
    setHistoryIndex(nextIdx);
    setIframeSrcUrl(target);
    setLiveUrl(target);
    setAddressInput(target);
    setIsLoadingFrame(true);
  };

  const handleForward = () => {
    if (isElectronMode && webviewRef.current) {
      if (webviewRef.current.canGoForward()) {
        webviewRef.current.goForward();
      }
      return;
    }
    if (isTauriMode) {
      window.desktopBridge?.browserAction?.('forward').catch(() => {});
      return;
    }
    if (historyIndex >= history.length - 1) return;
    const nextIdx = historyIndex + 1;
    const target = history[nextIdx];
    setChallengeBlockedUrl(null);
    setHistoryIndex(nextIdx);
    setIframeSrcUrl(target);
    setLiveUrl(target);
    setAddressInput(target);
    setIsLoadingFrame(true);
  };

  const handleReload = () => {
    if (!liveUrl) return;
    setChallengeBlockedUrl(null);
    if (isElectronMode && webviewRef.current) {
      webviewRef.current.reload();
      setIsLoadingFrame(true);
      return;
    }
    if (isTauriMode) {
      window.desktopBridge?.browserAction?.('reload').catch(() => {});
      setIsLoadingFrame(true);
      return;
    }
    setIframeSrcUrl(liveUrl);
    setReloadNonce((n) => n + 1);
    setIsLoadingFrame(true);
  };

  const handleSaveManualCookie = async () => {
    if (!manualCookieInput.trim()) return;
    try {
      const updated = await saveManualDomainCookie(liveUrl, manualCookieInput);
      setCookieJars(updated);
      setManualCookieInput('');
      setCookieFeedback(`Đã lưu cookie cho ${extractBaseDomain(liveUrl)}`);
      handleReload();
      setTimeout(() => setCookieFeedback(null), 2500);
    } catch (err: any) {
      setCookieFeedback(err?.message || 'Lỗi lưu cookie');
    }
  };

  const handleSaveBannerCookie = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickBannerCookie.trim() || !liveUrl) return;
    try {
      const updated = await saveManualDomainCookie(liveUrl, quickBannerCookie);
      setCookieJars(updated);
      setQuickBannerCookie('');
      setCookieFeedback(`Đã lưu Cookie cho ${extractBaseDomain(liveUrl)}!`);
      handleReload();
      setTimeout(() => setCookieFeedback(null), 2500);
    } catch (err: any) {
      setCookieFeedback(err?.message || 'Lỗi lưu cookie');
    }
  };

  const handleClearDomain = async (domain: string) => {
    const updated = await clearDomainCookies(domain);
    setCookieJars(updated);
    setCookieFeedback(`Đã xóa cookies của ${domain}`);
    setTimeout(() => setCookieFeedback(null), 2000);
  };

  const handleSwitchBrowserLang = async (nextLang: 'en' | 'ja') => {
    setBrowserLang(nextLang);
    try {
      if (window.desktopBridge?.setPreferredLang) {
        await window.desktopBridge.setPreferredLang(nextLang);
      } else if (proxyAvailable) {
        await fetch('/api/browser/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lang: nextLang }),
        });
      }
    } catch {
      // ignore
    }

    let nextTarget = liveUrl;
    try {
      const parsed = new URL(liveUrl);
      if (extractBaseDomain(parsed.hostname) === 'pixiv.net') {
        parsed.searchParams.set('lang', nextLang);
        nextTarget = parsed.toString();
      }
    } catch {
      // keep liveUrl
    }

    if (nextTarget) {
      setIframeSrcUrl(nextTarget);
      setLiveUrl(nextTarget);
      setAddressInput(nextTarget);
      setReloadNonce((n) => n + 1);
      setIsLoadingFrame(true);
      if (isElectronMode && webviewRef.current) {
        webviewRef.current.loadURL(nextTarget).catch(() => {});
      } else if (isTauriMode) {
        const bounds = measureViewportBounds();
        window.desktopBridge?.navigateBrowserWindow?.(nextTarget, bounds).catch(() => {});
      }
    }
  };

  const currentDomain = liveUrl ? extractBaseDomain(liveUrl) : '';
  const currentJar = cookieJars.find((j) => j.domain === currentDomain);
  const currentCookieCount = currentJar?.cookies.length || 0;
  const totalDomainsCount = cookieJars.filter((j) => j.cookies.length > 0).length;

  const proxiedUrl =
    !isDesktopMode && proxyAvailable !== false && iframeSrcUrl
      ? `/api/browser/proxy?url=${encodeURIComponent(iframeSrcUrl)}&_v=${reloadNonce}`
      : '';

  const showPixivRecaptchaHelper =
    !isDesktopMode && liveUrl.includes('accounts.pixiv.net');
  const showChallengeBanner =
    !isDesktopMode && Boolean(challengeBlockedUrl) && !showPixivRecaptchaHelper;

  const handleCloseModal = () => {
    if (isTauriMode) {
      refreshJars();
      window.desktopBridge?.browserAction?.('close').catch(() => {});
    }
    onClose();
  };

  const handleImportCurrent = async () => {
    if (!liveUrl) return;
    if (isTauriMode) {
      await refreshJars();
      window.desktopBridge?.browserAction?.('close').catch(() => {});
    }
    onImportFromUrl(liveUrl);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-2xl w-full max-w-6xl h-[92vh] flex flex-col shadow-2xl overflow-hidden select-none">
        {/* Top Browser Toolbar */}
        <div className="px-3 py-2.5 border-b border-neutral-800 bg-neutral-950 flex flex-wrap items-center gap-2">
          {/* Navigation buttons */}
          <div className="flex items-center space-x-1">
            <button
              type="button"
              disabled={!isDesktopMode && historyIndex <= 0}
              onClick={handleBack}
              className="p-1.5 rounded-lg text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 cursor-pointer"
              title="Quay lại"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              disabled={!isDesktopMode && historyIndex >= history.length - 1}
              onClick={handleForward}
              className="p-1.5 rounded-lg text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 cursor-pointer"
              title="Tiến tới"
            >
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleReload}
              className="p-1.5 rounded-lg text-neutral-300 hover:bg-neutral-800 cursor-pointer"
              title="Tải lại trang"
            >
              {isLoadingFrame ? (
                <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
              ) : (
                <RotateCw className="w-4 h-4" />
              )}
            </button>
          </div>

          {/* Address Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              navigateTo(addressInput);
            }}
            className="flex-1 min-w-[220px] flex items-center space-x-1.5"
          >
            <div className="relative flex-1">
              <Globe className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
              <input
                type="text"
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
                placeholder="Nhập địa chỉ trang web (https://...)"
                className="w-full pl-8 pr-3 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-neutral-100 font-mono focus:outline-none focus:border-amber-500"
              />
            </div>
            <button
              type="submit"
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg text-xs font-medium cursor-pointer"
            >
              Đi
            </button>
          </form>

          {/* Cookie Vault Trigger & Popover */}
          <div className="relative" ref={cookiePopoverRef}>
            <button
              type="button"
              onClick={() => {
                refreshJars();
                setShowCookiePopover((prev) => !prev);
              }}
              className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition-colors ${
                currentCookieCount > 0
                  ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300 hover:bg-emerald-900/60'
                  : 'bg-neutral-900 border-neutral-700 text-neutral-300 hover:bg-neutral-800'
              }`}
              title="Cookies đã tự động lưu theo trang web"
            >
              {currentCookieCount > 0 ? (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Cookie className="w-3.5 h-3.5 text-neutral-400" />
              )}
              <span>
                {currentDomain || 'Cookies'} ({currentCookieCount})
              </span>
            </button>

            {showCookiePopover && (
              <div className="absolute right-0 top-full mt-2 w-96 max-w-[92vw] bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl p-3.5 z-50 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-neutral-100 flex items-center space-x-1.5">
                    <Cookie className="w-4 h-4 text-amber-400" />
                    <span>Kho Cookies ({totalDomainsCount} trang)</span>
                  </div>
                </div>

                {cookieFeedback && (
                  <div className="px-2.5 py-1.5 rounded-lg bg-emerald-950/70 border border-emerald-700/50 text-emerald-300 text-[11px] flex items-center space-x-1.5">
                    <Check className="w-3.5 h-3.5 shrink-0" />
                    <span>{cookieFeedback}</span>
                  </div>
                )}

                <div className="p-2.5 rounded-lg bg-neutral-950 border border-neutral-800 space-y-1.5">
                  <div className="text-[11px] text-neutral-400">
                    Thêm/cập nhật cookie cho <span className="text-amber-300 font-mono">{currentDomain}</span>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <input
                      type="password"
                      value={manualCookieInput}
                      onChange={(e) => setManualCookieInput(e.target.value)}
                      placeholder="name=value; ..."
                      className="flex-1 px-2.5 py-1 bg-neutral-900 border border-neutral-700 rounded text-[11px] font-mono text-neutral-200 focus:outline-none focus:border-amber-500"
                    />
                    <button
                      type="button"
                      onClick={handleSaveManualCookie}
                      disabled={!manualCookieInput.trim()}
                      className="flex items-center space-x-1 px-2.5 py-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white rounded text-[11px] font-semibold cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Lưu</span>
                    </button>
                  </div>
                </div>

                <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                  {cookieJars.filter((j) => j.cookies.length > 0).length === 0 ? (
                    <p className="text-neutral-500 text-[11px] text-center py-4">
                      Chưa có cookie nào.
                    </p>
                  ) : (
                    cookieJars
                      .filter((j) => j.cookies.length > 0)
                      .map((jar) => (
                        <div
                          key={jar.domain}
                          className="p-2.5 rounded-lg bg-neutral-950 border border-neutral-800 space-y-1.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono font-semibold text-neutral-200">
                              {jar.domain}
                            </span>
                            <div className="flex items-center space-x-2">
                              <span className="text-[10px] text-neutral-500 font-mono">
                                {jar.cookies.length} cookies
                              </span>
                              <button
                                type="button"
                                onClick={() => handleClearDomain(jar.domain)}
                                className="text-neutral-500 hover:text-red-400 cursor-pointer"
                                title={`Xóa cookies của ${jar.domain}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {jar.cookies.slice(0, 8).map((c, idx) => (
                              <span
                                key={`${c.name}-${idx}`}
                                className="px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-[10px] font-mono text-neutral-400"
                              >
                                {c.name}
                              </span>
                            ))}
                            {jar.cookies.length > 8 && (
                              <span className="text-[10px] text-neutral-500 font-mono">
                                +{jar.cookies.length - 8}
                              </span>
                            )}
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Import From Current Page */}
          <button
            type="button"
            disabled={!liveUrl}
            onClick={handleImportCurrent}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white rounded-lg text-xs font-semibold cursor-pointer shadow-xs"
            title="Phân tích và nhập truyện từ trang đang mở (tự dùng Cookie đã lưu)"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Lấy truyện từ trang này</span>
          </button>

          <button
            type="button"
            onClick={handleCloseModal}
            className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 cursor-pointer"
            title="Đóng trình duyệt"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Quick Site Shortcuts, Status & Language Strip */}
        <div className="px-3 py-1.5 border-b border-neutral-800 bg-neutral-900/80 flex items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center space-x-1.5 min-w-0">
            {QUICK_SITES.map((site) => {
              const active = currentDomain === extractBaseDomain(site.url);
              return (
                <button
                  key={site.url}
                  type="button"
                  onClick={() => navigateTo(site.url)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer transition-colors shrink-0 ${
                    active
                      ? 'bg-amber-600/20 text-amber-300 border border-amber-500/40'
                      : 'bg-neutral-800/80 text-neutral-300 hover:bg-neutral-700 border border-neutral-700/60'
                  }`}
                >
                  {site.label}
                </button>
              );
            })}
            <span className="text-neutral-500 truncate hidden sm:inline pl-1">
              {pageTitle || liveUrl}
            </span>
          </div>
          <div className="flex items-center space-x-2 shrink-0 ml-auto">
            {liveUrl && (
              <a
                href={liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center space-x-1 text-neutral-400 hover:text-amber-300 transition-colors"
                title="Mở liên kết trong trình duyệt mặc định"
              >
                <ExternalLink className="w-3 h-3" />
                <span>Mở ngoài</span>
              </a>
            )}
            <div className="flex items-center rounded bg-neutral-800 p-0.5 border border-neutral-700/70">
              <button
                type="button"
                onClick={() => handleSwitchBrowserLang('en')}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
                  browserLang === 'en'
                    ? 'bg-amber-600 text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
                title="Ưu tiên hiển thị trang web bằng tiếng Anh"
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => handleSwitchBrowserLang('ja')}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
                  browserLang === 'ja'
                    ? 'bg-amber-600 text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
                title="Ưu tiên hiển thị trang web bằng tiếng Nhật (nguyên bản)"
              >
                JA
              </button>
            </div>
          </div>
        </div>

        {/* Pixiv login helper when proxying in web mode */}
        {showPixivRecaptchaHelper && (
          <div className="px-3 py-2 border-b border-amber-800/40 bg-amber-950/30 flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center space-x-2 text-amber-200/90 min-w-0">
              <KeyRound className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                Trang đăng nhập yêu cầu <strong>Google reCAPTCHA</strong> theo tên miền gốc. Hãy{' '}
                <a
                  href="https://accounts.pixiv.net/login"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center space-x-0.5 text-amber-300 underline hover:text-amber-200 font-medium"
                >
                  <span>đăng nhập ở tab ngoài</span>
                  <ExternalLink className="w-3 h-3" />
                </a>{' '}
                rồi dán <code className="px-1 py-0.5 bg-black/40 rounded text-amber-300">PHPSESSID</code> vào đây:
              </span>
            </div>
            <form onSubmit={handleSaveBannerCookie} className="flex items-center space-x-1.5">
              <input
                type="password"
                value={quickBannerCookie}
                onChange={(e) => setQuickBannerCookie(e.target.value)}
                placeholder="Nhập giá trị cookie..."
                className="w-44 px-2 py-1 bg-neutral-950 border border-amber-700/50 rounded text-[11px] font-mono text-neutral-100 focus:outline-none focus:border-amber-400"
              />
              <button
                type="submit"
                disabled={!quickBannerCookie.trim()}
                className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white rounded text-[11px] font-semibold cursor-pointer"
              >
                Lưu Cookie
              </button>
            </form>
          </div>
        )}

        {/* Cloudflare verification helper when proxied page returns a Cloudflare challenge */}
        {showChallengeBanner && challengeBlockedUrl && (
          <div className="px-3 py-2 border-b border-amber-800/40 bg-amber-950/30 flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center space-x-2 text-amber-200/90 min-w-0">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                Trang đang yêu cầu xác minh bảo mật Cloudflare theo tên miền gốc.{' '}
                <a
                  href={challengeBlockedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center space-x-0.5 text-amber-300 underline hover:text-amber-200 font-medium"
                >
                  <span>Mở ở trình duyệt ngoài</span>
                  <ExternalLink className="w-3 h-3" />
                </a>{' '}
                hoặc dán cookie phiên để tiếp tục:
              </span>
            </div>
            <form onSubmit={handleSaveBannerCookie} className="flex items-center space-x-1.5">
              <input
                type="password"
                value={quickBannerCookie}
                onChange={(e) => setQuickBannerCookie(e.target.value)}
                placeholder="cf_clearance=...; ..."
                className="w-44 px-2 py-1 bg-neutral-950 border border-amber-700/50 rounded text-[11px] font-mono text-neutral-100 focus:outline-none focus:border-amber-400"
              />
              <button
                type="submit"
                disabled={!quickBannerCookie.trim()}
                className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white rounded text-[11px] font-semibold cursor-pointer"
              >
                Lưu & Tải lại
              </button>
            </form>
          </div>
        )}

        {/* Unified Browser Viewport */}
        <div ref={viewportRef} className="flex-1 bg-neutral-950 relative overflow-hidden">
          {isTauriMode ? (
            browserError ? (
              <div className="w-full h-full flex flex-col items-center justify-center text-center px-6 text-neutral-300 space-y-3">
                <AlertTriangle className="w-10 h-10 text-amber-500" />
                <p className="text-sm font-semibold text-neutral-100">
                  Không thể mở trang web trong trình duyệt tích hợp
                </p>
                <p className="text-xs text-red-400 max-w-md">{browserError}</p>
                <button
                  type="button"
                  onClick={() => openOrSyncTauriBrowser(liveUrl || DEFAULT_BROWSER_HOME)}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-semibold cursor-pointer"
                >
                  Thử lại
                </button>
              </div>
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-center px-6 text-neutral-500 space-y-2">
                {showCookiePopover ? (
                  <p className="text-xs text-neutral-400">
                    Trình duyệt tạm ẩn để hiển thị trình quản lý Cookies.
                  </p>
                ) : (
                  <>
                    <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
                    <p className="text-xs text-neutral-400">
                      Đang hiển thị trình duyệt tích hợp ({currentDomain || 'Web'})...
                    </p>
                  </>
                )}
              </div>
            )
          ) : isElectronMode ? (
            iframeSrcUrl ? (
              <webview
                ref={webviewRef}
                src={iframeSrcUrl}
                partition="persist:reader-browser"
                allowpopups
                className="w-full h-full bg-white"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-center px-6 text-neutral-500 space-y-2">
                <Globe className="w-10 h-10 text-neutral-700" />
                <p className="text-sm font-medium text-neutral-300">Trình duyệt tích hợp</p>
              </div>
            )
          ) : proxyAvailable === false ? (
            <div className="w-full h-full flex flex-col items-center justify-center text-center px-6 text-neutral-400 space-y-3">
              <AlertTriangle className="w-10 h-10 text-amber-500" />
              <p className="text-sm font-semibold text-neutral-200">
                Không có máy chủ proxy web
              </p>
              {liveUrl && (
                <a
                  href={liveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center space-x-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-semibold transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Mở {currentDomain || 'trang web'} bằng trình duyệt hệ thống</span>
                </a>
              )}
            </div>
          ) : proxiedUrl ? (
            <iframe
              key={proxiedUrl}
              src={proxiedUrl}
              title="Trình duyệt web"
              className="w-full h-full border-0 bg-white"
              onLoad={() => {
                setIsLoadingFrame(false);
                refreshJars();
              }}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-center px-6 text-neutral-500 space-y-2">
              <Globe className="w-10 h-10 text-neutral-700" />
              <p className="text-sm font-medium text-neutral-300">Trình duyệt nội bộ</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
