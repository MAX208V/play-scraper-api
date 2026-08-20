// ==================== API 处理器 ====================
import {
  jsonResponse, parseCountries, COUNTRY_NAMES,
  DEFAULT_COUNTRY, DEFAULT_LANG, DEFAULT_THRESHOLD, HISTORY_MAX
} from './utils.js';
import { fetchAppInfo, fetchAppPrice, cacheIcon, getCachedIcon, getApps, getNotifications, getPriceHistory } from './storage.js';
import { monitorAndNotify } from './services.js';

// ── 仪表盘 ──
export async function handleDashboard(env) {
  const { DB, ICONS } = env;
  let apps = [];
  let history = [];
  
  try {
    apps = await getApps(DB);
    for (const app of apps) {
      app.countries = JSON.stringify(parseCountries(app));
      app.icon_data = app.last_icon || '';
    }
    
    history = await getNotifications(DB, HISTORY_MAX);
  } catch (e) {
    console.error("[Dashboard Error]", e.message);
    // 即使有错误也返回部分数据
  }
  
  return jsonResponse({ 
    apps: apps || [], 
    history: history || [], 
    has_sc3: !!env.SC3_URL, 
    has_api: !!env.PLAY_API,
    status: "ok"
  });
}

// ── 国家列表 ──
export function handleCountries() {
  return jsonResponse(COUNTRY_NAMES);
}

// ── Bing 壁纸 ──
// 默认市场：中国（zh-CN → cn.bing.com）
const BING_DEFAULT_MKT = "zh-CN";

// 中文系市场走 cn.bing.com，其余走 www.bing.com
const BING_HOST_BY_MKT = {
  "zh-CN": "cn.bing.com",
  "zh-TW": "cn.bing.com",
  "zh-HK": "cn.bing.com"
};

// 两位国家码 → Bing 市场代码 (mkt)
const COUNTRY_TO_MKT = {
  cn: "zh-CN", tw: "zh-TW", hk: "zh-HK",
  us: "en-US", gb: "en-GB", au: "en-AU", ca: "en-CA",
  sg: "en-SG", my: "en-MY", in: "en-IN",
  jp: "ja-JP", kr: "ko-KR",
  de: "de-DE", fr: "fr-FR", it: "it-IT", es: "es-ES", mx: "es-MX",
  nl: "nl-NL", se: "sv-SE", no: "nb-NO", dk: "da-DK", fi: "fi-FI", ch: "de-CH",
  br: "pt-BR", ru: "ru-RU", tr: "tr-TR",
  th: "th-TH", id: "id-ID", vn: "vi-VN", ph: "en-PH",
  za: "en-ZA", ae: "ar-AE", sa: "ar-SA"
};

const MKT_RE = /^[a-zA-Z]{2,3}-[a-zA-Z]{2}$/;

// 标准化 mkt 参数（zh-cn → zh-CN），非法值回退默认
function normalizeMkt(raw) {
  if (!raw || typeof raw !== "string") return BING_DEFAULT_MKT;
  const t = raw.trim();
  if (!MKT_RE.test(t)) return BING_DEFAULT_MKT;
  const [lang, region] = t.split("-");
  return lang.toLowerCase() + "-" + region.toUpperCase();
}

function bingHost(mkt) {
  return BING_HOST_BY_MKT[mkt] || "www.bing.com";
}

// 拼完整图片地址（Bing 返回相对路径 /th?id=...）
function fullImageUrl(host, path) {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return "https://" + host + path;
}

// ── 分辨率选择：Bing 实测支持的分辨率（不支持组合返回 404）──
const RES_LANDSCAPE = [
  { key: "UHD", w: 3840, h: 2160 },
  { key: "1920x1080", w: 1920, h: 1080 },
  { key: "1366x768", w: 1366, h: 768 },
  { key: "1280x720", w: 1280, h: 720 }
];
const RES_PORTRAIT = [
  { key: "1080x1920", w: 1080, h: 1920 },
  { key: "768x1366", w: 768, h: 1366 }
];
// 显式预设：?res=
const RES_PRESETS = {
  uhd: "UHD", "4k": "UHD",
  "1080p": "1920x1080", "1920x1080": "1920x1080",
  "1366x768": "1366x768",
  "720p": "1280x720", "1280x720": "1280x720",
  phone: "1080x1920", "1080x1920": "1080x1920", "768x1366": "768x1366"
};
const RES_BY_KEY = [...RES_LANDSCAPE, ...RES_PORTRAIT].reduce((m, r) => { m[r.key] = r; return m; }, {});

