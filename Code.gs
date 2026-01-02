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

// シート名定義
const SHEET_NAMES = {
  SETTINGS: "HAE_Settings",
  LOG: "HAE_Log",
  HOURLY: "HAE_Hourly",
  DAILY: "HAE_Daily",
};

// ログレベル
const LOG_LEVEL = {
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
  DEBUG: "DEBUG",
};

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

// ========================================
// メニュー
// ========================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Health Auto Export")
    .addItem("⚙️ 設定", "openSettingsSidebar")
    .addItem("📋 シート初期化", "initializeSheetsFromMenu")
    .addSeparator()
    .addItem("❓ 使い方・ヘルプ", "openHelpDialog")
    .addToUi();
}

function openSettingsSidebar() {
  const html = HtmlService.createHtmlOutputFromFile("Sidebar")
    .setTitle("Health Auto Export 設定");
  SpreadsheetApp.getUi().showSidebar(html);
}

function openHelpDialog() {
  const html = HtmlService.createHtmlOutputFromFile("Help")
    .setWidth(600)
    .setHeight(500);
  SpreadsheetApp.getUi().showModalDialog(html, "使い方・ヘルプ");
}

// ========================================
// シート初期化
// ========================================

/**
 * メニューからシート初期化
 */
function initializeSheetsFromMenu() {
  const ui = SpreadsheetApp.getUi();
  const result = ui.alert(
    "シート初期化",
    "以下のシートを作成/確認します:\n\n" +
    "• HAE_Settings（設定表示用）\n" +
    "• HAE_Log（操作ログ）\n" +
    "• HAE_Hourly（時間データ）\n" +
    "• HAE_Daily（日次データ）\n\n" +
    "実行しますか？",
    ui.ButtonSet.OK_CANCEL
  );

  if (result === ui.Button.OK) {
    initializeAllSheets();
    log_(LOG_LEVEL.INFO, "シート初期化", "メニューからシート初期化を実行しました");
    ui.alert("✅ シート初期化完了", "全てのシートが作成/確認されました。", ui.ButtonSet.OK);
  }
}

/**
 * 全シートを初期化
 */
function initializeAllSheets() {
  const ss = SpreadsheetApp.getActive();

  // Settings シート
  createSettingsSheet_(ss);

  // Log シート
  createSheetIfMissing_(ss, SHEET_NAMES.LOG, [
    "timestamp", "level", "category", "message", "details"
  ]);

  // データシート
  createSheetIfMissing_(ss, SHEET_NAMES.HOURLY, ["timestamp_hour", "metric", "value", "unit", "dateKey", "source"]);
  createSheetIfMissing_(ss, SHEET_NAMES.DAILY, ["dateKey", "steps", "activeEnergyKcal", "distanceKm", "sleepMin", "weightKg", "bodyFatPct", "updatedAt"]);

  // 設定値をSettingsシートに反映
  syncSettingsToSheet_();
}

/**
 * サイドバーから呼び出す用（UIなし）
 */
function initializeSheetsForUi() {
  try {
    initializeAllSheets();
    return { ok: true, message: "シートを初期化しました" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Settings シート作成
 */
function createSettingsSheet_(ss) {
  let sh = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAMES.SETTINGS);
  }

  // ヘッダー設定
  const headers = ["設定項目", "値", "説明"];
  const firstRow = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (firstRow.every(v => !v)) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);

    // 列幅調整
    sh.setColumnWidth(1, 200);
    sh.setColumnWidth(2, 300);
    sh.setColumnWidth(3, 300);

    // ヘッダースタイル
    sh.getRange(1, 1, 1, headers.length)
      .setBackground("#4285f4")
      .setFontColor("#ffffff")
      .setFontWeight("bold");
  }

  // 設定項目の定義
  const settingsData = [
    ["Notion Token", "", "Notion Integration Token（secret_xxx...）"],
    ["Notion Database ID", "", "NotionのDatabase ID（32文字）"],
    ["HAE Bearer Token", "", "HAEからの受信認証用トークン（任意）"],
    ["Error Webhook URL", "", "エラー通知用Webhook URL（任意）"],
    ["---", "---", "---"],
    ["WebApp URL", "", "HAEに設定するURL（デプロイ後に自動取得）"],
    ["最終受信日時", "", "最後にHAEからデータを受信した日時"],
    ["総受信回数", "", "HAEからの受信回数"],
  ];

  // 既存データがなければ初期値を設定
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) {
    sh.getRange(2, 1, settingsData.length, 3).setValues(settingsData);
  }
}

