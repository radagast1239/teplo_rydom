/**
 * ═══════════════════════════════════════════════════════════════════
 * НАСТРОЙКА ДЛЯ ХОСТИНГА (Beget, Sprut.io и т.д.)
 * ═══════════════════════════════════════════════════════════════════
 *
 * Если сайт лежит на обычном хостинге БЕЗ Node.js, папка с HTML — это
 * только «картинка». Сервер с API (server.js) должен работать ОТДЕЛЬНО.
 *
 * 1) Укажите ниже адрес API: только домен (без /api в конце), например:
 *    window.TR_API_BASE = "https://ваш-проект.up.railway.app";
 *
 * 2) Либо оставьте пустую строку — тогда запросы идут на тот же домен,
 *    что и страница (подходит только если Node запущен там же).
 *
 * Если раньше пробовали override: в консоли F12 можно сбросить
 * localStorage.removeItem("tr_api_base") — пока задан TR_API_BASE выше,
 * он не используется, но старый кэш страницы иногда мешает.
 */
window.TR_API_BASE = "https://teplo-ryadom-api-production.up.railway.app";

(function () {
  "use strict";

  function stripTrailingApi(u) {
    var s = String(u || "").trim().replace(/\/+$/, "");
    if (!s) return "";
    // Пути в коде уже вида /api/... — база должна быть без /api на конце
    if (/\/api$/i.test(s)) s = s.replace(/\/api$/i, "");
    return s.replace(/\/+$/, "");
  }

  window.resolveTeploApiBase = function resolveTeploApiBase() {
    if (typeof window.TR_API_BASE === "string" && window.TR_API_BASE.trim()) {
      return stripTrailingApi(window.TR_API_BASE);
    }
    try {
      var c = localStorage.getItem("tr_api_base");
      if (c) return stripTrailingApi(c);
    } catch (e) {}
    if (location.protocol === "file:") return "http://localhost:3000";
    var h = location.hostname;
    var p = location.port;
    var local = h === "localhost" || h === "127.0.0.1";
    if (local && p && p !== "3000") return "http://localhost:3000";
    return "";
  };
})();
