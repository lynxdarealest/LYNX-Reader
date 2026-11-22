use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use regex::Regex;
use reqwest::header::{
    HeaderMap, ACCEPT, ACCEPT_LANGUAGE, CONTENT_TYPE, COOKIE, ORIGIN, REFERER, SET_COOKIE,
    USER_AGENT,
};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex;
use url::Url;

const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TWO_PART_TLDS: &[&str] = &[
    "co.jp", "ne.jp", "or.jp", "ac.jp", "com.vn", "net.vn", "org.vn", "edu.vn", "co.uk",
    "org.uk", "com.cn", "com.tw", "com.hk", "com.au",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCookieEntry {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteCookieJar {
    pub domain: String,
    pub cookies: Vec<StoredCookieEntry>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebNovelChapterMeta {
    pub index: usize,
    pub id: String,
    pub title: String,
    pub url: String,
    pub source_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_cookie: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesInfo {
    pub series_id: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebNovelInspectResult {
    pub source_type: String,
    pub normalized_url: String,
    pub title: String,
    pub author: String,
    pub description: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_data_url: Option<String>,
    pub chapters: Vec<WebNovelChapterMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_cookie: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restriction_notice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_info: Option<SeriesInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFetchChapterResult {
    pub title: String,
    pub content: String,
    pub word_count: usize,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzePhraseResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_eng: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchChapterParams {
    pub url: String,
    pub source_type: Option<String>,
    pub novel_id: Option<String>,
    pub cookie: Option<String>,
}

pub struct AppState {
    pub client: reqwest::Client,
    pub cookies_by_domain: Mutex<HashMap<String, SiteCookieJar>>,
    pub cookies_file_path: PathBuf,
    pub preferred_lang: Mutex<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn extract_base_domain(url_or_host: &str) -> String {
    let mut host = url_or_host.trim().to_lowercase();
    if host.contains("://") {
        if let Ok(parsed) = Url::parse(&host) {
            if let Some(h) = parsed.host_str() {
                host = h.to_lowercase();
            }
        }
    }
    host = host.trim_start_matches('.').split(':').next().unwrap_or("").to_string();
    let parts: Vec<&str> = host.split('.').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 2 {
        return host;
    }
    let last_two = format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1]);
    if TWO_PART_TLDS.contains(&last_two.as_str()) && parts.len() >= 3 {
        return format!("{}.{}", parts[parts.len() - 3], last_two);
    }
    last_two
}

fn assert_public_http_url(raw_url: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|_| "URL không hợp lệ. Vui lòng nhập đầy đủ http:// hoặc https://".to_string())?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Chỉ hỗ trợ giao thức HTTP và HTTPS.".to_string());
    }
    Ok(parsed)
}

fn load_cookies_from_disk(path: &PathBuf) -> HashMap<String, SiteCookieJar> {
    let Ok(raw) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(jars) = serde_json::from_str::<Vec<SiteCookieJar>>(&raw) else {
        return HashMap::new();
    };
    let current = now_ms();
    let mut map = HashMap::new();
    for mut jar in jars {
        jar.cookies.retain(|c| c.expires_at.map(|e| e > current).unwrap_or(true));
        if !jar.domain.is_empty() && !jar.cookies.is_empty() {
            map.insert(jar.domain.clone(), jar);
        }
    }
    map
}

fn save_cookies_to_disk(path: &PathBuf, map: &HashMap<String, SiteCookieJar>) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let jars: Vec<&SiteCookieJar> = map.values().collect();
    if let Ok(json) = serde_json::to_string_pretty(&jars) {
        let _ = fs::write(path, json);
    }
}

fn jars_vec_from_map(map: &HashMap<String, SiteCookieJar>) -> Vec<SiteCookieJar> {
    let current = now_ms();
    let mut result = Vec::new();
    for jar in map.values() {
        let active: Vec<StoredCookieEntry> = jar
            .cookies
            .iter()
            .filter(|c| c.expires_at.map(|e| e > current).unwrap_or(true))
            .cloned()
            .collect();
        if !active.is_empty() {
            result.push(SiteCookieJar {
                domain: jar.domain.clone(),
                cookies: active,
                updated_at: jar.updated_at,
            });
        }
    }
    result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    result
}

fn upsert_cookie_entry(
    map: &mut HashMap<String, SiteCookieJar>,
    base_domain: &str,
    entry: StoredCookieEntry,
) {
    if base_domain.is_empty() || entry.name.is_empty() {
        return;
    }
    let jar = map
        .entry(base_domain.to_string())
        .or_insert_with(|| SiteCookieJar {
            domain: base_domain.to_string(),
            cookies: Vec::new(),
            updated_at: now_ms(),
        });
    jar.updated_at = now_ms();
    if let Some(existing) = jar
        .cookies
        .iter_mut()
        .find(|c| c.name == entry.name && c.domain == entry.domain && c.path == entry.path)
    {
        *existing = entry;
    } else {
        jar.cookies.push(entry);
    }
}

async fn merge_set_cookies_from_headers(
    headers: &HeaderMap,
    request_url: &Url,
    state: &AppState,
) {
    let values: Vec<String> = headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect();
    if values.is_empty() {
        return;
    }

    let req_host = request_url.host_str().unwrap_or("");
    let mut map = state.cookies_by_domain.lock().await;
    let current = now_ms();

    for raw in values {
        let parts: Vec<&str> = raw.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        let Some(eq_idx) = parts[0].find('=') else {
            continue;
        };
        let name = parts[0][..eq_idx].trim().to_string();
        let value = parts[0][eq_idx + 1..].trim().to_string();
        if name.is_empty() {
            continue;
        }

        let mut domain = req_host.to_string();
        let mut path = "/".to_string();
        let mut expires_at: Option<u64> = None;
        let mut http_only = false;
        let mut secure = request_url.scheme() == "https";

        for attr in parts.iter().skip(1) {
            if let Some(a_eq) = attr.find('=') {
                let k = attr[..a_eq].trim().to_lowercase();
                let v = attr[a_eq + 1..].trim();
                if k == "domain" && !v.is_empty() {
                    domain = v.trim_start_matches('.').to_string();
                } else if k == "path" && !v.is_empty() {
                    path = if v.starts_with('/') {
                        v.to_string()
                    } else {
                        "/".to_string()
                    };
                } else if k == "max-age" {
                    if let Ok(sec) = v.parse::<i64>() {
                        if sec <= 0 {
                            expires_at = Some(current.saturating_sub(1));
                        } else {
                            expires_at = Some(current + (sec as u64) * 1000);
                        }
                    }
                }
            } else {
                let k = attr.trim().to_lowercase();
                if k == "httponly" {
                    http_only = true;
                } else if k == "secure" {
                    secure = true;
                }
            }
        }

        let base_domain = extract_base_domain(&domain);
        upsert_cookie_entry(
            &mut map,
            &base_domain,
            StoredCookieEntry {
                name,
                value,
                domain,
                path,
                expires_at,
                http_only: Some(http_only),
                secure: Some(secure),
            },
        );
    }

    save_cookies_to_disk(&state.cookies_file_path, &map);
}

async fn sync_webview_cookies_into_state(app: &AppHandle, state: &AppState) -> Vec<SiteCookieJar> {
    if let Some(browser_win) = app.get_webview_window("reader-browser") {
        if let Ok(wv_cookies) = browser_win.cookies() {
            let mut map = state.cookies_by_domain.lock().await;
            for c in wv_cookies {
                let raw_domain = c.domain().unwrap_or("").trim_start_matches('.').to_string();
                if raw_domain.is_empty() {
                    continue;
                }
                let base_domain = extract_base_domain(&raw_domain);
                upsert_cookie_entry(
                    &mut map,
                    &base_domain,
                    StoredCookieEntry {
                        name: c.name().to_string(),
                        value: c.value().to_string(),
                        domain: raw_domain,
                        path: c.path().unwrap_or("/").to_string(),
                        expires_at: None,
                        http_only: c.http_only(),
                        secure: c.secure(),
                    },
                );
            }
            save_cookies_to_disk(&state.cookies_file_path, &map);
            return jars_vec_from_map(&map);
        }
    }
    let map = state.cookies_by_domain.lock().await;
    jars_vec_from_map(&map)
}

async fn build_cookie_header_for_url(
    target_url: &Url,
    override_cookie: Option<&str>,
    app: &AppHandle,
    state: &AppState,
) -> Option<String> {
    let host = target_url.host_str().unwrap_or("").to_lowercase();
    let base_domain = extract_base_domain(&host);
    let current = now_ms();
    let mut cookie_map: HashMap<String, String> = HashMap::new();

    // 1. Live WebView2 cookies for this URL if browser window exists
    if let Some(browser_win) = app.get_webview_window("reader-browser") {
        if let Ok(wv_cookies) = browser_win.cookies_for_url(target_url.clone()) {
            for c in wv_cookies {
                cookie_map.insert(c.name().to_string(), c.value().to_string());
            }
        }
    }

    // 2. Stored persistent Cookie Jar
    {
        let map = state.cookies_by_domain.lock().await;
        if let Some(jar) = map.get(&base_domain) {
            for c in &jar.cookies {
                if c.expires_at.map(|e| e <= current).unwrap_or(false) {
                    continue;
                }
                let c_dom = c.domain.trim_start_matches('.').to_lowercase();
                if host == c_dom || host.ends_with(&format!(".{c_dom}")) || c_dom == base_domain {
                    cookie_map.insert(c.name.clone(), c.value.clone());
                }
            }
        }
    }

    // 3. Explicit override cookie from user input
    if let Some(raw) = override_cookie {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let normalized = if !trimmed.contains('=') && base_domain == "pixiv.net" {
                format!("PHPSESSID={trimmed}")
            } else {
                trimmed.to_string()
            };
            for part in normalized.split(';') {
                let p = part.trim();
                if let Some(eq_idx) = p.find('=') {
                    let k = p[..eq_idx].trim().to_string();
                    let v = p[eq_idx + 1..].trim().to_string();
                    if !k.is_empty() {
                        cookie_map.insert(k, v);
                    }
                }
            }
        }
    }

    if cookie_map.is_empty() {
        None
    } else {
        Some(
            cookie_map
                .into_iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }
}

fn count_words_simple(text: &str) -> usize {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let space_words = trimmed.split_whitespace().count();
    if space_words < trimmed.chars().count() / 8 {
        trimmed.chars().filter(|c| !c.is_whitespace()).count()
    } else {
        space_words
    }
}

fn strip_html_to_text(html: &str) -> String {
    if html.trim().is_empty() {
        return String::new();
    }
    let br_re = Regex::new(r"(?i)<br\s*/?>").unwrap();
    let block_end_re = Regex::new(r"(?i)</(p|div|li|h[1-6]|tr)>").unwrap();
    let multi_nl_re = Regex::new(r"\n{3,}").unwrap();

    let step1 = br_re.replace_all(html, "\n");
    let step2 = block_end_re.replace_all(&step1, "\n\n");
    let frag = Html::parse_fragment(&step2);
    let raw_text: String = frag.root_element().text().collect();

    let normalized = raw_text
        .replace("\r\n", "\n")
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n");

    multi_nl_re.replace_all(normalized.trim(), "\n\n").to_string()
}

fn clean_pixiv_novel_content(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let mut text = raw.replace("\r\n", "\n");
    let rb_re = Regex::new(r"\[\[rb:([^\]>]+?)\s*>\s*([^\]]+?)\]\]").unwrap();
    let jumpuri_re = Regex::new(r"\[\[jumpuri:([^\]>]+?)\s*>\s*[^\]]+?\]\]").unwrap();
    let chapter_re = Regex::new(r"\[chapter:([^\]]+?)\]").unwrap();
    let jump_re = Regex::new(r"\[jump:\d+\]").unwrap();
    let pimg_re = Regex::new(r"\[pixivimage:([^\]]+?)\]").unwrap();
    let uimg_re = Regex::new(r"\[uploadedimage:([^\]]+?)\]").unwrap();
    let multi_nl_re = Regex::new(r"\n{3,}").unwrap();

    text = rb_re.replace_all(&text, "$1 ($2)").to_string();
    text = jumpuri_re.replace_all(&text, "$1").to_string();
    text = chapter_re.replace_all(&text, "\n\n$1\n\n").to_string();
    text = text.replace("[newpage]", "\n\n");
    text = jump_re.replace_all(&text, "").to_string();
    text = pimg_re.replace_all(&text, "\n[Ảnh minh họa #$1]\n").to_string();
    text = uimg_re.replace_all(&text, "\n[Ảnh đính kèm #$1]\n").to_string();
    multi_nl_re.replace_all(text.trim(), "\n\n").to_string()
}

struct InlineChapter {
    title: String,
    content: String,
    word_count: usize,
}

fn split_pixiv_inline_chapters(raw_content: &str, fallback_title: &str) -> Vec<InlineChapter> {
    let normalized = raw_content.replace("\r\n", "\n");
    let ch_re = Regex::new(r"(?m)^\[chapter:([^\]]+)\]\s*$").unwrap();
    let matches: Vec<(usize, usize, String)> = ch_re
        .captures_iter(&normalized)
        .filter_map(|cap| {
            let full = cap.get(0)?;
            let title = cap.get(1)?.as_str().trim().to_string();
            Some((full.start(), full.end(), title))
        })
        .collect();

    if matches.len() <= 1 {
        let cleaned = clean_pixiv_novel_content(&normalized);
        let title = if matches.len() == 1 {
            matches[0].2.clone()
        } else {
            fallback_title.to_string()
        };
        return vec![InlineChapter {
            title,
            word_count: count_words_simple(&cleaned),
            content: cleaned,
        }];
    }

    let mut chapters = Vec::new();
    let first_start = matches[0].0;
    if first_start > 0 {
        let preface = clean_pixiv_novel_content(&normalized[..first_start]);
        if preface.chars().count() > 20 {
            chapters.push(InlineChapter {
                title: format!("{fallback_title} - Mở đầu"),
                word_count: count_words_simple(&preface),
                content: preface,
            });
        }
    }

    for i in 0..matches.len() {
        let start = matches[i].1;
        let end = if i + 1 < matches.len() {
            matches[i + 1].0
        } else {
            normalized.len()
        };
        let body = clean_pixiv_novel_content(&normalized[start..end]);
        if !body.is_empty() {
            let ch_title = if matches[i].2.is_empty() {
                format!("Phần {}", i + 1)
            } else {
                matches[i].2.clone()
            };
            chapters.push(InlineChapter {
                title: ch_title,
                word_count: count_words_simple(&body),
                content: body,
            });
        }
    }

    chapters
}

fn get_pixiv_restriction_reason(detail: &Value) -> Option<String> {
    if let Some(content) = detail.get("content").and_then(|v| v.as_str()) {
        if !content.trim().is_empty() {
            return None;
        }
    }
    if detail
        .get("xRestrict")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        >= 1
    {
        return Some(
            "Truyện Pixiv này gắn nhãn R-18/R-18G nên cần đăng nhập Pixiv và bật xem R-18 trong trình duyệt."
                .to_string(),
        );
    }
    if detail
        .get("isLoginOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Some("Truyện Pixiv này yêu cầu đăng nhập mới xem được nội dung.".to_string());
    }
    Some("Pixiv không trả về nội dung văn bản cho chương này.".to_string())
}

async fn fetch_image_as_data_url(
    image_url: &str,
    referer: &str,
    override_cookie: Option<&str>,
    app: &AppHandle,
    state: &AppState,
) -> Option<String> {
    if image_url.trim().is_empty() {
        return None;
    }
    let parsed = assert_public_http_url(image_url).ok()?;
    let mut req = state
        .client
        .get(parsed.as_str())
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(REFERER, referer)
        .timeout(Duration::from_secs(10));

    if let Some(ck) = build_cookie_header_for_url(&parsed, override_cookie, app, state).await {
        req = req.header(COOKIE, ck);
    }

    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ct = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    if !ct.starts_with("image/") {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() > 3 * 1024 * 1024 {
        return None;
    }
    let mime = ct.split(';').next().unwrap_or("image/jpeg");
    Some(format!("data:{mime};base64,{}", BASE64_STANDARD.encode(&bytes)))
}

async fn fetch_pixiv_novel_detail(
    novel_id: &str,
    override_cookie: Option<&str>,
    app: &AppHandle,
    state: &AppState,
) -> Result<Value, String> {
    let url_str = format!("https://www.pixiv.net/ajax/novel/{novel_id}");
    let parsed = Url::parse(&url_str).map_err(|e| e.to_string())?;
    let mut req = state
        .client
        .get(&url_str)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(REFERER, "https://www.pixiv.net/")
        .header(ORIGIN, "https://www.pixiv.net")
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "ja,vi;q=0.9,en-US;q=0.8,en;q=0.7")
        .timeout(Duration::from_secs(15));

    if let Some(ck) = build_cookie_header_for_url(&parsed, override_cookie, app, state).await {
        req = req.header(COOKIE, ck);
    }

    let resp = req.send().await.map_err(|e| format!("Lỗi mạng Pixiv: {e}"))?;
    merge_set_cookies_from_headers(resp.headers(), &parsed, state).await;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Không thể tải truyện Pixiv #{novel_id} (HTTP {status})."));
    }
    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Lỗi đọc dữ liệu Pixiv: {e}"))?;
    if json.get("error").and_then(|v| v.as_bool()).unwrap_or(false) || json.get("body").is_none() {
        let msg = json
            .get("message")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("Không thể truy cập truyện Pixiv.");
        return Err(msg.to_string());
    }
    Ok(json["body"].clone())
}

async fn inspect_pixiv_series(
    series_id: &str,
    override_cookie: Option<&str>,
    app: &AppHandle,
    state: &AppState,
) -> Result<WebNovelInspectResult, String> {
    let base_pixiv = Url::parse("https://www.pixiv.net/").unwrap();
    let ck = build_cookie_header_for_url(&base_pixiv, override_cookie, app, state).await;

    let mut series_req = state
        .client
        .get(format!("https://www.pixiv.net/ajax/novel/series/{series_id}"))
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(REFERER, "https://www.pixiv.net/")
        .header(ORIGIN, "https://www.pixiv.net")
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "ja,vi;q=0.9,en-US;q=0.8,en;q=0.7")
        .timeout(Duration::from_secs(15));
    if let Some(ref cookie_str) = ck {
        series_req = series_req.header(COOKIE, cookie_str);
    }

    let series_resp = series_req
        .send()
        .await
        .map_err(|e| format!("Lỗi kết nối Pixiv: {e}"))?;
    if !series_resp.status().is_success() {
        return Err(format!(
            "Không tìm thấy series Pixiv #{series_id} (HTTP {}).",
            series_resp.status()
        ));
    }
    let series_json: Value = series_resp
        .json()
        .await
        .map_err(|e| format!("Lỗi phân tích series Pixiv: {e}"))?;
    if series_json
        .get("error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || series_json.get("body").is_none()
    {
        let msg = series_json
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Không thể đọc thông tin series Pixiv.");
        return Err(msg.to_string());
    }

    let s_body = &series_json["body"];
    let total_count = s_body
        .get("total")
        .or_else(|| s_body.get("publishedContentCount"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;

    let mut tag_set: Vec<String> = Vec::new();
    let mut seen_tags: HashSet<String> = HashSet::new();
    if let Some(arr) = s_body.get("tags").and_then(|v| v.as_array()) {
        for t in arr {
            if let Some(s) = t.as_str() {
                if !s.is_empty() && seen_tags.insert(s.to_string()) {
                    tag_set.push(s.to_string());
                }
            }
        }
    }

    let mut content_entries: Vec<(String, i64)> = Vec::new();
    let mut thumbnail_map: HashMap<String, Value> = HashMap::new();
    let mut last_order: i64 = 0;

    for _ in 0..50 {
        let content_url = format!(
            "https://www.pixiv.net/ajax/novel/series_content/{series_id}?limit=30&last_order={last_order}&order_by=asc"
        );
        let mut c_req = state
            .client
            .get(&content_url)
            .header(USER_AGENT, DEFAULT_USER_AGENT)
            .header(REFERER, "https://www.pixiv.net/")
            .header(ORIGIN, "https://www.pixiv.net")
            .header(ACCEPT, "application/json, text/plain, */*")
            .timeout(Duration::from_secs(15));
        if let Some(ref cookie_str) = ck {
            c_req = c_req.header(COOKIE, cookie_str);
        }
        let Ok(c_resp) = c_req.send().await else {
            break;
        };
        if !c_resp.status().is_success() {
            break;
        }
        let Ok(c_json) = c_resp.json::<Value>().await else {
            break;
        };
        if c_json.get("error").and_then(|v| v.as_bool()).unwrap_or(false) {
            break;
        }
        if let Some(thumbs) = c_json
            .get("body")
            .and_then(|b| b.get("thumbnails"))
            .and_then(|t| t.get("novel"))
            .and_then(|n| n.as_array())
        {
            for tn in thumbs {
                if let Some(id) = tn.get("id").and_then(|v| v.as_str()) {
                    thumbnail_map.insert(id.to_string(), tn.clone());
                } else if let Some(id_num) = tn.get("id").and_then(|v| v.as_u64()) {
                    thumbnail_map.insert(id_num.to_string(), tn.clone());
                }
            }
        }
        let page_items = c_json
            .get("body")
            .and_then(|b| b.get("page"))
            .and_then(|p| p.get("seriesContents"))
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();

        if page_items.is_empty() {
            break;
        }

        for item in &page_items {
            let id = item
                .get("id")
                .and_then(|v| {
                    v.as_str()
                        .map(|s| s.to_string())
                        .or_else(|| v.as_u64().map(|n| n.to_string()))
                })
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let order = item
                .get("series")
                .and_then(|s| s.get("contentOrder"))
                .and_then(|v| v.as_i64())
                .unwrap_or((content_entries.len() + 1) as i64);

            if !content_entries.iter().any(|(eid, _)| eid == &id) {
                content_entries.push((id, order));
            }
            last_order = (last_order + 1).max(order);
        }

        if page_items.len() < 30 || (total_count > 0 && content_entries.len() >= total_count) {
            break;
        }
    }

    content_entries.sort_by_key(|e| e.1);

    let mut fallback_cover_url: Option<String> = s_body
        .get("cover")
        .and_then(|c| c.get("urls"))
        .and_then(|u| {
            u.get("480mw")
                .or_else(|| u.get("original"))
                .or_else(|| u.get("240mw"))
        })
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut requires_cookie = false;
    let mut restriction_notice: Option<String> = None;

    let mut chapters: Vec<WebNovelChapterMeta> = content_entries
        .iter()
        .enumerate()
        .map(|(idx, (id, order))| {
            let thumb = thumbnail_map.get(id);
            if let Some(t) = thumb {
                if let Some(arr) = t.get("tags").and_then(|v| v.as_array()) {
                    for tag in arr {
                        if let Some(s) = tag.as_str() {
                            if !s.is_empty() && seen_tags.insert(s.to_string()) {
                                tag_set.push(s.to_string());
                            }
                        }
                    }
                }
                if fallback_cover_url.is_none() {
                    fallback_cover_url = t
                        .get("url")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
                if t.get("xRestrict").and_then(|v| v.as_i64()).unwrap_or(0) >= 1 && ck.is_none() {
                    requires_cookie = true;
                }
            }
            let title = thumb
                .and_then(|t| t.get("title"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("Chương {order}"));
            let word_count = thumb.and_then(|t| {
                t.get("wordCount")
                    .or_else(|| t.get("characterCount"))
                    .or_else(|| t.get("textCount"))
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize)
            });
            let available = thumb
                .and_then(|t| t.get("available"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            WebNovelChapterMeta {
                index: idx,
                id: id.clone(),
                title,
                url: format!("https://www.pixiv.net/novel/show.php?id={id}"),
                source_type: "pixiv-novel".to_string(),
                word_count,
                content: None,
                tags: None,
                available: Some(available),
                requires_cookie: None,
            }
        })
        .collect();

    if !chapters.is_empty() {
        let first_id = chapters[0].id.clone();
        if let Ok(detail) = fetch_pixiv_novel_detail(&first_id, override_cookie, app, state).await {
            if let Some(t) = detail.get("title").and_then(|v| v.as_str()) {
                if !t.is_empty() {
                    chapters[0].title = t.to_string();
                }
            }
            let content_str = detail.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if content_str.is_empty() {
                restriction_notice = get_pixiv_restriction_reason(&detail);
                chapters[0].available = Some(false);
                chapters[0].requires_cookie = Some(true);
                requires_cookie = true;
            } else {
                chapters[0].word_count = Some(count_words_simple(content_str));
            }
            if fallback_cover_url.is_none() {
                fallback_cover_url = detail
                    .get("coverUrl")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
    }

    let cover_data_url = match fallback_cover_url {
        Some(ref u) => {
            fetch_image_as_data_url(u, "https://www.pixiv.net/", override_cookie, app, state).await
        }
        None => None,
    };

    Ok(WebNovelInspectResult {
        source_type: "pixiv-series".to_string(),
        normalized_url: format!("https://www.pixiv.net/novel/series/{series_id}"),
        title: s_body
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Pixiv Series #{series_id}")),
        author: s_body
            .get("userName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("Khuyết danh")
            .to_string(),
        description: strip_html_to_text(
            s_body.get("caption").and_then(|v| v.as_str()).unwrap_or(""),
        ),
        tags: tag_set,
        cover_data_url,
        chapters,
        requires_cookie: if requires_cookie { Some(true) } else { None },
        restriction_notice,
        series_info: None,
    })
}

async fn inspect_pixiv_single_novel(
    novel_id: &str,
    override_cookie: Option<&str>,
    app: &AppHandle,
    state: &AppState,
) -> Result<WebNovelInspectResult, String> {
    let detail = fetch_pixiv_novel_detail(novel_id, override_cookie, app, state).await?;
    let tags: Vec<String> = detail
        .get("tags")
        .and_then(|t| t.get("tags"))
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("tag").and_then(|s| s.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let restriction = get_pixiv_restriction_reason(&detail);
    let raw_content = detail.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let cover_url = detail.get("coverUrl").and_then(|v| v.as_str()).unwrap_or("");
    let cover_data_url =
        fetch_image_as_data_url(cover_url, "https://www.pixiv.net/", override_cookie, app, state)
            .await;

    let series_info = detail
        .get("seriesNavData")
        .and_then(|sn| {
            let sid = sn.get("seriesId").and_then(|v| {
                v.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| v.as_u64().map(|n| n.to_string()))
            })?;
            let stitle = sn
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("Series #{sid}"));
            Some(SeriesInfo {
                url: format!("https://www.pixiv.net/novel/series/{sid}"),
                series_id: sid,
                title: stitle,
            })
        });

    let title = detail
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Pixiv #{novel_id}"));
    let author = detail
        .get("userName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Khuyết danh")
        .to_string();
    let description = strip_html_to_text(
        detail.get("description").and_then(|v| v.as_str()).unwrap_or(""),
    );
    let normalized_url = format!("https://www.pixiv.net/novel/show.php?id={novel_id}");

    if let Some(reason) = restriction {
        let wc = detail
            .get("wordCount")
            .or_else(|| detail.get("characterCount"))
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        return Ok(WebNovelInspectResult {
            source_type: "pixiv-novel".to_string(),
            normalized_url: normalized_url.clone(),
            title: title.clone(),
            author,
            description,
            tags: tags.clone(),
            cover_data_url,
            requires_cookie: Some(true),
            restriction_notice: Some(reason),
            chapters: vec![WebNovelChapterMeta {
                index: 0,
                id: novel_id.to_string(),
                title,
                url: normalized_url,
                source_type: "pixiv-novel".to_string(),
                word_count: wc,
                content: None,
                tags: Some(tags),
                available: Some(false),
                requires_cookie: Some(true),
            }],
            series_info,
        });
    }

    let split_chapters = split_pixiv_inline_chapters(raw_content, &title);
    let chapters = split_chapters
        .into_iter()
        .enumerate()
        .map(|(idx, ch)| WebNovelChapterMeta {
            index: idx,
            id: format!("{novel_id}-{idx}"),
            title: ch.title,
            url: normalized_url.clone(),
            source_type: "inline".to_string(),
            word_count: Some(ch.word_count),
            content: Some(ch.content),
            tags: Some(tags.clone()),
            available: Some(true),
            requires_cookie: None,
        })
        .collect();

    Ok(WebNovelInspectResult {
        source_type: "pixiv-novel".to_string(),
        normalized_url,
        title,
        author,
        description,
        tags,
        cover_data_url,
        chapters,
        requires_cookie: None,
        restriction_notice: None,
        series_info,
    })
}

async fn fetch_html_with_charset(
    target_url: &str,
    override_cookie: Option<&str>,
    app: &AppHandle,
    state: &AppState,
) -> Result<(String, String), String> {
    let parsed = assert_public_http_url(target_url)?;
    let origin = parsed.origin().ascii_serialization();
    let mut req = state
        .client
        .get(parsed.as_str())
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header(ACCEPT_LANGUAGE, "vi,ja;q=0.9,en-US;q=0.8,en;q=0.7")
        .header(REFERER, format!("{origin}/"))
        .timeout(Duration::from_secs(15));

    if let Some(ck) = build_cookie_header_for_url(&parsed, override_cookie, app, state).await {
        req = req.header(COOKIE, ck);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Không thể truy cập trang web: {e}"))?;
    merge_set_cookies_from_headers(resp.headers(), &parsed, state).await;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Không thể truy cập trang web (HTTP {status})."));
    }

    let final_url = resp.url().to_string();
    let ct = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Lỗi đọc dữ liệu trang web: {e}"))?;

    let mut charset = None;
    let ct_re = Regex::new(r"(?i)charset=([^;\s]+)").unwrap();
    if let Some(cap) = ct_re.captures(&ct) {
        charset = Some(cap[1].replace(['\'', '"'], "").to_lowercase());
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
        let meta_re = Regex::new(r#"(?i)charset=["']?([a-zA-Z0-9_-]+)"#).unwrap();
        if let Some(cap) = meta_re.captures(&head) {
            charset = Some(cap[1].to_lowercase());
        }
    }

    let decoded = if let Some(cs) = charset {
        if let Some(enc) = encoding_rs::Encoding::for_label(cs.as_bytes()) {
            enc.decode(&bytes).0.into_owned()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        }
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    Ok((decoded, final_url))
}

fn extract_article_text_sync(doc: &Html) -> String {
    let priority_selectors = [
        "#novel_honbun",
        ".p-novel__text",
        ".js-novel-text",
        ".widget-episodeBody",
        "#chapter-c",
        ".chapter-c",
        ".chapter-content",
        "#chapter-content",
        ".reading-content",
        ".entry-content",
        "article .content",
        "article",
        "main",
    ];

    let mut chosen_html = String::new();
    for sel_str in priority_selectors {
        if let Ok(sel) = Selector::parse(sel_str) {
            if let Some(el) = doc.select(&sel).next() {
                let text_len = el.text().collect::<String>().trim().chars().count();
                if text_len > 150 {
                    chosen_html = el.inner_html();
                    break;
                }
            }
        }
    }
    if chosen_html.is_empty() {
        if let Ok(sel) = Selector::parse("body") {
            if let Some(el) = doc.select(&sel).next() {
                chosen_html = el.inner_html();
            }
        }
    }
    if chosen_html.is_empty() {
        return String::new();
    }

    // Remove noise tags before extracting paragraphs
    let noise_re =
        Regex::new(r"(?is)<(script|style|noscript|iframe|nav|header|footer|aside)[^>]*>.*?</(script|style|noscript|iframe|nav|header|footer|aside)>").unwrap();
    let cleaned_html = noise_re.replace_all(&chosen_html, "");
    let frag = Html::parse_fragment(&cleaned_html);

    if let Ok(p_sel) = Selector::parse("p") {
        let p_nodes: Vec<_> = frag.select(&p_sel).collect();
        if p_nodes.len() >= 2 {
            let blocks: Vec<String> = p_nodes
                .into_iter()
                .map(|p| strip_html_to_text(&p.inner_html()))
                .filter(|t| !t.is_empty())
                .collect();
            if !blocks.is_empty() {
                return blocks.join("\n\n");
            }
        }
    }

    strip_html_to_text(&cleaned_html)
}

struct SyncGenericExtract {
    title: String,
    h1_title: String,
    author: String,
    description: String,
    raw_cover: Option<String>,
    found_links: Vec<(String, String)>,
    extracted_text: String,
}

fn parse_generic_web_sync(html: &str, final_url: &Url) -> SyncGenericExtract {
    let doc = Html::parse_document(html);
    let sel_text = |query: &str| -> String {
        Selector::parse(query)
            .ok()
            .and_then(|s| doc.select(&s).next())
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default()
    };
    let sel_attr = |query: &str, attr: &str| -> String {
        Selector::parse(query)
            .ok()
            .and_then(|s| doc.select(&s).next())
            .and_then(|el| el.value().attr(attr))
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };

    let h1_title = sel_text("h1");
    let og_title = sel_attr("meta[property=\"og:title\"]", "content");
    let doc_title = sel_text("title");
    let title = if !h1_title.is_empty() {
        h1_title.clone()
    } else if !og_title.is_empty() {
        og_title
    } else if !doc_title.is_empty() {
        doc_title
    } else {
        final_url.host_str().unwrap_or("Web Novel").to_string()
    };

    let author = [
        sel_attr("meta[name=\"author\"]", "content"),
        sel_text(".novel_writername a"),
        sel_text("[itemprop=\"author\"]"),
    ]
    .into_iter()
    .find(|s| !s.is_empty())
    .unwrap_or_else(|| "Khuyết danh".to_string());

    let description = [
        sel_attr("meta[property=\"og:description\"]", "content"),
        sel_attr("meta[name=\"description\"]", "content"),
    ]
    .into_iter()
    .find(|s| !s.is_empty())
    .unwrap_or_default();

    let toc_selectors = [
        ".index_box .novel_sublist2 a",
        ".p-eplist__sublist a.p-eplist__subtitle",
        ".widget-toc-episode a",
        "#list-chapter .list-chapter a",
        ".list-chapter a",
        ".chapter-list a",
        "#chapters a",
    ];
    let mut found_links = Vec::new();
    let mut seen_urls = HashSet::new();

    for sel_str in toc_selectors {
        if let Ok(sel) = Selector::parse(sel_str) {
            let matches: Vec<_> = doc.select(&sel).collect();
            if matches.len() >= 2 {
                for el in matches {
                    let Some(href) = el.value().attr("href") else {
                        continue;
                    };
                    let link_title = el
                        .text()
                        .collect::<String>()
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ");
                    if link_title.is_empty() {
                        continue;
                    }
                    if let Ok(abs_url) = final_url.join(href) {
                        let abs_str = abs_url.to_string();
                        if seen_urls.insert(abs_str.clone()) {
                            found_links.push((link_title, abs_str));
                        }
                    }
                }
                if found_links.len() >= 2 {
                    break;
                }
            }
        }
    }

    let raw_cover = sel_attr("meta[property=\"og:image\"]", "content");
    let raw_cover_abs = if !raw_cover.is_empty() {
        final_url.join(&raw_cover).ok().map(|u| u.to_string())
    } else {
        None
    };

    let extracted_text = if found_links.len() < 2 {
        extract_article_text_sync(&doc)
    } else {
        String::new()
    };

    SyncGenericExtract {
        title,
        h1_title,
        author,
        description,
        raw_cover: raw_cover_abs,
        found_links,
        extracted_text,
    }
}

fn parse_chapter_html_sync(html: &str) -> (String, String) {
    let doc = Html::parse_document(html);
    let sel_text = |query: &str| -> String {
        Selector::parse(query)
            .ok()
            .and_then(|s| doc.select(&s).next())
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default()
    };
    let h1 = sel_text("h1");
    let ch_title = sel_text(".chapter-title");
    let doc_title = sel_text("title");
    let title = if !h1.is_empty() {
        h1
    } else if !ch_title.is_empty() {
        ch_title
    } else if !doc_title.is_empty() {
        doc_title
    } else {
        "Chương".to_string()
    };
    let content = extract_article_text_sync(&doc);
    (title, content)
}

async fn inspect_generic_web_url(
    raw_url: &str,
    override_cookie: Option<&str>,
    app: &AppHandle,
    state: &AppState,
) -> Result<WebNovelInspectResult, String> {
    let (html, final_url_str) =
        fetch_html_with_charset(raw_url, override_cookie, app, state).await?;
    let final_url = Url::parse(&final_url_str).map_err(|e| e.to_string())?;
    let extracted = parse_generic_web_sync(&html, &final_url);

    let cover_data_url = match extracted.raw_cover {
        Some(ref img_url) => {
            let referer = format!("{}/", final_url.origin().ascii_serialization());
            fetch_image_as_data_url(img_url, &referer, override_cookie, app, state).await
        }
        None => None,
    };

    if extracted.found_links.len() >= 2 {
        let chapters = extracted
            .found_links
            .into_iter()
            .enumerate()
            .map(|(idx, (ch_title, ch_url))| WebNovelChapterMeta {
                index: idx,
                id: format!("web-{idx}"),
                title: ch_title,
                url: ch_url,
                source_type: "web-chapter".to_string(),
                word_count: None,
                content: None,
                tags: None,
                available: Some(true),
                requires_cookie: None,
            })
            .collect();

        return Ok(WebNovelInspectResult {
            source_type: "web-toc".to_string(),
            normalized_url: final_url_str,
            title: extracted.title,
            author: extracted.author,
            description: extracted.description,
            tags: Vec::new(),
            cover_data_url,
            chapters,
            requires_cookie: None,
            restriction_notice: None,
            series_info: None,
        });
    }

    if extracted.extracted_text.trim().chars().count() < 30 {
        return Err("Không trích xuất được nội dung văn bản từ trang web này.".to_string());
    }

    let wc = count_words_simple(&extracted.extracted_text);
    let chapter_title = if !extracted.h1_title.is_empty() {
        extracted.h1_title
    } else {
        extracted.title.clone()
    };

    Ok(WebNovelInspectResult {
        source_type: "web-article".to_string(),
        normalized_url: final_url_str.clone(),
        title: extracted.title,
        author: extracted.author,
        description: extracted.description,
        tags: Vec::new(),
        cover_data_url,
        chapters: vec![WebNovelChapterMeta {
            index: 0,
            id: "web-0".to_string(),
            title: chapter_title,
            url: final_url_str,
            source_type: "inline".to_string(),
            word_count: Some(wc),
            content: Some(extracted.extracted_text),
            tags: None,
            available: Some(true),
            requires_cookie: None,
        }],
        requires_cookie: None,
        restriction_notice: None,
        series_info: None,
    })
}

#[tauri::command]
async fn desktop_get_all_cookies(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<SiteCookieJar>, String> {
    Ok(sync_webview_cookies_into_state(&app, &state).await)
}

#[tauri::command]
async fn desktop_sync_cookie_jars(
    jars: Vec<SiteCookieJar>,
    state: State<'_, AppState>,
) -> Result<Vec<SiteCookieJar>, String> {
    let mut map = state.cookies_by_domain.lock().await;
    for jar in jars {
        for c in jar.cookies {
            let base = extract_base_domain(if c.domain.is_empty() {
                &jar.domain
            } else {
                &c.domain
            });
            upsert_cookie_entry(&mut map, &base, c);
        }
    }
    save_cookies_to_disk(&state.cookies_file_path, &map);
    Ok(jars_vec_from_map(&map))
}

#[tauri::command]
async fn desktop_set_manual_cookie(
    domain_or_url: String,
    cookie_string: String,
    state: State<'_, AppState>,
) -> Result<Vec<SiteCookieJar>, String> {
    let base_domain = extract_base_domain(&domain_or_url);
    let trimmed = cookie_string.trim();
    let normalized = if !trimmed.contains('=') && base_domain == "pixiv.net" {
        format!("PHPSESSID={trimmed}")
    } else {
        trimmed.to_string()
    };

    let mut map = state.cookies_by_domain.lock().await;
    for part in normalized.split(';') {
        let p = part.trim();
        let Some(eq_idx) = p.find('=') else {
            continue;
        };
        let name = p[..eq_idx].trim().to_string();
        let value = p[eq_idx + 1..].trim().to_string();
        if name.is_empty() {
            continue;
        }
        upsert_cookie_entry(
            &mut map,
            &base_domain,
            StoredCookieEntry {
                name,
                value,
                domain: base_domain.clone(),
                path: "/".to_string(),
                expires_at: None,
                http_only: Some(false),
                secure: Some(true),
            },
        );
    }
    save_cookies_to_disk(&state.cookies_file_path, &map);
    Ok(jars_vec_from_map(&map))
}

#[tauri::command]
async fn desktop_clear_domain_cookies(
    domain: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<SiteCookieJar>, String> {
    let base = extract_base_domain(&domain);
    if let Some(browser_win) = app.get_webview_window("reader-browser") {
        if let Ok(wv_cookies) = browser_win.cookies() {
            for c in wv_cookies {
                let c_dom = c.domain().unwrap_or("");
                if extract_base_domain(c_dom) == base {
                    let _ = browser_win.delete_cookie(c);
                }
            }
        }
    }
    let mut map = state.cookies_by_domain.lock().await;
    map.remove(&base);
    save_cookies_to_disk(&state.cookies_file_path, &map);
    Ok(jars_vec_from_map(&map))
}

#[tauri::command]
async fn desktop_get_preferred_lang(state: State<'_, AppState>) -> Result<String, String> {
    let lang = state.preferred_lang.lock().await;
    Ok(lang.clone())
}

#[tauri::command]
async fn desktop_set_preferred_lang(
    lang: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let next = if lang == "ja" { "ja" } else { "en" }.to_string();
    let mut guard = state.preferred_lang.lock().await;
    *guard = next.clone();
    Ok(next)
}

#[tauri::command]
async fn desktop_inspect_url(
    url: String,
    cookie: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WebNovelInspectResult, String> {
    let parsed = assert_public_http_url(&url)?;
    let url_str = parsed.to_string();
    let series_re = Regex::new(r"(?i)pixiv\.net/(?:[a-z]{2}/)?novel/series/(\d+)").unwrap();
    if let Some(cap) = series_re.captures(&url_str) {
        return inspect_pixiv_series(&cap[1], cookie.as_deref(), &app, &state).await;
    }
    let novel_re = Regex::new(r"(?i)pixiv\.net/(?:[a-z]{2}/)?novel/show\.php\?.*id=(\d+)").unwrap();
    if let Some(cap) = novel_re.captures(&url_str) {
        return inspect_pixiv_single_novel(&cap[1], cookie.as_deref(), &app, &state).await;
    }
    inspect_generic_web_url(&url_str, cookie.as_deref(), &app, &state).await
}

#[tauri::command]
async fn desktop_fetch_chapter(
    params: FetchChapterParams,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DesktopFetchChapterResult, String> {
    assert_public_http_url(&params.url)?;
    if params.source_type.as_deref() == Some("pixiv-novel") {
        let id_from_url = Regex::new(r"(?i)id=(\d+)")
            .unwrap()
            .captures(&params.url)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .or_else(|| {
                Regex::new(r"(\d+)")
                    .unwrap()
                    .captures(&params.url)
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str().to_string())
            });
        let resolved_id = params
            .novel_id
            .filter(|s| !s.is_empty())
            .or(id_from_url)
            .ok_or_else(|| "Không xác định được ID chương Pixiv.".to_string())?;

        let detail =
            fetch_pixiv_novel_detail(&resolved_id, params.cookie.as_deref(), &app, &state).await?;
        if let Some(reason) = get_pixiv_restriction_reason(&detail) {
            return Err(reason);
        }
        let cleaned = clean_pixiv_novel_content(
            detail.get("content").and_then(|v| v.as_str()).unwrap_or(""),
        );
        if cleaned.trim().is_empty() {
            return Err("Nội dung chương Pixiv trống.".to_string());
        }
        let tags: Vec<String> = detail
            .get("tags")
            .and_then(|t| t.get("tags"))
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        item.get("tag")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();

        let title = detail
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Chương {resolved_id}"));

        return Ok(DesktopFetchChapterResult {
            title,
            word_count: count_words_simple(&cleaned),
            content: cleaned,
            tags,
        });
    }

    let (html, _) =
        fetch_html_with_charset(&params.url, params.cookie.as_deref(), &app, &state).await?;
    let (title, content) = parse_chapter_html_sync(&html);
    if content.trim().is_empty() {
        return Err("Không trích xuất được nội dung văn bản từ trang chương này.".to_string());
    }
    Ok(DesktopFetchChapterResult {
        title,
        word_count: count_words_simple(&content),
        content,
        tags: Vec::new(),
    })
}

#[tauri::command]
async fn desktop_translate(
    joined_payload: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let resp = state
        .client
        .post("https://comic.sangtacvietcdn.xyz/tsm.php?cdn=/")
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(ACCEPT, "text/plain, */*")
        .form(&[("sajax", "trans"), ("content", joined_payload.as_str())])
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .map_err(|e| format!("Không kết nối được dịch vụ dịch: {e}"))?;

    let status = resp.status();
    let cf_mitigated = resp
        .headers()
        .get("cf-mitigated")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let raw_text = resp
        .text()
        .await
        .map_err(|e| format!("Lỗi đọc kết quả dịch: {e}"))?;

    let trimmed_start = raw_text.trim_start().to_lowercase();
    if cf_mitigated == "challenge"
        || trimmed_start.starts_with("<!doctype html")
        || raw_text.contains("_cf_chl_opt")
        || raw_text.contains("Just a moment...")
    {
        return Err("Máy chủ dịch đang bật xác minh bảo mật (HTTP 403) đối với IP hiện tại.".to_string());
    }
    if !status.is_success() {
        return Err(format!("Dịch vụ dịch trả về lỗi HTTP {status}."));
    }
    if raw_text.trim().is_empty() {
        return Err("Dịch vụ dịch trả về phản hồi rỗng.".to_string());
    }
    Ok(raw_text)
}

async fn fetch_gtx_phrase(client: &reqwest::Client, phrase: &str, tl: &str) -> Option<String> {
    let mut url = Url::parse("https://translate.googleapis.com/translate_a/single").ok()?;
    url.query_pairs_mut()
        .append_pair("client", "gtx")
        .append_pair("sl", "zh-CN")
        .append_pair("tl", tl)
        .append_pair("dt", "t")
        .append_pair("q", phrase);

    let resp = client
        .get(url)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    if !text.trim().starts_with('[') {
        return None;
    }
    let data: Value = serde_json::from_str(&text).ok()?;
    let arr = data.get(0)?.as_array()?;
    let joined: String = arr
        .iter()
        .filter_map(|part| part.get(0).and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join("");
    let cleaned = joined.trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

async fn fetch_primary_vi_phrase(client: &reqwest::Client, phrase: &str) -> Option<String> {
    let resp = client
        .post("https://comic.sangtacvietcdn.xyz/tsm.php?cdn=/")
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(ACCEPT, "text/plain, */*")
        .form(&[("sajax", "trans"), ("content", phrase)])
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.to_lowercase().starts_with("<!doctype")
        || trimmed.contains("_cf_chl_opt")
    {
        return None;
    }
    Some(trimmed.to_string())
}

#[tauri::command]
async fn desktop_analyze_phrase(
    phrase: String,
    state: State<'_, AppState>,
) -> Result<AnalyzePhraseResult, String> {
    let clean = phrase.trim().to_string();
    if clean.is_empty() || clean.chars().count() > 160 {
        return Ok(AnalyzePhraseResult {
            vi: None,
            name_eng: None,
        });
    }

    let (name_eng, vi_primary, vi_gtx) = tokio::join!(
        fetch_gtx_phrase(&state.client, &clean, "en"),
        fetch_primary_vi_phrase(&state.client, &clean),
        fetch_gtx_phrase(&state.client, &clean, "vi")
    );

    Ok(AnalyzePhraseResult {
        vi: vi_primary.or(vi_gtx),
        name_eng,
    })
}

#[tauri::command]
async fn desktop_open_browser_window(app: AppHandle, url: Option<String>) -> Result<(), String> {
    let target_url = match url.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(u) => assert_public_http_url(u)?,
        None => Url::parse("https://www.pixiv.net/").unwrap(),
    };

    if let Some(existing) = app.get_webview_window("reader-browser") {
        let _ = existing.navigate(target_url);
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let app_handle = app.clone();
    WebviewWindowBuilder::new(&app, "reader-browser", WebviewUrl::External(target_url))
        .title("Trình duyệt tích hợp - LYNX Reader")
        .inner_size(1100.0, 760.0)
        .user_agent(DEFAULT_USER_AGENT)
        .on_page_load(move |win, payload| {
            let url_str = payload.url().to_string();
            let title_str = win.title().unwrap_or_default();
            match payload.event() {
                PageLoadEvent::Started => {
                    let _ = app_handle.emit(
                        "browser-loading",
                        serde_json::json!({ "loading": true, "url": url_str }),
                    );
                }
                PageLoadEvent::Finished => {
                    let _ = app_handle.emit(
                        "browser-navigated",
                        serde_json::json!({ "url": url_str, "title": title_str }),
                    );
                    let _ = app_handle.emit(
                        "browser-loading",
                        serde_json::json!({ "loading": false, "url": url_str }),
                    );
                    let app_for_cookies = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app_for_cookies.state::<AppState>();
                        let jars = sync_webview_cookies_into_state(&app_for_cookies, &state).await;
                        let _ = app_for_cookies.emit("browser-cookies-updated", jars);
                    });
                }
            }
        })
        .build()
        .map_err(|e| format!("Không thể mở cửa sổ trình duyệt: {e}"))?;

    Ok(())
}

#[tauri::command]
async fn desktop_browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = assert_public_http_url(&url)?;
    if let Some(existing) = app.get_webview_window("reader-browser") {
        existing
            .navigate(parsed)
            .map_err(|e| format!("Lỗi điều hướng: {e}"))?;
        let _ = existing.show();
        let _ = existing.set_focus();
        Ok(())
    } else {
        desktop_open_browser_window(app, Some(parsed.to_string())).await
    }
}

#[tauri::command]
async fn desktop_browser_action(app: AppHandle, action: String) -> Result<(), String> {
    let Some(win) = app.get_webview_window("reader-browser") else {
        return Ok(());
    };
    match action.as_str() {
        "back" => {
            let _ = win.eval("window.history.back()");
        }
        "forward" => {
            let _ = win.eval("window.history.forward()");
        }
        "reload" => {
            let _ = win.eval("window.location.reload()");
        }
        "focus" => {
            let _ = win.show();
            let _ = win.set_focus();
        }
        "close" => {
            let _ = win.close();
        }
        _ => {}
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("lynx-reader"));
            let cookies_file_path = data_dir.join("cookies.json");
            let initial_cookies = load_cookies_from_disk(&cookies_file_path);

            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()
                .expect("Failed to create HTTP client");

            app.manage(AppState {
                client,
                cookies_by_domain: Mutex::new(initial_cookies),
                cookies_file_path,
                preferred_lang: Mutex::new("en".to_string()),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_get_all_cookies,
            desktop_sync_cookie_jars,
            desktop_set_manual_cookie,
            desktop_clear_domain_cookies,
            desktop_get_preferred_lang,
            desktop_set_preferred_lang,
            desktop_inspect_url,
            desktop_fetch_chapter,
            desktop_translate,
            desktop_analyze_phrase,
            desktop_open_browser_window,
            desktop_browser_navigate,
            desktop_browser_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LYNX Reader");
}
