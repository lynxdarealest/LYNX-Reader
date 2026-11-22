import { invoke } from '@tauri-apps/api/core';
import type { SiteCookieJar, WebNovelInspectResult } from '../types';
import type { DesktopFetchChapterResult } from '../types/desktop';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function initDesktopBridge(): void {
  if (!isTauriRuntime() || window.desktopBridge) return;

  window.desktopBridge = {
    isElectron: false,
    isTauri: true,
    translate: (joinedPayload: string) =>
      invoke<string>('desktop_translate', { joinedPayload }),
    analyzePhrase: (phrase: string) =>
      invoke<{ vi?: string; nameEng?: string }>('desktop_analyze_phrase', { phrase }),
    inspectUrl: (url: string, cookie?: string) =>
      invoke<WebNovelInspectResult>('desktop_inspect_url', { url, cookie: cookie ?? null }),
    fetchChapter: (params) =>
      invoke<DesktopFetchChapterResult>('desktop_fetch_chapter', { params }),
    getAllCookies: () => invoke<SiteCookieJar[]>('desktop_get_all_cookies'),
    syncCookieJars: (jars: SiteCookieJar[]) =>
      invoke<SiteCookieJar[]>('desktop_sync_cookie_jars', { jars }),
    setManualCookie: (domainOrUrl: string, cookieString: string) =>
      invoke<SiteCookieJar[]>('desktop_set_manual_cookie', { domainOrUrl, cookieString }),
    clearDomainCookies: (domain: string) =>
      invoke<SiteCookieJar[]>('desktop_clear_domain_cookies', { domain }),
    getPreferredLang: () => invoke<'en' | 'ja'>('desktop_get_preferred_lang'),
    setPreferredLang: (lang: 'en' | 'ja') =>
      invoke<'en' | 'ja'>('desktop_set_preferred_lang', { lang }),
    openBrowserWindow: (url?: string) =>
      invoke<void>('desktop_open_browser_window', { url: url ?? null }),
    navigateBrowserWindow: (url: string) =>
      invoke<void>('desktop_browser_navigate', { url }),
    browserAction: (action: 'back' | 'forward' | 'reload' | 'focus' | 'close') =>
      invoke<void>('desktop_browser_action', { action }),
  };
}
