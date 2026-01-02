以下は、今回の **Health Auto Export（HAE）→ GAS →（Notion 日次 / Sheets 時間）** 連携を前提にした **詳細な要件定義書** です。
（Apple Watch未使用＝心拍系は原則対象外）

---

# 要件定義書

**案件名**：Health Auto Export ヘルスデータ連携基盤（GAS経由でNotion/Sheetsへ格納）
**版**：1.0
**作成日**：2026-01-03（JST）
**作成者**：User

---

## 1. 背景・目的

### 1.1 背景

* iPhoneのヘルスデータ（歩数・距離・睡眠・体重など）を継続的に可視化したい。
* Notionは日次の振り返り・ダッシュボードに強いが、時系列の細粒度データには不向き。
* Sheetsは時系列の分析・集計に強いが、日次の記録・メモと統合しづらい。

### 1.2 目的

* Health Auto Export（以下HAE）が出力するヘルスデータを、GASで受け取り、

  * **Notionには1日1レコード（サマリー）**として蓄積
  * **スプレッドシートには1時間粒度（時系列）**として蓄積
    することで、運用しやすく再利用性の高いデータ基盤を構築する。

### 1.3 成果物

* Notion用データベース設計（プロパティ仕様）
* スプレッドシートのテーブル設計（シート/カラム/粒度/保存方針）
* Google Apps Script（WebApp受信・整形・格納・Notion連携・設定UI）
* 運用手順（デプロイ・HAE設定・トラブルシュート）

---

## 2. 対象範囲

### 2.1 対象（In Scope）

* HAE REST APIから送信されるJSONデータをGAS WebAppが受信
* 受信データを以下へ格納

  * Google Sheets：時間粒度データ（hourly）
  * Notion：日次サマリー（daily upsert）
* GASサイドバーUIによる設定管理（機密情報のマスクと可視化切替）
* エラー通知（Webhook）※任意

### 2.2 対象外（Out of Scope）

* Apple Watch由来の心拍・HRV等の高頻度生体データの精密分析
* 医療用途・診断支援
* リアルタイム監視（分単位の厳密同期保証）
* Notion内での詳細分析（グラフ作成等）

---

## 3. 前提・制約

### 3.1 前提

* UserはApple Watchを使わないため、心拍データは基本的に取得されない想定。
* HAEが提供するデータは、ユーザーの許可・端末状況に依存して欠損しうる。
* iOSの制約により、指定時刻どおりの定期実行は保証されない（遅延/欠落が起こり得る）。

### 3.2 技術制約

* GAS WebAppは受信頻度が高いと実行時間/クォータ制約に抵触する可能性があるため、

  * 受信データはまずRawログとして保存し、集計処理は軽量化する。
* Notion APIのレート制限があるため、日次 upsert は最小回数で行う。

---

## 4. システム全体像

### 4.1 データフロー

1. HAEが端末内ヘルスデータを抽出し、設定した周期でJSONを送信
2. GAS WebApp（doPost）が受信
3. 受信内容を

   * `HAE_Raw`（ログ）に保存
   * 時系列として `HAE_Hourly` に追記
   * 日次集計して `HAE_Daily` に反映
4. `HAE_Daily` 相当の内容を Notion に **日付キーでupsert**（同日レコードがあれば更新、なければ作成）

---

## 5. データ要件

## 5.1 収集対象データ（初期）

**日次サマリー（Notion/HAE_Daily）**

* 歩数（合計）
* アクティブエネルギー（合計）
* 歩行/走行距離（合計）
* 睡眠（合計）
* 体重（最新）
* 体脂肪率（最新）

**時間粒度（HAE_Hourly）**

* 1時間バケットの値（対象メトリクスごと）

※実際にHAEが送る `metrics[].name` を確認し、マッピングは運用開始後に拡張できるものとする。

### 5.2 データ粒度

* Notion：**日次（1日1行）**
* Sheets：**時間（1時間ごと）**
* Raw：受信単位（HAEの送信単位）