/**
 * ScriptPropertiesの設定をSettingsシートに同期
 */
function syncSettingsToSheet_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  if (!sh) return;

  const s = getSettings_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const data = sh.getRange(2, 1, lastRow - 1, 2).getValues();

  for (let i = 0; i < data.length; i++) {
    const key = data[i][0];
    let value = "";

    switch (key) {
      case "Notion Token":
        value = s.notionToken ? maskValue_(s.notionToken) : "(未設定)";
        break;
      case "Notion Database ID":
        value = s.notionDatabaseId ? maskValue_(s.notionDatabaseId) : "(未設定)";
        break;
      case "HAE Bearer Token":
        value = s.haeBearerToken ? maskValue_(s.haeBearerToken) : "(未設定)";
        break;
      case "Error Webhook URL":
        value = s.errorWebhookUrl ? maskValue_(s.errorWebhookUrl) : "(未設定)";
        break;
      case "WebApp URL":
        try {
          const url = ScriptApp.getService().getUrl();
          value = url || "(未デプロイ)";
        } catch (_) {
          value = "(未デプロイ)";
        }
        break;
    }

    if (value && key !== "---") {
      sh.getRange(i + 2, 2).setValue(value);
    }
  }
}

/**
 * 値をマスク表示
 */
function maskValue_(value) {
  if (!value) return "";
  if (value.length <= 8) return "●".repeat(value.length);
  return value.substring(0, 4) + "●●●●" + value.substring(value.length - 4);
}

// ========================================
// ログ機能
// ========================================

/**
 * ログを記録
 */
function log_(level, category, message, details) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(SHEET_NAMES.LOG);

    // シートがなければ作成
    if (!sh) {
      createSheetIfMissing_(ss, SHEET_NAMES.LOG, [
        "timestamp", "level", "category", "message", "details"
      ]);
      sh = ss.getSheetByName(SHEET_NAMES.LOG);
    }

    const timestamp = new Date();
    const detailsStr = details ? (typeof details === "object" ? JSON.stringify(details) : String(details)) : "";

    sh.appendRow([timestamp, level, category, message, detailsStr]);

    // ログが1000行を超えたら古いログを削除（パフォーマンス対策）
    const lastRow = sh.getLastRow();
    if (lastRow > 1000) {
      sh.deleteRows(2, lastRow - 1000);
    }
  } catch (e) {
    // ログ記録自体のエラーは無視（無限ループ防止）
    console.error("Log error:", e);
  }
}

/**
 * 受信統計を更新
 */
function updateReceiveStats_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  if (!sh) return;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const data = sh.getRange(2, 1, lastRow - 1, 2).getValues();

  for (let i = 0; i < data.length; i++) {
    const key = data[i][0];

    if (key === "最終受信日時") {
      sh.getRange(i + 2, 2).setValue(new Date());
    }

    if (key === "総受信回数") {
      const current = parseInt(data[i][1]) || 0;
      sh.getRange(i + 2, 2).setValue(current + 1);
    }
  }
}

// ========================================
// 設定管理
// ========================================

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

  // Settingsシートに同期
  syncSettingsToSheet_();

  log_(LOG_LEVEL.INFO, "設定", "設定を保存しました");

  return { ok: true };
}

