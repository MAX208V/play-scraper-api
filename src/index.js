// ==================== PricePrism — 入口 ====================
import {
  handleDashboard, handleAppsApi, handleCheck, handleHistory, handleClearHistory,
  handleSearch, handleAppDetail, handleCountries, handleBg,
  handleTrend, handleMigrate, handleAppEvents, handleIcon
} from './handlers.js';
import { monitorAndNotify } from './services.js';
import { jsonResponse } from './utils.js';

export default {
  async scheduled(event, env, ctx) {
    console.log("[Cron] 开始价格检查");
    const result = await monitorAndNotify(env);
    console.log("[Cron] 完成:", JSON.stringify(result.ok ? { ok: true, count: result.results?.length } : result));
  },

  async fetch(request, env) {
    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/dashboard") return await handleDashboard(env);
      if (path === "/api/apps") return await handleAppsApi(request, env);
      if (path === "/api/check") return await handleCheck(env);
      if (path === "/api/history" && (request.method === "DELETE" || request.method === "PATCH")) return await handleClearHistory(request, env);
      if (path === "/api/history") return await handleHistory(env);
      if (path === "/api/search") return await handleSearch(request, env);
      if (path === "/api/app-detail") return await handleAppDetail(request, env);
      if (path === "/api/countries") return await handleCountries();
      if (path === "/api/bg") return await handleBg(request);
      if (path === "/api/trend") return await handleTrend(request, env);
      if (path === "/api/app-events") return await handleAppEvents(request, env);
      if (path === "/api/icon") return await handleIcon(request, env);
      if (path === "/api/migrate") return await handleMigrate(env);
      if (path.startsWith("/api/")) return jsonResponse({ error: "Not found" }, 404);

      const response = await env.ASSETS.fetch(request);
      if (response.status === 404) {
        return env.ASSETS.fetch(new URL('/index.html', url.origin));
      }
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch (e) {
      console.error("[Error]", path, e.message);
      return jsonResponse({ error: e.message }, 500);
    }
  },
};