### 5.3 データ保持期間

* Sheets：基本は無期限（容量が問題になればアーカイブ方針を別途定める）
* Notion：無期限

---

## 6. Notion データベース要件（設計仕様）

### 6.1 データベース

* DB名：`Health Daily`（任意）
* 主キー：日付（`日付`プロパティ）＋タイトル（`YYYY-MM-DD`）

### 6.2 プロパティ要件

最低限以下のプロパティを持つこと：

* `タイトル`（Title）… `YYYY-MM-DD`
* `日付`（Date）… 同日の日付
* `歩数`（Number）
* `アクティブエネルギー(kcal)`（Number）
* `距離(km)`（Number）
* `睡眠(合計/分)`（Number）
* `体重(kg)`（Number）
* `体脂肪(%)`（Number）
* `最終同期`（DateTime）
* `セッションID`（Rich text）※任意
* `メモ`（Rich text）※任意

### 6.3 upsert要件

* `日付` が同じレコードが存在する場合：更新
* 存在しない場合：新規作成
* 更新対象：上記数値＋`最終同期`（常に更新）

---

## 7. Google Sheets テーブル要件（設計仕様）

### 7.1 シート構成

1. `HAE_Raw`

* 目的：受信ログの保存・障害解析・再処理用
* カラム例：`receivedAt`, `contentType`, `rawJson`

2. `HAE_Hourly`

* 目的：1時間粒度の時系列保存（分析・可視化用）
* カラム例：`timestamp_hour`, `metric`, `value`, `unit`, `dateKey`, `source`

3. `HAE_Daily`

* 目的：日次集計結果の保存（Notion投入結果の写し）
* カラム例：`dateKey`, `steps`, `activeEnergyKcal`, `distanceKm`, `sleepMin`, `weightKg`, `bodyFatPct`, `updatedAt`

### 7.2 重複・整合性

* 受信データが再送されても致命的に壊れないこと
* 最低限、同一 `dateKey` の日次行は上書きできること
* 時間粒度は “追記” が基本だが、重複が問題化した場合は将来キー制約を導入可能な設計とする

---

## 8. GAS 機能要件

### 8.1 WebApp受信（必須）

* HTTP POST を受け取り、JSONを解析して処理する
* 受信失敗時は 4xx/5xx を返す（障害原因の切り分けができるメッセージ）

### 8.2 Rawログ保存（必須）

* 受信した生JSONを `HAE_Raw` に保存する
* Rawログ保存が成功した後に後続処理を行う（再処理可能性を確保）

### 8.3 時間粒度シート書き込み（必須）

* 1時間バケットのデータとして `HAE_Hourly` に追記

### 8.4 日次集計・日次シート反映（必須）

* 受信データから日次集計を作成
* `HAE_Daily` は `dateKey` ベースで上書き/追記

### 8.5 Notion upsert（必須）

* `日付` equals `YYYY-MM-DD` で検索し、存在すれば更新、なければ作成
* Notionトークン/DB ID未設定の場合は、Notion連携をスキップし、Sheetsのみ動作してもよい

### 8.6 エラー通知（任意）

* 例外発生時にWebhookへ通知する（Discord/Slack等）

---

## 9. GAS 設定UI（サイドバー）要件

### 9.1 対象項目

* Notion Token
* Notion Database ID
* HAE受信認証トークン（任意）
* エラー通知Webhook URL（任意）

### 9.2 表示/マスク要件（User指定）

* APIキー、Webhook URLなどの機密情報を **アスタリスクではなく `●●●●●●` でマスク表示**
* 各入力欄の右側に **目玉アイコンボタン**を配置
* クリックで表示/非表示を切り替え
* 初期状態は **マスク表示（type="password"）**
* 表示時は **type="text"** へ切替し実値が見えること
* マスク表示中に保存しても `●●●●●●` 自体を保存しないこと（実値を保持）

### 9.3 操作要件

* 「保存」ボタンで ScriptProperties へ保存
* 「Notion接続テスト」ボタンでDB queryを実施し結果を表示