// ========================================
// テスト・検証機能
// ========================================

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
    if (resp && resp.object) {
      log_(LOG_LEVEL.INFO, "Notion", "接続テスト成功");
      return { ok: true };
    }
    return { ok: false, error: "Unexpected response" };
  } catch (e) {
    log_(LOG_LEVEL.ERROR, "Notion", "接続テスト失敗", { error: String(e) });
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
      log_(LOG_LEVEL.INFO, "Notion", "プロパティ検証成功", { dbTitle });
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

    log_(LOG_LEVEL.WARN, "Notion", "プロパティ検証に問題あり", { missing, typeMismatch });
    return { ok: false, error: errorMsg, dbTitle: dbTitle, missing, typeMismatch };
  } catch (e) {
    log_(LOG_LEVEL.ERROR, "Notion", "プロパティ検証エラー", { error: String(e) });
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

    log_(LOG_LEVEL.INFO, "テスト", "テスト受信を開始", { dateKey });

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

    log_(LOG_LEVEL.INFO, "テスト", "テスト受信完了", { dateKey, hourlyRows: extracted.hourlyRows.length, notion: notionResult });

    return {
      ok: true,
      message: `テスト受信成功 ✅\n\n📅 日付: ${dateKey}\n📊 Hourly行数: ${extracted.hourlyRows.length}\n📝 Notion: ${notionResult}`,
      dateKey: dateKey,
      hourlyRowCount: extracted.hourlyRows.length,
    };
  } catch (e) {
    log_(LOG_LEVEL.ERROR, "テスト", "テスト受信失敗", { error: String(e) });
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

// ========================================
// WebApp エンドポイント
// ========================================

/**
 * WebApp endpoint
 */
function doPost(e) {
  try {
    ensureSheets_();

    verifyAuth_(e);

    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "";
    const payload = raw ? JSON.parse(raw) : null;

    if (!payload || !payload.data) {
      log_(LOG_LEVEL.WARN, "受信", "payload.dataが空", { raw: raw.substring(0, 200) });
      return text_(400, "Missing payload.data");
    }

    log_(LOG_LEVEL.INFO, "受信", "HAEからデータ受信", { size: raw.length });

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

    // 統計更新
    updateReceiveStats_();

    log_(LOG_LEVEL.INFO, "受信", "処理完了", { dateKeys, hourlyRows: extracted.hourlyRows.length });

    return text_(200, "ok");
  } catch (err) {
    log_(LOG_LEVEL.ERROR, "受信", "処理エラー", { error: String(err) });
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
  if (token !== expected) {
    log_(LOG_LEVEL.WARN, "認証", "認証失敗（トークン不一致）");
    throw new Error("Unauthorized (token mismatch)");
  }
}

// ========================================
// シート操作
// ========================================

function ensureSheets_() {
  const ss = SpreadsheetApp.getActive();
  createSheetIfMissing_(ss, SHEET_NAMES.HOURLY, ["timestamp_hour", "metric", "value", "unit", "dateKey", "source"]);
  createSheetIfMissing_(ss, SHEET_NAMES.DAILY, ["dateKey", "steps", "activeEnergyKcal", "distanceKm", "sleepMin", "weightKg", "bodyFatPct", "updatedAt"]);
}

function createSheetIfMissing_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const firstRow = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (firstRow.every(v => !v)) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);

    // ヘッダースタイル
    sh.getRange(1, 1, 1, headers.length)
      .setBackground("#4285f4")
      .setFontColor("#ffffff")
      .setFontWeight("bold");
  }
}

function appendHourly_(rows) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAMES.HOURLY);
  for (const r of rows) sh.appendRow(r);
}

function upsertDailySheet_(dateKey, daily) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAMES.DAILY);
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

// ========================================
// HAE データ抽出
// ========================================

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

// ========================================
// ユーティリティ
// ========================================

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

// ========================================
// Notion 連携
// ========================================

/**
 * Notion: dateKey(yyyy-MM-dd) の行を upsert
 * - Query database endpoint
 * - Date property は date type object
 */
function upsertNotionDaily_(dateKey, daily, meta) {
  const s = getSettings_();
  if (!s.notionToken || !s.notionDatabaseId) return; // 未設定ならスキップ

  try {
    const existing = findNotionPageByDate_(s.notionToken, s.notionDatabaseId, dateKey);
    if (existing && existing.id) {
      updateNotionPage_(s.notionToken, existing.id, dateKey, daily, meta);
      log_(LOG_LEVEL.DEBUG, "Notion", "ページ更新", { dateKey, pageId: existing.id });
    } else {
      createNotionPage_(s.notionToken, s.notionDatabaseId, dateKey, daily, meta);
      log_(LOG_LEVEL.DEBUG, "Notion", "ページ作成", { dateKey });
    }
  } catch (e) {
    log_(LOG_LEVEL.ERROR, "Notion", "upsert失敗", { dateKey, error: String(e) });
    throw e;
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

// ========================================
// エラー通知
// ========================================

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
