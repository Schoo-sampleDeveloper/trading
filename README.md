# 📈 デイリー金融ニュース

毎朝6:30 JST に金融ニュースを自動収集・AI要約し、  
GitHub Pages で公開 → iPhone の RSS リーダーで通知受信するシステムです。

---

## カバー対象
- 🇯🇵 日本株（日経平均、TOPIX）
- 🇺🇸 米国株（S&P500、NASDAQ、ダウ）
- 💱 為替（ドル円・ユーロ円）
- 📊 株価指数先物（CME）
- 🏦 マクロ経済（FOMC・日銀・CPI・GDP）

---

## セットアップ手順

### 1. リポジトリ作成

GitHub で新しいリポジトリを作成し、このコードをプッシュします。

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/あなたのユーザー名/trading.git
git push -u origin main
```

---

### 2. Groq API キーの取得

1. [https://console.groq.com/](https://console.groq.com/) にアクセス
2. 無料アカウントを作成
3. 「API Keys」→「Create API Key」でキーを生成
4. 生成されたキー（`gsk_xxx...`）をコピーして保管

---

### 3. GitHub Secrets の設定

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で以下を追加:

| シークレット名 | 値 |
|---|---|
| `GROQ_API_KEY` | 取得した Groq API キー |
| `SITE_BASE_URL` | `https://あなたのユーザー名.github.io/trading` |

---

### 4. GitHub Pages の有効化

1. リポジトリの **Settings → Pages**
2. **Source**: `Deploy from a branch`
3. **Branch**: `main` / `docs` フォルダ を選択
4. **Save** をクリック
5. 数分後に `https://あなたのユーザー名.github.io/trading` で公開されます

---

### 5. iPhone で RSS を購読する

#### Reeder (有料・高機能)
1. App Store で「Reeder」をインストール
2. アプリ内でアカウント追加 → **RSS**
3. URL: `https://あなたのユーザー名.github.io/trading/feed.xml` を入力
4. 新着通知を ON に設定

#### NetNewsWire (無料)
1. App Store で「NetNewsWire」をインストール
2. ＋ ボタン → **Add a Feed**
3. URL: `https://あなたのユーザー名.github.io/trading/feed.xml` を入力

---

### 6. ホーム画面にアプリとして追加 (PWA)

1. iPhone の Safari で `https://あなたのユーザー名.github.io/trading` を開く
2. 共有ボタン → **ホーム画面に追加**
3. アプリのように起動できます

---

## ローカルテスト

```bash
# 依存パッケージのインストール
pip install -r requirements.txt

# .env ファイルを作成
cp .env.example .env
# .env を編集して GROQ_API_KEY を設定

# 実行
python main.py

# 生成されたファイルを確認
open docs/index.html
```

---

## ファイル構成

```
trading/
├── .github/
│   └── workflows/
│       └── daily.yml        # GitHub Actions (平日6:30 JST 自動実行)
├── docs/                    # GitHub Pages 公開ディレクトリ
│   ├── index.html           # 最新ニュース (自動生成)
│   ├── feed.xml             # RSS フィード (自動生成)
│   ├── archive/
│   │   └── YYYY-MM-DD.html  # アーカイブ (自動生成)
│   ├── manifest.json        # PWA マニフェスト
│   └── sw.js                # Service Worker (オフライン対応)
├── templates/
│   └── index.html.j2        # HTML テンプレート
├── collector.py             # RSSニュース収集
├── summarizer.py            # Groq AI 要約
├── build_site.py            # HTML/RSS 生成
├── main.py                  # エントリポイント
├── requirements.txt
├── .env.example
└── README.md
```

---

## ニュースソース

| ソース | カテゴリ |
|---|---|
| Bloomberg Markets RSS | マクロ経済 |
| MarketWatch Top Stories | 米国株 |
| Investing.com | マクロ経済 |
| Google News (日経平均) | 日本株 |
| Google News (ドル円) | 為替 |
| Google News (FOMC) | マクロ |
| Google News (日銀) | 日本株 |
| Google News (S&P500) | 米国株 |
| Google News (先物 CME) | 先物 |
| Google News (ETF) | 指数 |

---

## 技術スタック

- **Python 3.11**
- **feedparser** — RSS 収集
- **httpx** — HTTP クライアント
- **groq** — AI 要約 (llama-3.3-70b-versatile)
- **jinja2** — HTML テンプレート
- **GitHub Actions** — 定期実行
- **GitHub Pages** — 静的サイト公開

---

## よくある質問

**Q: 無料で使えますか?**  
A: はい。Groq API・GitHub Actions・GitHub Pages はすべて無料枠内で動作します。

**Q: 土日はどうなりますか?**  
A: GitHub Actions の cron 設定で平日（月〜金）のみ実行されます。手動実行も可能です。

**Q: 記事が取得できない場合は?**  
A: RSS ソースの一時的な障害の可能性があります。Actions の実行ログを確認してください。
