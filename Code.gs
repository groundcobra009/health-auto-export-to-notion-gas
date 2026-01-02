/**
 * Health Auto Export -> GAS(WebApp) -> (Sheets hourly) + (Notion daily upsert)
 *
 * 事前準備:
 * - スプレッドシートで拡張機能 > Apps Script
 * - この Code.gs と Sidebar.html を追加
 * - [デプロイ] > [新しいデプロイ] > 種類: ウェブアプリ
 *   - 実行ユーザー: 自分
 *   - アクセス: 全員（※HAEから叩けるように）
 *
 * HAE Automation 推奨:
 * - Export format: JSON
 * - Period: Since Last Sync
 * - Aggregation: Hourly
 * - (任意) Request Header: Authorization: Bearer <YOUR_TOKEN>
 */

const SETTINGS_KEYS = {
  NOTION_TOKEN: "NOTION_TOKEN",
  NOTION_DB_ID: "NOTION_DB_ID",
  HAE_BEARER_TOKEN: "HAE_BEARER_TOKEN",
  ERROR_WEBHOOK_URL: "ERROR_WEBHOOK_URL",
};

const NOTION_VERSION = "2022-06-28"; // 必要なら変更
const TZ = "Asia/Tokyo";

// Notionプロパティ名（Notion側の列名に合わせて変更）
const NOTION_PROPS = {
  TITLE: "タイトル", // Title property
  DATE: "日付",      // Date property
  STEPS: "歩数",
  ACTIVE_ENERGY: "アクティブエネルギー(kcal)",
  DISTANCE: "距離(km)",
  SLEEP_MIN: "睡眠(合計/分)",
  WEIGHT: "体重(kg)",
  BODY_FAT: "体脂肪(%)",
  LAST_SYNC: "最終同期",
  SESSION_ID: "セッションID",
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Health Auto Export")
    .addItem("設定を開く", "openSettingsSidebar")
    .addItem("Notion接続テスト", "testNotionConnectionFromMenu")
    .addToUi();
}

function openSettingsSidebar() {
  const html = HtmlService.createHtmlOutputFromFile("Sidebar")
    .setTitle("Health Auto Export 設定");
  SpreadsheetApp.getUi().showSidebar(html);
}

function getSettings_() {
  const p = PropertiesService.getScriptProperties();
  return {
    notionToken: p.getProperty(SETTINGS_KEYS.NOTION_TOKEN) || "",
    notionDatabaseId: p.getProperty(SETTINGS_KEYS.NOTION_DB_ID) || "",
    haeBearerToken: p.getProperty(SETTINGS_KEYS.HAE_BEARER_TOKEN) || "",
    errorWebhookUrl: p.getProperty(SETTINGS_KEYS.ERROR_WEBHOOK_URL) || "",
  };
}

function getSettingsForUi() {
  return getSettings_();
}

function saveSettingsFromUi(obj) {
  const p = PropertiesService.getScriptProperties();
  if (typeof obj !== "object" || obj === null) throw new Error("Invalid settings payload");

  if (obj.notionToken !== undefined) p.setProperty(SETTINGS_KEYS.NOTION_TOKEN, String(obj.notionToken || "").trim());
  if (obj.notionDatabaseId !== undefined) p.setProperty(SETTINGS_KEYS.NOTION_DB_ID, String(obj.notionDatabaseId || "").trim());
  if (obj.haeBearerToken !== undefined) p.setProperty(SETTINGS_KEYS.HAE_BEARER_TOKEN, String(obj.haeBearerToken || "").trim());
  if (obj.errorWebhookUrl !== undefined) p.setProperty(SETTINGS_KEYS.ERROR_WEBHOOK_URL, String(obj.errorWebhookUrl || "").trim());

  return { ok: true };
}

function testNotionConnectionFromMenu() {
  const res = testNotionConnection();
  SpreadsheetApp.getUi().alert(res.ok ? "Notion接続OK" : "Notion接続NG: " + res.error);
}