---

## 10. セキュリティ要件

### 10.1 機密情報管理

* Notion Token / Webhook URL 等は ScriptProperties に保存
* UIで表示する際は原則マスク。ユーザー操作で一時表示できる

### 10.2 WebApp認証（推奨）

* HAE→GAS送信に対して、Bearerトークン相当の認証を設ける
* トークン不一致の場合は拒否する

---

## 11. 非機能要件

### 11.1 可用性

* iOS/HAE側の都合で欠損が発生しても破綻しない（Rawで残る/再処理できる）

### 11.2 保守性

* メトリクス追加は「マッピングテーブル（switch/case等）追加」で拡張できる

### 11.3 性能

* 受信処理は短時間で完了する（Raw保存→必要最小限の整形→書き込み）
* Notion API呼び出し回数を最小化（同日upsert 1回に集約）

---

## 12. エラー処理要件

* JSONパース失敗：400相当で返し、Rawに残せる範囲で残す（可能なら）
* Notion API失敗：Sheets処理は継続、Notion部分のみ失敗として通知
* シート不存在：自動作成 or 初期化
* Webhook通知失敗：本体処理は失敗にしない（ベストエフォート）

---

## 13. テスト要件（受入条件）

### 13.1 設定UI

* 初期状態で全フィールドが `●●●●●●`（または空）で表示される
* 目玉アイコンを押すと実値が表示され、再度押すと `●●●●●●` に戻る
* マスク状態のまま保存しても実値が保持される（`●●●●●●` が保存されない）

### 13.2 受信〜格納

* 受信したJSONが `HAE_Raw` に保存される
* `HAE_Hourly` に時間粒度の行が増える
* `HAE_Daily` に dateKey の行が作成/更新される
* Notionに同日のページがなければ作成、あれば更新される

### 13.3 障害時

* Notionトークン未設定でもSheetsのみ動作する
* Notionが落ちてもRaw/Sheetsは残る
* エラーがWebhookへ通知される（設定時）

---

## 14. 運用要件

* デプロイ方式：GAS WebApp（実行ユーザー＝自分、アクセス＝HAEが呼べる範囲）
* HAE側の推奨設定：

  * Period：Since Last Sync
  * Aggregation：Hourly
  * Cadence：60分目安（ズレは許容）
* 週次/月次でのメンテ：

  * Rawログ肥大化対策（必要なら別ファイルへアーカイブ）
  * メトリクス名の差異があればマッピング追加

---

## 15. 今後の拡張（任意）

* 重複排除キー（`metric + timestamp_hour`）の導入
* ワークアウト（運動）を別DB/別シートに分離
* 日次のコンディション（主観）をNotionと紐付けて分析

---

必要なら、この要件定義書をそのまま **「設計書（基本設計/詳細設計）」** に落とすために、次は **HAEから実際に来た `metrics[].name` の一覧（Rawの一部でOK）** を前提に「マッピング仕様（どのnameをどの列に入れるか）」を確定版にします。



以下、**Health Auto Export →（REST API）→ GAS → Notion（1日1行）＋ Googleスプレッドシート（1時間粒度）**の設計と、そのまま動かせる **GAS一式（WebApp受信＋Notion連携＋設定サイドバーUI）** です。
※Apple Watch未使用＝**心拍は基本入らない想定**で設計します。

---

## 1) Health Auto Exportで「取れるデータ」は何か

Health Auto ExportのREST API（JSON）は、`data`配下に以下の配列を入れてPOSTしてきます：`metrics`, `workouts`, `stateOfMind`, `medications`, `symptoms`, `cycleTracking`, `ecg`, `heartRateNotifications`。 ([GitHub][1])
健康指標（metrics）は基本的に `name`, `units`, `data[]`（`qty` と `date`）の形です。 ([GitHub][1])
アプリとしては150+の指標・各種データに対応しています。 ([Manage and Export Apple Health Data][2])

---

## 2) どれくらいの頻度（粒度）で取るべきか（おすすめ）

