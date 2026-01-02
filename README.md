# Health Auto Export → Notion/Sheets 連携 (GAS)

iPhoneの **Health Auto Export** アプリから送信されるヘルスデータを Google Apps Script (GAS) で受信し、**Notion** と **Google スプレッドシート** に自動保存するシステムです。

## 📊 機能概要

| 保存先 | 粒度 | 内容 |
|--------|------|------|
| **Notion** | 1日1行 | 日次サマリー（歩数合計、距離合計など） |
| **Sheets** | 1時間ごと | 時系列データ（詳細分析用） |

### 対応メトリクス

- 歩数 (`step_count`)
- アクティブエネルギー (`active_energy`)
- 歩行/走行距離 (`distance_walking_running`)
- 睡眠時間 (`sleep_analysis`)
- 体重 (`body_mass`)
- 体脂肪率 (`body_fat_percentage`)

---

## 🚀 セットアップ手順

### 1. Google スプレッドシートを作成

1. [Google スプレッドシート](https://sheets.google.com) で新規スプレッドシートを作成
2. 名前を「Health Auto Export」など適当につける

### 2. Apps Script にコードを追加

1. メニュー「**拡張機能**」→「**Apps Script**」を開く
2. 既存の `Code.gs` の内容を、このリポジトリの `Code.gs` で置き換え
3. ファイル「**+**」→「**HTML**」で以下を追加:
   - `Sidebar` → `Sidebar.html` の内容をコピペ
   - `Help` → `Help.html` の内容をコピペ
4. 「**保存**」（Ctrl+S / Cmd+S）

### 3. GAS をデプロイ

1. 「**デプロイ**」→「**新しいデプロイ**」をクリック
2. 「種類を選択」で「**⚙ ウェブアプリ**」を選択
3. 以下の設定を行う:

| 設定項目 | 値 | 説明 |
|----------|-----|------|
| **説明** | `Health Auto Export v1.0` | 任意のバージョン説明 |
| **実行ユーザー** | **自分** | スクリプトの実行権限 |
| **アクセスできるユーザー** | **全員** | HAEからアクセスできるようにする |

4. 「**デプロイ**」をクリック
5. **WebApp URL** が表示されるのでコピー（後で使用）

> ⚠️ **重要**: 「全員」にすることでHAEアプリからアクセス可能になります。認証はBearer Tokenで別途行えます。

### 4. Notion データベースを作成

#### 4.1 データベース作成

Notionで新しいデータベースを作成し、以下のプロパティを追加します:

| プロパティ名 | タイプ | 必須 |
|-------------|--------|------|
| `タイトル` | Title | ✅ |
| `日付` | Date | ✅ |
| `歩数` | Number | ✅ |
| `アクティブエネルギー(kcal)` | Number | ✅ |
| `距離(km)` | Number | ✅ |
| `睡眠(合計/分)` | Number | ✅ |
| `体重(kg)` | Number | ✅ |
| `体脂肪(%)` | Number | ✅ |
| `最終同期` | Date | ✅ |
| `セッションID` | Rich text | - |
| `メモ` | Rich text | - |

> ⚠️ **注意**: プロパティ名は**完全一致**が必要です（括弧や記号含む）

#### 4.2 Integration 作成

1. [Notion Integrations](https://www.notion.so/my-integrations) にアクセス
2. 「**New integration**」をクリック
3. 名前を入力（例: `Health Auto Export`）
4. 「**Submit**」をクリック
5. **Internal Integration Token** をコピー（`secret_xxx...`）

#### 4.3 Integration をデータベースに接続

1. 作成したNotionデータベースを開く
2. 右上「**...**」→「**Connections**」→「**Add connections**」
3. 作成したIntegrationを選択して接続

#### 4.4 Database ID を取得

データベースのURLから取得:
```
https://www.notion.so/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...
                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                     この32文字がDatabase ID
```

### 5. GAS に設定を入力

1. スプレッドシートを開く
2. メニュー「**Health Auto Export**」→「**⚙️ 設定**」
3. サイドバーで以下を入力:
   - **Notion Integration Token**: `secret_xxx...`
   - **Notion Database ID**: 32文字のID
4. 「**💾 設定を保存**」をクリック
5. 「**🔍 Notion接続テスト**」で接続確認

### 6. Health Auto Export アプリを設定

iPhoneの Health Auto Export アプリで:

1. 「**Automations**」を開く
2. 新しいAutomationを作成
3. 以下を設定:

| 設定項目 | 推奨値 |
|----------|--------|
| **Data Types** | Health Metrics |
| **Export Format** | JSON |
| **Period** | Since Last Sync |
| **Aggregation** | Hourly |
| **Sync Cadence** | 60 minutes |
| **REST API URL** | GASのWebApp URL |

4. Automation を有効化

---

## 📁 ファイル構成

```
health-auto-export-to-notion-gas/
├── Code.gs                      # メインスクリプト
├── Sidebar.html                 # 設定UI（サイドバー）
├── Help.html                    # ヘルプダイアログ
├── README.md                    # このファイル
├── notion-database-schema.json  # Notionスキーマ定義
└── context.md                   # 要件定義書
```

---

## 🔧 デプロイ更新

コードを更新した場合:

1. 「**デプロイ**」→「**デプロイを管理**」
2. 右上の「✏️」（編集）アイコンをクリック
3. 「バージョン」を「**新バージョン**」に変更
4. 「**デプロイ**」をクリック

> 💡 URLは変わりません。HAEアプリの再設定は不要です。

---

## 🛠️ トラブルシューティング

### Notion接続テストが失敗する

- Integration Tokenが正しいか確認
- Database IDが正しいか確認
- IntegrationがDBに招待されているか確認

### プロパティ検証でエラーが出る

- プロパティ名が**完全一致**しているか確認
- プロパティの**型（Type）**が正しいか確認

### HAEからデータが来ない

- WebApp URLが正しいか確認（`/exec` で終わる）
- GASが正しくデプロイされているか確認
- HAEアプリで「Sync Now」を試す

### データがNotionに反映されない

1. `HAE_Raw` シートに受信ログがあるか確認
2. `HAE_Daily` シートにデータがあるか確認
3. Notion TokenとDB IDが設定されているか確認

---

## 📋 スプレッドシートの構造

GASは以下のシートを作成します。メニューの「📋 シート初期化」またはサイドバーから初期化できます。

| シート名 | 用途 |
|----------|------|
| `HAE_Settings` | 設定表示用（マスク表示、WebApp URL、統計情報） |
| `HAE_Log` | 操作ログ（受信、エラー、設定変更など） |
| `HAE_Raw` | 受信したJSONの生ログ（デバッグ用） |
| `HAE_Hourly` | 1時間粒度の時系列データ |
| `HAE_Daily` | 日次集計データ（Notionに送る内容の写し） |

### シート初期化

初回利用時は、以下のいずれかでシートを初期化してください:

1. **メニューから**: 「Health Auto Export」→「📋 シート初期化」
2. **サイドバーから**: 「⚙️ 設定」→「📋 シート初期化」ボタン

---

## 🔐 セキュリティ

### Bearer Token 認証（任意）

1. サイドバーで「HAE Bearer Token」を設定
2. HAEアプリ側でも同じトークンを設定
3. トークンが一致しない場合、リクエストは拒否されます

### Webhook 通知（任意）

エラー発生時にDiscord/Slackへ通知:

1. Webhook URLをサイドバーで設定
2. エラー発生時に自動通知されます

---

## 📄 ライセンス

MIT License

---

## 🙏 謝辞

- [Health Auto Export](https://www.healthyapps.dev/) - iOS ヘルスデータエクスポートアプリ
- [Notion API](https://developers.notion.com/) - Notion公式API