// 按目标宽高选最接近的分辨率（面积差最小）
function pickResolution(w, h) {
  const portrait = h > w;
  const list = portrait ? RES_PORTRAIT : RES_LANDSCAPE;
  if (!(w > 0) || !(h > 0)) return list[0];
  const target = w * h;
  let best = list[0], bestDiff = Infinity;
  for (const r of list) {
    const diff = Math.abs(r.w * r.h - target);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return best;
}

// 从 UA 判断设备方向：移动竖屏 1080x1920 / 桌面横屏 1920x1080
function pickByUa(ua) {
  const u = (ua || "").toLowerCase();
  // 平板（含 iPadOS 的 Mobile 伪装）始终按横屏处理
  if (/ipad|tablet/.test(u)) return RES_LANDSCAPE[1];
  const mobile = /iphone|ipod|mobile/.test(u) || (/android/.test(u) && !/tablet/.test(u));
  return mobile ? RES_PORTRAIT[0] : RES_LANDSCAPE[1];
}

// 把 Bing url 中的默认分辨率后缀替换为目标分辨率（url 与 rf 参数同步替换）
function applyResolution(imgPath, res) {
  if (!imgPath || !res) return imgPath;
  return imgPath.split("_1920x1080").join("_" + res.key);
}

export async function handleBg(request) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const hasParams = [...q.keys()].length > 0;

  // 1. 解析市场
  let mkt = BING_DEFAULT_MKT;
  if (q.get("mkt")) {
    mkt = normalizeMkt(q.get("mkt"));
  } else if (q.get("country")) {
    const c = q.get("country").trim().toLowerCase();
    mkt = COUNTRY_TO_MKT[c] || BING_DEFAULT_MKT;
  }

  // 2. 解析 idx / n（Bing 原生支持，n 上限 8）
  let idx = parseInt(q.get("idx"), 10);
  if (!Number.isFinite(idx) || idx < 0) idx = 0;
  let n = parseInt(q.get("n"), 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 8) n = 8;

  // 2.5 分辨率：res 预设 > w/h 实际尺寸 > UA 自动
  let res = null;
  const resParam = q.get("res");
  if (resParam && RES_PRESETS[String(resParam).toLowerCase()]) {
    res = RES_BY_KEY[RES_PRESETS[String(resParam).toLowerCase()]];
  } else {
    const w = parseInt(q.get("w"), 10);
    const h = parseInt(q.get("h"), 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      res = pickResolution(w, h);
    }
  }
  if (!res) res = pickByUa(request.headers.get("User-Agent"));

  const host = bingHost(mkt);
  const apiUrl = `https://${host}/HPImageArchive.aspx?format=js&idx=${idx}&n=${n}&mkt=${mkt}`;

  // 3. 请求 Bing
  let data;
  try {
    const resp = await fetch(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) throw new Error("Bing API " + resp.status);
    data = await resp.json();
  } catch (e) {
    // 无参数(302模式)失败时给 502；参数(JSON模式)失败时给 {url:null} 保持与原行为兼容
    if (!hasParams) return jsonResponse({ error: "bing api unavailable", mkt }, 502);
    return jsonResponse({ url: null, mkt });
  }

  const images = (data.images || []).map(img => ({
    url: fullImageUrl(host, applyResolution(img.url, res)),
    title: img.copyright || img.title || "",
    date: img.startdate || "",
    res: res.key
  })).filter(img => img.url);

  // 4. 无参数：302 重定向到图片链接（默认为 zh-CN 今日壁纸）
  if (!hasParams) {
    const target = images[0]?.url;
    if (!target) return jsonResponse({ error: "no image", mkt }, 502);
    return new Response(null, {
      status: 302,
      headers: {
        "Location": target,
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // 5. 有参数：返回 JSON
  if (n > 1) return jsonResponse({ ok: true, mkt, res: res.key, images });
  const first = images[0] || {};
  return jsonResponse({ ok: true, url: first.url || null, title: first.title || "", mkt, date: first.date || "", res: first.res || res.key });
}

// ── 应用 CRUD ──
export async function handleAppsApi(request, env) {
  const { DB, ICONS } = env;

  if (request.method === "GET") {
    const apps = await getApps(DB);
    for (const app of apps) {
      app.countries = JSON.stringify(parseCountries(app));
      app.icon_data = app.last_icon || '';
    }
    return jsonResponse(apps);
  }

  if (request.method === "POST") {
    const body = await request.json();
    if (!body.app_id) return jsonResponse({ error: "app_id required" }, 400);

    const countries = body.countries || [body.country || DEFAULT_COUNTRY];
    const now = new Date().toISOString();

    let name = body.name;
    let preIcon = '';
    let prePrice = null;
    let preFree = 0;
    let preCurrency = 'USD';
    try {
      const info = await fetchAppInfo(env, body.app_id, countries[0]);
      if (info) {
        if (!name || name.trim() === '') name = info.title || name;
        preIcon = info.icon || '';
        prePrice = info.price ?? null;
        preFree = info.free ? 1 : 0;
        preCurrency = info.currency || 'USD';
        if (info.icon && ICONS) await cacheIcon(ICONS, body.app_id, info.icon);
      }
    } catch (e) {}

    await DB.prepare(
      `INSERT INTO apps
       (id,name,threshold,country,countries,lang,note,monitor_mode,threshold_type,threshold_pct,created_at,updated_at,last_icon,last_price,last_free,last_currency,base_price,base_currency,last_notified_price)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      body.app_id, name || body.app_id,
      body.threshold ?? DEFAULT_THRESHOLD,
      countries[0] || DEFAULT_COUNTRY,
      JSON.stringify(countries),
      body.lang || DEFAULT_LANG,
      body.note || "",
      body.monitor_mode || "threshold",
      body.threshold_type || "amount",
      body.threshold_pct || null,

      now, now,
      preIcon, prePrice, preFree, preCurrency, prePrice, preCurrency, prePrice
    ).run();

    return jsonResponse({ ok: true });
  }

  if (request.method === "DELETE") {
    const body = await request.json();
    if (!body.app_id) return jsonResponse({ error: "app_id required" }, 400);
    // 先删除关联数据，再删应用
    await DB.prepare("DELETE FROM price_history WHERE app_id = ?").bind(body.app_id).run();
    await DB.prepare("DELETE FROM notifications WHERE app_id = ?").bind(body.app_id).run();
    await DB.prepare("DELETE FROM apps WHERE id = ?").bind(body.app_id).run();
    return jsonResponse({ ok: true });
  }

  if (request.method === "PATCH") {
    const body = await request.json();
    if (!body.app_id) return jsonResponse({ error: "app_id required" }, 400);
    // 白名单字段，防止意外字段注入
    const ALLOWED_FIELDS = new Set([
      "name","threshold","country","lang","note","monitor_mode",
      "base_price","base_currency","threshold_type","threshold_pct"
    ]);
    const fields = [];
    const values = [];
    for (const k of Object.keys(body)) {
      if (k === "app_id" || k === "id" || k === "countries" || !ALLOWED_FIELDS.has(k)) continue;
      fields.push(k + "=?");
      values.push(body[k]);
    }
    if (fields.length === 0) return jsonResponse({ error: "no fields" }, 400);
    if (body.countries && Array.isArray(body.countries)) {
      fields.push("country=?");
      values.push(body.countries[0]);
      fields.push("countries=?");
      values.push(JSON.stringify(body.countries));
    }
    fields.push("updated_at=?");
    values.push(new Date().toISOString());
    values.push(body.app_id);

    await DB.prepare("UPDATE apps SET " + fields.join(",") + " WHERE id=?").bind(...values).run();
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}

// ── 图标服务 ──
export async function handleIcon(request, env) {
  const url = new URL(request.url);
  const appId = url.searchParams.get("appId");
  if (!appId) return new Response("Missing appId", { status: 400 });
  const { ICONS } = env;
  // 优先从 R2 读取缓存图标
  if (ICONS) {
    try {
      const obj = await ICONS.get("icons/" + appId);
      if (obj) {
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("Cache-Control", "public, max-age=86400");
        return new Response(obj.body, { headers });
      }
    } catch (e) {}
  }
  // 回退到 Google Play 原始图标（从 app 记录中获取）
  try {
    const app = await env.DB.prepare("SELECT last_icon FROM apps WHERE id=?").bind(appId).first();
    if (app?.last_icon) {
      const resp = await fetch(app.last_icon, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (resp.ok) return new Response(resp.body, { headers: { "Cache-Control": "public, max-age=3600", "Content-Type": resp.headers.get("content-type") || "image/png" } });
    }
  } catch (e) {}
  // 返回 1x1 透明 GIF 占位图
  const gif = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), c => c.charCodeAt(0));
  return new Response(gif, { status: 200, headers: { "Content-Type": "image/gif", "Cache-Control": "public, max-age=300" } });
}
export async function handleSearch(request, env) {
  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  if (!term) return jsonResponse({ error: "term required" }, 400);
  const playApi = env.PLAY_API;
  if (!playApi) return jsonResponse({ error: "PLAY_API not configured" }, 400);
  const apiBase = playApi.startsWith('http') ? playApi : 'https://' + playApi;
  try {
    const resp = await fetch(`${apiBase}/api/apps/?q=${encodeURIComponent(term)}&country=us&lang=en`, { headers: { Accept: "application/json" } });
    if (!resp.ok) return jsonResponse({ error: `API error: ${resp.status}` }, 500);
    const data = await resp.json();
    const results = (data.results || []).map(app => ({
      appId: app.appId, title: app.title, icon: app.icon,
      developer: typeof app.developer === 'object' ? (app.developer.devId || app.developer.name || '') : (app.developer || ''),
      score: app.score, scoreText: app.scoreText, price: app.price, free: app.free,
      currency: app.currency, containsAds: app.containsAds,
      offersIAP: app.offersIAP || app.inAppPurchases,
      IAPRange: (app.IAPRange || '').replace(/\s*per\s*item\s*$/i, '')
    }));
    return jsonResponse({ ok: true, results });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

// ── 应用详情 ──
export async function handleAppDetail(request, env) {
  const url = new URL(request.url);
  const appId = url.searchParams.get("appId");
  if (!appId) return jsonResponse({ error: "appId required" }, 400);
  const playApi = env.PLAY_API;
  if (!playApi) return jsonResponse({ error: "PLAY_API not configured" }, 400);
  const apiBase = playApi.startsWith('http') ? playApi : 'https://' + playApi;
  try {
    const resp = await fetch(`${apiBase}/api/apps/${encodeURIComponent(appId)}?country=${url.searchParams.get('country') || 'us'}`, { headers: { Accept: "application/json" } });
    if (!resp.ok) return jsonResponse({ error: `API ${resp.status}` }, 500);
    const d = await resp.json();
    return jsonResponse({
      ok: true, title: d.title, icon: d.icon,
      developer: typeof d.developer === 'object' ? (d.developer.devId || d.developer.name || '') : (d.developer || ''),
      score: d.score, scoreText: d.scoreText, price: d.price, free: d.free, currency: d.currency,
      offersIAP: d.offersIAP || d.inAppPurchases || false,
      IAPRange: (d.IAPRange || '').replace(/\s*per\s*item\s*$/i, ''),
      containsAds: d.containsAds, installs: d.installs
    });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

// ── 通知历史 ──
export async function handleHistory(env) {
  const history = await getNotifications(env.DB, HISTORY_MAX);
  return jsonResponse(history);
}

export async function handleClearHistory(request, env) {
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM notifications").run();
    return jsonResponse({ ok: true });
  }
  if (request.method === "PATCH") {
    // 标记全部已读（将 notified 设为 2 表示已读）
    await env.DB.prepare("UPDATE notifications SET notified=2 WHERE notified=1").run();
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "Method not allowed" }, 405);
}

// ── 价格走势 ──
export async function handleTrend(request, env) {
  const url = new URL(request.url);
  const appId = url.searchParams.get("appId");
  if (!appId || appId.trim() === "") return jsonResponse({ error: "appId parameter is required" }, 400);
  const range = url.searchParams.get("range") || "week";
  if (!["week","month","year"].includes(range)) return jsonResponse({ error: "invalid range, must be week/month/year" }, 400);
  const country = url.searchParams.get("country") || "us";

  const now = new Date();
  let since;
  if (range === "week") since = new Date(now.getTime() - 7 * 86400000).toISOString();
  else if (range === "month") since = new Date(now.getTime() - 30 * 86400000).toISOString();
  else if (range === "year") since = new Date(now.getTime() - 365 * 86400000).toISOString();
  else return jsonResponse({ error: "invalid range" }, 400);

  let data = await getPriceHistory(env.DB, appId, country, since);
  if (range === "year") {
    const dayMap = {};
    for (const r of data) { dayMap[r.recorded_at.substring(0, 10)] = r; }
    data = Object.values(dayMap).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  }

  return jsonResponse({
    ok: true, app_id: appId, range,
    data: data.map(r => ({ price: r.price, free: !!r.free, currency: r.currency, priceText: r.price_text, time: r.recorded_at }))
  });
}

// ── 应用最近动态(通知记录) ──
export async function handleAppEvents(request, env) {
  const url = new URL(request.url);
  const appId = url.searchParams.get("appId");
  if (!appId) return jsonResponse({ error: "appId required" }, 400);
  try {
    // 查询该应用的通知记录（含原始价格）
    const r = await env.DB.prepare(
      "SELECT n.*, a.base_price as original_price FROM notifications n LEFT JOIN apps a ON n.app_id = a.id WHERE n.app_id=? ORDER BY n.time DESC LIMIT 20"
    ).bind(appId).all();
    const records = r.results || [];
    const events = records.map(n => {
      const orig = n.original_price || n.price;
      const diff = orig - n.price;
      const pct = orig > 0 ? ((diff / orig) * 100).toFixed(1) : '0';
      return {
        type: diff > 0 ? '降价' : (diff < 0 ? '涨价' : '不变'),
        old_price: '$' + orig,
        new_price: '$' + n.price,
        pct: pct,
        time: n.time
      };
    });
    return jsonResponse({ ok: true, app_id: appId, events });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

// ── 手动触发检查 ──
export async function handleCheck(env) {
  const result = await monitorAndNotify(env);
  return jsonResponse(result);
}

// ── KV → D1+R2 数据迁移 ──
export async function handleMigrate(env) {
  const { DB, ICONS, KV } = env;
  const result = { apps: 0, icons: 0, notifications: 0, status_restored: 0, errors: [] };
  const now = new Date().toISOString();

  // 1. 迁移应用配置 + 状态
  try {
    const kvApps = await KV.get("config:apps", "json") || [];
    for (const app of kvApps) {
      try {
        const st = await KV.get("status:" + app.id, "json") || {};
        await DB.prepare(
          `INSERT OR REPLACE INTO apps
           (id,name,threshold,country,countries,lang,note,monitor_mode,
            created_at,updated_at,
            last_price,last_free,last_currency,last_price_text,last_icon,last_score,last_score_text,
            last_installs,last_developer,last_contains_ads,
            last_prices_by_country,last_notified_price,last_notified_at,
            last_checked_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,
             ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          app.id, app.name || app.id,
          app.threshold ?? 6,
          app.country || "us",
          JSON.stringify(app.countries || [app.country || "us"]),
          app.lang || "en",
          app.note || "",
          app.monitor_mode || "threshold",

          app.created_at || now, now,
          st.last_checked_price ?? null,
          st.last_checked_free ?? 0, "USD", null,
          st.icon || "",
          st.score ?? null, st.scoreText || "",
          st.installs || "",
          typeof st.developer === 'object' ? JSON.stringify(st.developer) : (st.developer || ""),
          st.containsAds ? 1 : 0,
          JSON.stringify(st.prices_by_country || {}),
          st.last_notified_price ?? null, st.last_notified_at || null,
          st.last_checked_at || null
        ).run();
        result.apps++;
        if (Object.keys(st).length > 0) result.status_restored++;
      } catch (e) { result.errors.push(`app ${app.id}: ${e.message}`); }
    }
  } catch (e) { result.errors.push("read config:apps: " + e.message); }

  // 2. 迁移通知历史
  try {
    const history = await KV.get("history", "json") || [];
    for (const h of history) {
      try {
        await DB.prepare(
          "INSERT INTO notifications (app_id, name, price, threshold, type, notified, time) VALUES (?,?,?,?,?,?,?)"
        ).bind(h.app_id || "", h.name || "", h.price || 0, h.threshold || 0, h.type || "price", h.notified ? 1 : 0, h.time || now).run();
        result.notifications++;
      } catch (e) { result.errors.push(`notification: ${e.message}`); }
    }
  } catch (e) { result.errors.push("read history: " + e.message); }

  // 3. 迁移图标 (KV → R2)
  if (ICONS) {
    try {
      const listResult = await KV.list({ prefix: "icon_data:" });
      for (const key of listResult.keys) {
        try {
          const appId = key.name.substring(10);
          if (await ICONS.get("icons/" + appId)) continue;
          const data = await KV.get(key.name, "text");
          if (!data) continue;
          const parts = data.split(",");
          if (parts.length < 2) continue;
          const mime = parts[0].match(/data:([^;]+)/);
          const buf = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0));
          await ICONS.put("icons/" + appId, buf, { httpMetadata: { contentType: mime ? mime[1] : "image/png" } });
          result.icons++;
        } catch (e) { result.errors.push(`icon ${key.name}: ${e.message}`); }
      }
    } catch (e) { result.errors.push("icon migration: " + e.message); }
  }

  return jsonResponse(result);
}