Health Auto Export側には **Period（期間）** と **Aggregation（集計粒度）** と **Sync Cadence（最小同期間隔）** があり、特に **Periodは「Since Last Sync」** が重複防止に強いです。 ([Manage and Export Apple Health Data][3])
またiOS制約で「指定時刻に必ず動く」保証はなく、端末がロック中は動かない等の前提があります。 ([Manage and Export Apple Health Data][3])

### User案（Notionは1日1回、シートは1時間ごと）について

結論：**良いです。** 運用コストと分析しやすさのバランスが良いです。

### 実装としてのおすすめ（シンプル構成）

* **Health Auto Export Automationは1本でOK**

  * Data Type: Health Metrics（必要なら Workoutsも追加で別Automation）
  * Export Format: JSON
  * Period: **Since Last Sync** ([Manage and Export Apple Health Data][3])
  * Aggregation: **Hourly（1時間）**（無ければ最も近い粒度）
  * Sync Cadence: **60分**（または30分でもOK） ([Manage and Export Apple Health Data][3])
* GAS側で

  * **スプレッドシートへ“時間粒度”追記**
  * 同時に日別に集計して **Notionの「当日1行」をupsert（更新）**

---

## 3) Notion Database 設計（1日1行）

### データベース名例

* `Health Daily`

### プロパティ（列）設計

| プロパティ名           | Notion型   | 例                | 備考                                    |
| ---------------- | --------- | ---------------- | ------------------------------------- |
| タイトル             | Title     | `2026-01-03`     | 行の主キー扱い                               |
| 日付               | Date      | 2026-01-03       | フィルタ用（upsertに使用）                      |
| 歩数               | Number    | 8234             | `step_count`合計                        |
| アクティブエネルギー(kcal) | Number    | 412              | `active_energy`合計                     |
| 距離(km)           | Number    | 6.2              | `distance_walking_running`合計（mならkm換算） |
| 睡眠(合計/分)         | Number    | 390              | `sleep_analysis`（入る場合）                |
| 体重(kg)           | Number    | 68.4             | `body_mass`（入る場合）                     |
| 体脂肪(%)           | Number    | 18.2             | `body_fat_percentage`（入る場合）           |
| 最終同期             | Date      | 2026-01-03 07:12 | GASが更新                                |
| セッションID          | Rich text | `...`            | 任意（payload由来があれば）                     |
| メモ               | Rich text |                  | 任意                                    |

> 心拍系はプロパティ自体作らなくてOK（Watchなし前提）。

---

## 4) スプレッドシート（1時間粒度）テーブル設計

スプレッドシートに3シート作ります（スクリプトが無ければ作成します）：

1. `HAE_Raw`：受信ログ（JSON全文・ヘッダなど）
2. `HAE_Hourly`：1時間粒度の時系列

   * columns: `timestamp_hour`, `metric`, `value`, `unit`, `dateKey`, `source`
3. `HAE_Daily`：GAS側の日別集計（Notionに送った内容の写し）

   * columns: `dateKey`, `steps`, `activeEnergyKcal`, `distanceKm`, `sleepMin`, `weightKg`, `bodyFatPct`, `updatedAt`

---

## 5) GAS：そのままコピペで動く一式

### 5-1. Code.gs

```javascript
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
 * 参照: HAE Wiki JSON Format (metrics: name/units/data[qty,date], sleep_analysis例) :contentReference[oaicite:7]{index=7}
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
      // 共通形式は qty + date :contentReference[oaicite:8]{index=8}
      // sleep_analysis は aggregated/unaggregated があり、dateKeyが yyyy-MM-dd のこともある :contentReference[oaicite:9]{index=9}
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
      // sleep_analysis aggregated 例: asleep, totalSleep, inBed... :contentReference[oaicite:10]{index=10}
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
          // aggregated: { date: yyyy-MM-dd, totalSleep/asleep/inBed... } :contentReference[oaicite:11]{index=11}
          // unaggregated: { startDate/endDate/value... } :contentReference[oaicite:12]{index=12}
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
    // HAEの日付は "yyyy-MM-dd HH:mm:ss Z" 形式等 :contentReference[oaicite:13]{index=13}
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
  // aggregated: totalSleep/asleep 等 :contentReference[oaicite:14]{index=14}
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
 * - Query database endpoint :contentReference[oaicite:15]{index=15}
 * - Date property は date type object :contentReference[oaicite:16]{index=16}
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
```