function testNotionConnection() {
  try {
    const s = getSettings_();
    if (!s.notionToken || !s.notionDatabaseId) {
      return { ok: false, error: "NOTION_TOKEN / NOTION_DB_ID が未設定です" };
    }
    // データベースに対して軽いquery
    const url = `https://api.notion.com/v1/databases/${encodeURIComponent(s.notionDatabaseId)}/query`;
    const resp = notionFetch_(url, "post", s.notionToken, { page_size: 1 });
    if (resp && resp.object) return { ok: true };
    return { ok: false, error: "Unexpected response" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Notion DBのプロパティを検証（存在チェック）
 */
function validateNotionDatabaseProperties() {
  try {
    const s = getSettings_();
    if (!s.notionToken || !s.notionDatabaseId) {
      return { ok: false, error: "NOTION_TOKEN / NOTION_DB_ID が未設定です" };
    }

    // データベース情報を取得
    const url = `https://api.notion.com/v1/databases/${encodeURIComponent(s.notionDatabaseId)}`;
    const opt = {
      method: "GET",
      muteHttpExceptions: true,
      headers: {
        Authorization: "Bearer " + s.notionToken,
        "Notion-Version": NOTION_VERSION,
      },
    };
    const res = UrlFetchApp.fetch(url, opt);
    const code = res.getResponseCode();
    const text = res.getContentText();

    if (code < 200 || code >= 300) {
      return { ok: false, error: `Notion API error ${code}: ${text}` };
    }

    const db = JSON.parse(text);
    const dbTitle = db.title && db.title[0] ? db.title[0].plain_text : "(無題)";
    const existingProps = db.properties || {};

    // 必要なプロパティをチェック
    const requiredProps = [
      { key: NOTION_PROPS.TITLE, expectedType: "title" },
      { key: NOTION_PROPS.DATE, expectedType: "date" },
      { key: NOTION_PROPS.STEPS, expectedType: "number" },
      { key: NOTION_PROPS.ACTIVE_ENERGY, expectedType: "number" },
      { key: NOTION_PROPS.DISTANCE, expectedType: "number" },
      { key: NOTION_PROPS.SLEEP_MIN, expectedType: "number" },
      { key: NOTION_PROPS.WEIGHT, expectedType: "number" },
      { key: NOTION_PROPS.BODY_FAT, expectedType: "number" },
      { key: NOTION_PROPS.LAST_SYNC, expectedType: "date" },
    ];

    const missing = [];
    const typeMismatch = [];
    const found = [];

    for (const req of requiredProps) {
      const prop = existingProps[req.key];
      if (!prop) {
        missing.push(req.key);
      } else if (prop.type !== req.expectedType) {
        typeMismatch.push(`${req.key}: 期待=${req.expectedType}, 実際=${prop.type}`);
      } else {
        found.push(req.key);
      }
    }

    if (missing.length === 0 && typeMismatch.length === 0) {
      return {
        ok: true,
        dbTitle: dbTitle,
        message: `DB「${dbTitle}」に必要なプロパティが揃っています ✅`,
        foundProps: found,
      };
    }

    let errorMsg = `DB「${dbTitle}」のプロパティに問題があります:\n`;
    if (missing.length > 0) {
      errorMsg += `\n❌ 未作成: ${missing.join(", ")}`;
    }
    if (typeMismatch.length > 0) {
      errorMsg += `\n⚠️ 型不一致: ${typeMismatch.join("; ")}`;
    }

    return { ok: false, error: errorMsg, dbTitle: dbTitle, missing, typeMismatch };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * HAE WebApp テスト受信（サンプルデータを処理）
 */
function testHaeReceive() {
  try {
    ensureSheets_();

    // サンプルペイロードを作成
    const now = new Date();
    const dateKey = Utilities.formatDate(now, TZ, "yyyy-MM-dd");
    const timestamp = Utilities.formatDate(now, TZ, "yyyy-MM-dd HH:mm:ss");

    const samplePayload = {
      data: {
        metrics: [
          {
            name: "step_count",
            units: "count",
            data: [{ qty: 1234, date: timestamp }],
          },
          {
            name: "active_energy",
            units: "kcal",
            data: [{ qty: 56.7, date: timestamp }],
          },
          {
            name: "distance_walking_running",
            units: "m",
            data: [{ qty: 890, date: timestamp }],
          },
        ],
      },
      sessionId: "TEST_SESSION_" + now.getTime(),
    };

    // 処理を実行
    const extracted = extractFromHealthAutoExport_(samplePayload);

    // Hourlyシートに追記
    if (extracted.hourlyRows.length) appendHourly_(extracted.hourlyRows);

    // Dailyシート + Notion upsert
    const dateKeys = Object.keys(extracted.dailyByDate);
    let notionResult = "スキップ（Token/DB未設定）";

    for (const dk of dateKeys) {
      const daily = extracted.dailyByDate[dk];
      upsertDailySheet_(dk, daily);

      const s = getSettings_();
      if (s.notionToken && s.notionDatabaseId) {
        upsertNotionDaily_(dk, daily, extracted.meta);
        notionResult = "送信成功 ✅";
      }
    }

    return {
      ok: true,
      message: `テスト受信成功 ✅\n\n📅 日付: ${dateKey}\n📊 Hourly行数: ${extracted.hourlyRows.length}\n📝 Notion: ${notionResult}`,
      dateKey: dateKey,
      hourlyRowCount: extracted.hourlyRows.length,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * WebApp URL を取得
 */
function getWebAppUrl() {
  try {
    const url = ScriptApp.getService().getUrl();
    if (url) {
      return { ok: true, url: url };
    }
    return { ok: false, error: "WebAppがデプロイされていません。[デプロイ] > [新しいデプロイ] を実行してください。" };
  } catch (e) {
    return { ok: false, error: "WebApp URL取得失敗: " + String(e) };
  }
}

/**
 * Notionデータベーススキーマ（JSON）を取得
 */
function getNotionDatabaseSchema() {
  return {
    databaseName: "Health Daily",
    description: "Health Auto Exportから受信したヘルスデータの日次サマリー",
    properties: [
      { name: "タイトル", type: "title", description: "YYYY-MM-DD形式の日付文字列", example: "2026-01-03", required: true },
      { name: "日付", type: "date", description: "フィルタ用の日付プロパティ", example: "2026-01-03", required: true },
      { name: "歩数", type: "number", description: "1日の合計歩数", example: 8234, required: true },
      { name: "アクティブエネルギー(kcal)", type: "number", description: "消費した活動エネルギー（kcal）", example: 412, required: true },
      { name: "距離(km)", type: "number", description: "歩行/走行距離（km）", example: 6.2, required: true },
      { name: "睡眠(合計/分)", type: "number", description: "合計睡眠時間（分）", example: 390, required: true },
      { name: "体重(kg)", type: "number", description: "体重（kg）", example: 68.4, required: true },
      { name: "体脂肪(%)", type: "number", description: "体脂肪率（%）", example: 18.2, required: true },
      { name: "最終同期", type: "date", description: "GASからの最終更新日時", example: "2026-01-03T07:12:00.000Z", required: true },
      { name: "セッションID", type: "rich_text", description: "HAEのセッション識別子（任意）", example: "abc123", required: false },
      { name: "メモ", type: "rich_text", description: "自由記述用（任意）", example: "", required: false },
    ],
  };
}

/**
 * WebApp endpoint
 */
function doPost(e) {
  try {
    ensureSheets_();

    verifyAuth_(e);

    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "";
    const payload = raw ? JSON.parse(raw) : null;

    appendRaw_(raw, e);

    if (!payload || !payload.data) {
      return text_(400, "Missing payload.data");
    }

    const extracted = extractFromHealthAutoExport_(payload);

    // Hourlyシートに追記
    if (extracted.hourlyRows.length) appendHourly_(extracted.hourlyRows);

    // Dailyシート + Notion upsert
    const dateKeys = Object.keys(extracted.dailyByDate);
    for (const dateKey of dateKeys) {
      const daily = extracted.dailyByDate[dateKey];
      upsertDailySheet_(dateKey, daily);
      upsertNotionDaily_(dateKey, daily, extracted.meta);
    }

    return text_(200, "ok");
  } catch (err) {
    notifyError_(err);
    return text_(500, "error: " + String(err));
  }
}

function verifyAuth_(e) {
  const s = getSettings_();
  const expected = (s.haeBearerToken || "").trim();
  if (!expected) return; // 未設定なら認証なし運用

  // Authorization: Bearer xxx
  const auth = (e && e.parameter && e.parameter.Authorization) ? String(e.parameter.Authorization) : null;
  // Apps Script の doPost はヘッダを直接取りにくいので、HAE側は「クエリ」または「JSON内」でも可。
  // ここでは「Authorization」をクエリパラメータで渡す簡易方式も許可。
  // 例: https://script.google.com/macros/s/.../exec?Authorization=Bearer%20xxx
  const qAuth = auth || (e && e.parameter && e.parameter.auth) ? String(e.parameter.auth) : "";

  const token = qAuth.startsWith("Bearer ") ? qAuth.slice("Bearer ".length).trim() : qAuth.trim();
  if (token !== expected) throw new Error("Unauthorized (token mismatch)");
}

function ensureSheets_() {
  const ss = SpreadsheetApp.getActive();
  createSheetIfMissing_(ss, "HAE_Raw", ["receivedAt", "contentType", "rawJson"]);
  createSheetIfMissing_(ss, "HAE_Hourly", ["timestamp_hour", "metric", "value", "unit", "dateKey", "source"]);
  createSheetIfMissing_(ss, "HAE_Daily", ["dateKey", "steps", "activeEnergyKcal", "distanceKm", "sleepMin", "weightKg", "bodyFatPct", "updatedAt"]);
}

function createSheetIfMissing_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const firstRow = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (firstRow.every(v => !v)) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
}

function appendRaw_(raw, e) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName("HAE_Raw");
  const receivedAt = new Date();
  const contentType = (e && e.postData && e.postData.type) ? e.postData.type : "";
  sh.appendRow([receivedAt, contentType, raw]);
}

function appendHourly_(rows) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName("HAE_Hourly");
  for (const r of rows) sh.appendRow(r);
}

function upsertDailySheet_(dateKey, daily) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName("HAE_Daily");
  const lastRow = sh.getLastRow();
  const values = (lastRow >= 2) ? sh.getRange(2, 1, lastRow - 1, 1).getValues().flat() : [];
  const idx = values.findIndex(v => String(v) === String(dateKey));
  const row = [
    dateKey,
    daily.steps ?? "",
    daily.activeEnergyKcal ?? "",
    daily.distanceKm ?? "",
    daily.sleepMin ?? "",
    daily.weightKg ?? "",
    daily.bodyFatPct ?? "",
    new Date(),
  ];
  if (idx >= 0) {
    sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }
}

/**
 * HAE JSON -> hourly rows + daily aggregates
 * 参照: HAE Wiki JSON Format (metrics: name/units/data[qty,date], sleep_analysis例)
 */
function extractFromHealthAutoExport_(payload) {
  const metrics = Array.isArray(payload.data.metrics) ? payload.data.metrics : [];
  const meta = {
    receivedAt: new Date(),
    // もしpayloadにセッションID等がある場合は拾う（無ければ空）
    sessionId: payload.sessionId || payload.session_id || "",
  };

  const hourlyRows = [];
  const dailyByDate = {}; // dateKey -> aggregate

  // 重複防止：metricごとの最終処理日時を保存（Since Last Sync が前提だが念のため）
  const scriptProps = PropertiesService.getScriptProperties();

  for (const m of metrics) {
    const name = String(m.name || "").trim();    // 例: step_count, active_energy, sleep_analysis...
    const unit = String(m.units || "").trim();
    const dataArr = Array.isArray(m.data) ? m.data : [];

    const lastTsKey = `LAST_TS_${name}`;
    const lastTsStr = scriptProps.getProperty(lastTsKey);
    const lastTs = lastTsStr ? new Date(lastTsStr) : new Date(0);
    let maxSeen = lastTs;

    for (const d of dataArr) {
      // 共通形式は qty + date
      // sleep_analysis は aggregated/unaggregated があり、dateKeyが yyyy-MM-dd のこともある
      const rawDateStr = d.date || d.startDate || d.sleepStart || null;
      if (!rawDateStr) continue;

      const dt = parseDate_(rawDateStr);
      if (!dt) continue;

      if (dt <= lastTs) continue;
      if (dt > maxSeen) maxSeen = dt;

      const dateKey = Utilities.formatDate(dt, TZ, "yyyy-MM-dd");
      const hourKey = Utilities.formatDate(dt, TZ, "yyyy-MM-dd HH:00:00");

      // 集計バケツ（1日1行）
      if (!dailyByDate[dateKey]) dailyByDate[dateKey] = {
        steps: null,
        activeEnergyKcal: null,
        distanceKm: null,
        sleepMin: null,
        weightKg: null,
        bodyFatPct: null,
      };

      // 値
      // 通常 metric: qty
      // sleep_analysis aggregated 例: asleep, totalSleep, inBed...
      const qty = (d.qty !== undefined && d.qty !== null) ? Number(d.qty) : null;

      // Hourly rows (数値が取れるものだけ)
      if (qty !== null && Number.isFinite(qty)) {
        hourlyRows.push([new Date(hourKey), name, qty, unit, dateKey, "health_auto_export"]);
      }

      // Daily aggregate mapping
      switch (name) {
        case "step_count": {
          dailyByDate[dateKey].steps = sum_(dailyByDate[dateKey].steps, qty);
          break;
        }
        case "active_energy": {
          // unitがkJ等なら換算したい場合があるが、まずはkcal前提。必要ならここで換算を追加。
          dailyByDate[dateKey].activeEnergyKcal = sum_(dailyByDate[dateKey].activeEnergyKcal, qty);
          break;
        }
        case "distance_walking_running":
        case "distance": {
          const km = toKm_(qty, unit);
          dailyByDate[dateKey].distanceKm = sum_(dailyByDate[dateKey].distanceKm, km);
          break;
        }
        case "sleep_analysis": {
          // aggregated: { date: yyyy-MM-dd, totalSleep/asleep/inBed... }
          // unaggregated: { startDate/endDate/value... }
          const sleepMin = sleepToMinutes_(d, unit);
          if (sleepMin !== null) dailyByDate[dateKey].sleepMin = sum_(dailyByDate[dateKey].sleepMin, sleepMin);
          break;
        }
        case "body_mass": {
          // 体重は「最新値」で上書き
          if (qty !== null && Number.isFinite(qty)) dailyByDate[dateKey].weightKg = Number(qty);
          break;
        }
        case "body_fat_percentage": {
          if (qty !== null && Number.isFinite(qty)) {
            dailyByDate[dateKey].bodyFatPct = normalizeBodyFat_(qty, unit);
          }
          break;
        }
        default:
          break;
      }
    }

    if (maxSeen > lastTs) scriptProps.setProperty(lastTsKey, maxSeen.toISOString());
  }

  // 日別の小数を整形
  for (const k of Object.keys(dailyByDate)) {
    if (dailyByDate[k].distanceKm !== null) dailyByDate[k].distanceKm = round_(dailyByDate[k].distanceKm, 3);
    if (dailyByDate[k].activeEnergyKcal !== null) dailyByDate[k].activeEnergyKcal = round_(dailyByDate[k].activeEnergyKcal, 1);
  }

  return { meta, hourlyRows, dailyByDate };
}

function parseDate_(s) {
  try {
    // HAEの日付は "yyyy-MM-dd HH:mm:ss Z" 形式等
    // JS Dateで素直に解釈できない形式もあるため、まずはそのまま試す
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;

    // "yyyy-MM-dd HH:mm:ss Z" -> "yyyy-MM-ddTHH:mm:ssZ" へ寄せる
    const t = String(s).replace(" ", "T");
    const d2 = new Date(t);
    if (!isNaN(d2.getTime())) return d2;

    // "yyyy-MM-dd" のみ
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) {
      return new Date(`${s}T00:00:00+09:00`);
    }
  } catch (_) {}
  return null;
}

function sum_(a, b) {
  const x = (a === null || a === undefined || a === "") ? 0 : Number(a);
  const y = (b === null || b === undefined || b === "") ? 0 : Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return a ?? b ?? null;
  return x + y;
}

function round_(v, digits) {
  const p = Math.pow(10, digits);
  return Math.round(Number(v) * p) / p;
}

function toKm_(qty, unit) {
  if (qty === null || !Number.isFinite(qty)) return null;
  const u = String(unit || "").toLowerCase();
  if (u === "m" || u === "meter" || u === "meters") return qty / 1000;
  if (u === "km" || u === "kilometer" || u === "kilometers") return qty;
  return qty; // 不明ならそのまま
}

function sleepToMinutes_(obj, unit) {
  // aggregated: totalSleep/asleep 等
  // 優先: totalSleep -> asleep -> qty
  let v = null;
  if (obj.totalSleep !== undefined) v = Number(obj.totalSleep);
  else if (obj.asleep !== undefined) v = Number(obj.asleep);
  else if (obj.qty !== undefined) v = Number(obj.qty);

  if (v === null || !Number.isFinite(v)) return null;

  const u = String(unit || "").toLowerCase();
  // よくある: hr, hours
  if (u.includes("hr") || u.includes("hour") || u === "h") return v * 60;
  // minutes
  if (u.includes("min")) return v;
  // seconds
  if (u.includes("sec")) return v / 60;
  return v; // 不明ならそのまま
}

function normalizeBodyFat_(qty, unit) {
  const u = String(unit || "").toLowerCase();
  // 0-1で来たら%化
  if (qty <= 1 && (u.includes("pct") || u.includes("%") || u.includes("percent") || u === "")) return qty * 100;
  return qty;
}

/**
 * Notion: dateKey(yyyy-MM-dd) の行を upsert
 * - Query database endpoint
 * - Date property は date type object
 */
function upsertNotionDaily_(dateKey, daily, meta) {
  const s = getSettings_();
  if (!s.notionToken || !s.notionDatabaseId) return; // 未設定ならスキップ

  const existing = findNotionPageByDate_(s.notionToken, s.notionDatabaseId, dateKey);
  if (existing && existing.id) {
    updateNotionPage_(s.notionToken, existing.id, dateKey, daily, meta);
  } else {
    createNotionPage_(s.notionToken, s.notionDatabaseId, dateKey, daily, meta);
  }
}

function findNotionPageByDate_(token, dbId, dateKey) {
  const url = `https://api.notion.com/v1/databases/${encodeURIComponent(dbId)}/query`;
  const body = {
    page_size: 1,
    filter: {
      property: NOTION_PROPS.DATE,
      date: { equals: dateKey },
    },
  };
  const resp = notionFetch_(url, "post", token, body);
  const results = resp && resp.results ? resp.results : [];
  return results.length ? results[0] : null;
}

function createNotionPage_(token, dbId, dateKey, daily, meta) {
  const url = "https://api.notion.com/v1/pages";
  const body = {
    parent: { database_id: dbId },
    properties: notionProps_(dateKey, daily, meta),
  };
  notionFetch_(url, "post", token, body);
}

function updateNotionPage_(token, pageId, dateKey, daily, meta) {
  const url = `https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`;
  const body = { properties: notionProps_(dateKey, daily, meta) };
  notionFetch_(url, "patch", token, body);
}

function notionProps_(dateKey, daily, meta) {
  const props = {};

  // Title
  props[NOTION_PROPS.TITLE] = {
    title: [{ text: { content: dateKey } }],
  };

  // Date
  props[NOTION_PROPS.DATE] = {
    date: { start: dateKey },
  };

  setNumberProp_(props, NOTION_PROPS.STEPS, daily.steps);
  setNumberProp_(props, NOTION_PROPS.ACTIVE_ENERGY, daily.activeEnergyKcal);
  setNumberProp_(props, NOTION_PROPS.DISTANCE, daily.distanceKm);
  setNumberProp_(props, NOTION_PROPS.SLEEP_MIN, daily.sleepMin);
  setNumberProp_(props, NOTION_PROPS.WEIGHT, daily.weightKg);
  setNumberProp_(props, NOTION_PROPS.BODY_FAT, daily.bodyFatPct);

  props[NOTION_PROPS.LAST_SYNC] = {
    date: { start: new Date().toISOString() },
  };

  if (meta && meta.sessionId) {
    props[NOTION_PROPS.SESSION_ID] = {
      rich_text: [{ text: { content: String(meta.sessionId) } }],
    };
  }

  return props;
}

function setNumberProp_(props, name, v) {
  if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) return;
  props[name] = { number: Number(v) };
}

function notionFetch_(url, method, token, bodyObj) {
  const opt = {
    method: method.toUpperCase(),
    muteHttpExceptions: true,
    headers: {
      Authorization: "Bearer " + token,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    payload: bodyObj ? JSON.stringify(bodyObj) : undefined,
  };

  const res = UrlFetchApp.fetch(url, opt);
  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`Notion API error ${code}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function notifyError_(err) {
  const s = getSettings_();
  const url = (s.errorWebhookUrl || "").trim();
  if (!url) return;

  try {
    UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        text: "[HAE->GAS] Error: " + String(err),
      }),
      muteHttpExceptions: true,
    });
  } catch (_) {}
}

function text_(code, msg) {
  return ContentService
    .createTextOutput(msg)
    .setMimeType(ContentService.MimeType.TEXT);
}

