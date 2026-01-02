# Health Auto Export → GAS → Notion/Sheets 連携

Health Auto Export（HAE）から取得したiPhoneヘルスデータを、Google Apps Script（GAS）経由で **Notionには日次サマリー（1日1行）**、**スプレッドシートには時間粒度データ**として自動格納するシステムです。

## 📋 概要

- **目的**: iPhoneのヘルスデータ（歩数・距離・睡眠・体重など）を継続的に可視化
- **データフロー**: Health Auto Export → GAS WebApp → Google Sheets（時間粒度） + Notion（日次サマリー）
- **特徴**: Apple Watch未使用を前提（心拍系データは基本対象外）

## ✨ 主な機能

- ✅ HAE REST APIからのJSON受信（WebApp）
- ✅ Google Sheetsへの時間粒度データ保存（hourly）
- ✅ Notionへの日次サマリー自動upsert（同日レコードがあれば更新、なければ作成）
- ✅ GASサイドバーUIによる設定管理（機密情報のマスク表示＋表示/非表示切替）
- ✅ エラー通知（Webhook経由、任意）

## 🗂️ データ格納仕様

### Notion（日次サマリー）

1日1レコードで以下を保存：

- 歩数（合計）
- アクティブエネルギー（合計）
- 歩行/走行距離（合計）
- 睡眠（合計）
- 体重（最新）
- 体脂肪率（最新）

### Google Sheets（時間粒度）

3つのシートで管理：

1. **HAE_Raw**: 受信ログ（JSON全文・障害解析用）
2. **HAE_Hourly**: 1時間粒度の時系列データ
3. **HAE_Daily**: 日次集計結果（Notion投入内容の写し）

## 🚀 セットアップ

### 1. Notion準備

1. Notion Integrationを作成し、トークンを取得
2. `Health Daily` データベースを作成
3. 以下のプロパティを追加：
   - `タイトル`（Title）
   - `日付`（Date）
   - `歩数`（Number）
   - `アクティブエネルギー(kcal)`（Number）
   - `距離(km)`（Number）
   - `睡眠(合計/分)`（Number）
   - `体重(kg)`（Number）
   - `体脂肪(%)`（Number）
   - `最終同期`（Date）
   - `セッションID`（Rich text、任意）
   - `メモ`（Rich text、任意）
4. データベースにIntegrationを接続

### 2. Google Sheets & GAS準備

1. Googleスプレッドシートを新規作成
2. `拡張機能` > `Apps Script` を開く
3. `Code.gs` と `Sidebar.html` をプロジェクトに追加
4. デプロイ:
   - `デプロイ` > `新しいデプロイ`
   - 種類: **ウェブアプリ**
   - 実行ユーザー: **自分**
   - アクセス: **全員**（HAEから叩けるように）
5. WebApp URLをコピー

### 3. GAS設定（サイドバーUI）

1. スプレッドシートで `Health Auto Export` メニュー > `設定を開く`
2. 以下を入力（目玉アイコンで表示/非表示切替可）:
   - **Notion Integration Token**
   - **Notion Database ID**
   - **HAE Bearer Token**（任意、受信認証用）
   - **エラー通知 Webhook URL**（任意、Discord/Slack等）
3. `保存` をクリック
4. `Notion接続テスト` で接続確認

### 4. Health Auto Export設定

1. HAEアプリで新しいAutomationを作成:
   - **Data Type**: Health Metrics
   - **Export Format**: JSON
   - **Endpoint**: GAS WebApp URL（`/exec`）
   - **Period**: **Since Last Sync**（推奨）
   - **Aggregation**: **Hourly**
   - **Sync Cadence**: **60 minutes**
2. （任意）認証トークンを設定した場合は、HAE側でAuthorizationヘッダーを追加

## 🔐 セキュリティ

- 機密情報（Notion Token、Webhook URL等）は `ScriptProperties` に保存
- サイドバーUIでは初期状態でマスク表示（`●●●●●●`）
- 目玉アイコンで一時的に実値を表示可能
- HAE→GAS送信にBearer認証を設定可能

## 🛠️ トラブルシュート

### データが入らない

- `HAE_Raw` シートを確認（受信ログが残っているか）
- GASログを確認（`表示` > `ログ`）
- Notion接続テストを実行

### メトリクス名が合わない

- `HAE_Raw` で実際の `metrics[].name` を確認
- `Code.gs` の `extractFromHealthAutoExport_` 関数内のswitch-caseを調整

### 重複データ

- HAEの設定で **Period: Since Last Sync** を使用推奨
- GAS側で `LAST_TS_*` プロパティで重複防止処理済み

## 📊 データ拡張

メトリクスを追加したい場合:

1. `Code.gs` の `NOTION_PROPS` にプロパティ名を追加
2. Notionデータベースに対応するプロパティを作成
3. `extractFromHealthAutoExport_` 関数のswitch-caseに処理を追加

## 📝 ライセンス

このプロジェクトは個人利用を前提としています。

## 🔗 参考資料

- [Health Auto Export](https://www.healthyapps.dev/)
- [HAE API JSON Format](https://github.com/Lybron/health-auto-export/wiki/API-Export---JSON-Format)
- [Notion API Documentation](https://developers.notion.com/)