---

### 5-2. Sidebar.html（要件どおり：●●●●●●でマスク＋目玉アイコンで表示切替）

```html
<!doctype html>
<html>
  <head>
    <base target="_top">
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 12px; }
      .row { margin-bottom: 12px; }
      .label { font-size: 12px; margin-bottom: 6px; color: #333; }
      .fieldWrap { display: flex; align-items: center; gap: 8px; }
      input[type="text"], input[type="password"] {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid #ccc;
        border-radius: 8px;
      }
      .eyeBtn {
        width: 36px;
        height: 36px;
        border: 1px solid #ccc;
        border-radius: 10px;
        background: #fff;
        cursor: pointer;
        display: grid;
        place-items: center;
        user-select: none;
      }
      .btnRow { display: flex; gap: 8px; margin-top: 8px; }
      button.primary {
        background: #111;
        color: #fff;
        border: none;
        padding: 10px 12px;
        border-radius: 10px;
        cursor: pointer;
      }
      button.secondary {
        background: #f3f3f3;
        color: #111;
        border: 1px solid #ddd;
        padding: 10px 12px;
        border-radius: 10px;
        cursor: pointer;
      }
      .hint { font-size: 12px; color: #666; margin-top: 8px; line-height: 1.4; }
      .status { font-size: 12px; margin-top: 10px; white-space: pre-wrap; }
    </style>
  </head>

  <body>
    <div class="row">
      <div class="label">Notion Integration Token</div>
      <div class="fieldWrap">
        <input id="notionToken" type="password" autocomplete="off" />
        <div class="eyeBtn" onclick="toggleMask('notionToken')" title="表示/非表示">👁</div>
      </div>
    </div>

    <div class="row">
      <div class="label">Notion Database ID</div>
      <div class="fieldWrap">
        <input id="notionDatabaseId" type="password" autocomplete="off" />
        <div class="eyeBtn" onclick="toggleMask('notionDatabaseId')" title="表示/非表示">👁</div>
      </div>
    </div>

    <div class="row">
      <div class="label">HAE Bearer Token（任意：受信認証）</div>
      <div class="fieldWrap">
        <input id="haeBearerToken" type="password" autocomplete="off" />
        <div class="eyeBtn" onclick="toggleMask('haeBearerToken')" title="表示/非表示">👁</div>
      </div>
      <div class="hint">
        Health Auto Export側で Authorization を付けられない場合は、WebApp URL に
        <code>?auth=Bearer%20TOKEN</code> を付けて運用もできます（Code.gs側が受けます）。
      </div>
    </div>

    <div class="row">
      <div class="label">エラー通知 Webhook URL（任意：Discord/Slack等）</div>
      <div class="fieldWrap">
        <input id="errorWebhookUrl" type="password" autocomplete="off" />
        <div class="eyeBtn" onclick="toggleMask('errorWebhookUrl')" title="表示/非表示">👁</div>
      </div>
    </div>

    <div class="btnRow">
      <button class="primary" onclick="save()">保存</button>
      <button class="secondary" onclick="testNotion()">Notion接続テスト</button>
    </div>

    <div class="status" id="status"></div>

    <script>
      const MASK = "●●●●●●";
      const real = {
        notionToken: "",
        notionDatabaseId: "",
        haeBearerToken: "",
        errorWebhookUrl: "",
      };
      const shown = {
        notionToken: false,
        notionDatabaseId: false,
        haeBearerToken: false,
        errorWebhookUrl: false,
      };

      function setStatus(msg) {
        document.getElementById("status").textContent = msg || "";
      }

      function applyMasked(id) {
        const el = document.getElementById(id);
        if (!real[id]) {
          el.value = "";
          return;
        }
        el.value = shown[id] ? real[id] : MASK;
        el.type = shown[id] ? "text" : "password";
      }

      function toggleMask(id) {
        shown[id] = !shown[id];
        applyMasked(id);
      }

      function load() {
        setStatus("読み込み中...");
        google.script.run
          .withSuccessHandler((s) => {
            real.notionToken = s.notionToken || "";
            real.notionDatabaseId = s.notionDatabaseId || "";
            real.haeBearerToken = s.haeBearerToken || "";
            real.errorWebhookUrl = s.errorWebhookUrl || "";

            // 初期状態はマスク表示
            Object.keys(real).forEach((k) => applyMasked(k));
            setStatus("");
          })
          .withFailureHandler((e) => setStatus("読み込み失敗: " + e))
          .getSettingsForUi();
      }

      function getInputValue(id) {
        // マスク表示中は、real値を返す（MASK文字列を保存しない）
        return shown[id] ? document.getElementById(id).value : real[id];
      }

      function save() {
        const payload = {
          notionToken: getInputValue("notionToken"),
          notionDatabaseId: getInputValue("notionDatabaseId"),
          haeBearerToken: getInputValue("haeBearerToken"),
          errorWebhookUrl: getInputValue("errorWebhookUrl"),
        };

        setStatus("保存中...");
        google.script.run
          .withSuccessHandler(() => {
            // 保存後、real更新してマスクに戻す
            Object.keys(payload).forEach((k) => {
              real[k] = payload[k] || "";
              shown[k] = false;
              applyMasked(k);
            });
            setStatus("保存しました");
          })
          .withFailureHandler((e) => setStatus("保存失敗: " + e))
          .saveSettingsFromUi(payload);
      }

      function testNotion() {
        setStatus("Notion接続テスト中...");
        google.script.run
          .withSuccessHandler((res) => {
            if (res.ok) setStatus("Notion接続OK");
            else setStatus("Notion接続NG: " + res.error);
          })
          .withFailureHandler((e) => setStatus("テスト失敗: " + e))
          .testNotionConnection();
      }

      load();
    </script>
  </body>
</html>
```

---

## 6) Health Auto Export 側の設定ポイント（最短で動かす）

* REST APIの受信先URL：GAS WebApp の `/exec`
* Period：**Since Last Sync**（重複を減らす） ([Manage and Export Apple Health Data][3])
* Aggregation：**Hourly**
* Sync Cadence：**60 minutes**（端末状況で前後する前提） ([Manage and Export Apple Health Data][3])

---

## 補足（重要）

* Notion APIで日付一致検索→更新（upsert）は **database query** で実装しています。 ([Notion Developers][4])
* Notionのプロパティ名（列名）は **Code.gsの `NOTION_PROPS` と完全一致**させてください。
* HAE側のメトリクス名は `step_count` などの想定でマッピングしています（必要なら、Userの実データの `metrics[].name` を1回 `HAE_Raw` で見て、switchのcaseを増やせばOKです）。

---

もし次に詰めるなら、Userの `HAE_Raw` に入った **実際の `metrics[].name` 一覧**を貼ってくれたら、**完全に取りこぼしゼロのマッピング（睡眠・体重など）**に調整してコードを確定版にします。

[1]: https://github.com/Lybron/health-auto-export/wiki/API-Export---JSON-Format "API Export   JSON Format · Lybron/health-auto-export Wiki · GitHub"
[2]: https://www.healthyapps.dev/?utm_source=chatgpt.com "Health Auto Export"
[3]: https://www.healthyapps.dev/blog/how-to-sync-apple-health-data-to-rest-api "How to Sync Apple Health Data via REST API — Manage and Export Apple Health Data"
[4]: https://developers.notion.com/reference/post-database-query?utm_source=chatgpt.com "Query a database"
