# 📈 デイリー金融ニュース

毎朝6:30 JST に金融ニュースを自動収集・AI学習コンテンツ化し、  
GitHub Pages で公開 → iPhone の RSS リーダーで通知受信するシステムです。

---

## カバー対象 (6カテゴリ)

| カテゴリID | 表示名 | 対象 |
|---|---|---|
| `jp_stock` | 🇯🇵 日本株式 | 日本個別株・企業決算 |
| `jp_index` | 📊 日本インデックス | 日経平均・TOPIX・グロース等 |
| `foreign_stock` | 🇺🇸 外国株式 | Apple/Tesla等 外国個別株 |
| `foreign_index` | 📈 外国インデックス | S&P500・NASDAQ・DAX等 |
| `futures` | 🎯 先物 | 日経先物・CME・商品先物 |
| `fx_macro` | 💱 為替・マクロ | 為替・金利・中央銀行・マクロ経済 |

---

## 主な機能

- **学習コンテンツ化**: 各記事につき「何が起きた・なぜ重要・用語解説・市場影響・投資判断のヒント」を生成
- **今日のテーマ**: 全記事を横断した学習コラムをトップに表示
- **重要度フィルタ**: ★4以上/全表示 を LocalStorage で記憶
- **用語集**: 各記事の専門用語を `data/glossary.json` に蓄積し `docs/glossary.html` として公開
- **カテゴリ別表示**: 折りたたみ可・タップでセクションジャンプ
- **翌日設定フォーム**: 重点カテゴリ・キーワード・本数を GitHub Issues 経由で送信
- **設定履歴**: `docs/preferences-history.html` で過去の設定を確認
- **免責事項**: 全ページに投資推奨でない旨を明記

---

## セットアップ手順

### 1. リポジトリ作成

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/あなたのユーザー名/trading.git
git push -u origin main
```

### 2. Groq API キーの取得

1. [https://console.groq.com/](https://console.groq.com/) でアカウント作成
2. 「API Keys」→「Create API Key」でキーを生成 (`gsk_xxx...`)

### 3. GitHub Secrets の設定

**Settings → Secrets and variables → Actions → New repository secret**:

| シークレット名 | 値 |
|---|---|
| `GROQ_API_KEY` | Groq API キー |
| `SITE_BASE_URL` | `https://あなたのユーザー名.github.io/trading` |

> `GITHUB_TOKEN` はワークフロー実行時に自動付与されます。

### 4. GitHub Pages の有効化

1. **Settings → Pages**
2. **Source**: `Deploy from a branch`
3. **Branch**: `main` / `docs` フォルダ → **Save**
4. 数分後に公開されます

### 5. iPhone RSS 購読

- **Reeder** / **NetNewsWire** 等で `https://ユーザー名.github.io/trading/feed.xml` を登録

### 6. ホーム画面に PWA 追加

1. Safari で `https://ユーザー名.github.io/trading` を開く
2. 共有ボタン → **ホーム画面に追加**

---

## 翌日設定フォームの使い方 (Fine-grained PAT)

ページ下部「🔮 明日のニュース、どこを重点的に?」フォームを使うと  
翌日の収集に反映されます。

### PAT の発行手順

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. **Generate new token**
3. **Repository access**: 対象リポジトリのみ選択
4. **Permissions**:
   - **Issues**: `Read and write`
5. **Generate token** → 生成されたトークン (`github_pat_...`) をコピー

### フォームの使い方

1. カテゴリを最大3つ選択
2. キーワードをカンマ区切りで入力（任意）
3. 記事本数を選択（20/30/40本）
4. 「📨 明日の設定を送信」をタップ
5. 初回のみトークン入力モーダルが表示されます（以降は自動使用）
6. 「🔄 設定をリセット」でトークン削除も可能

> **注意**: `article_count=40` はGroqのレート制限に近づきます。連続実行時は注意してください。

---

## カテゴリ分類キーワードのカスタマイズ

`collector.py` の `CATEGORY_KEYWORDS` 辞書を編集することで、  
各カテゴリへの分類精度を調整できます。

```python
CATEGORY_KEYWORDS = {
    "jp_stock": ["トヨタ", "ソニー", ...],  # ← キーワード追加・削除
    "fx_macro": ["FOMC", "日銀", ...],
    ...
}
```

---

## ローカルテスト

```bash
pip install -r requirements.txt
cp .env.example .env
# .env に GROQ_API_KEY を設定

python3 main.py

open docs/index.html
```

---

## ファイル構成

```
trading/
├── .github/
│   └── workflows/
│       └── daily.yml         # GitHub Actions (平日6:30 JST)
├── data/
│   └── glossary.json         # 用語集永続化データ (自動生成・累積)
├── docs/                     # GitHub Pages 公開ディレクトリ
│   ├── index.html            # 最新ニュース (自動生成)
│   ├── feed.xml              # RSS フィード (自動生成)
│   ├── glossary.html         # 用語集ページ (自動生成)
│   ├── preferences-history.html  # 設定履歴ページ (自動生成)
│   ├── archive/
│   │   └── YYYY-MM-DD.html   # アーカイブ (自動生成)
│   ├── manifest.json         # PWA マニフェスト
│   └── sw.js                 # Service Worker
├── templates/
│   └── index.html.j2         # Jinja2 テンプレート
├── collector.py              # RSS収集・カテゴリ分類・preferences読み込み
├── summarizer.py             # Groq AI 学習コンテンツ生成
├── build_site.py             # HTML/RSS/用語集/履歴ページ生成
├── main.py                   # エントリポイント
└── requirements.txt
```

---

## 技術スタック

- **Python 3.9+**
- **feedparser** — RSS 収集
- **httpx** — HTTP クライアント
- **groq** — AI 要約 (llama-3.3-70b-versatile)
- **jinja2** — HTML テンプレート
- **GitHub Actions** — 定期実行
- **GitHub Pages** — 静的サイト公開
- **GitHub Issues** — 翌日設定の受け渡し

---

## よくある質問

**Q: 無料で使えますか?**  
A: はい。Groq API・GitHub Actions・GitHub Pages はすべて無料枠内で動作します。

**Q: 記事30本のAPI消費は大丈夫ですか?**  
A: llama-3.3-70bはGroq無料枠で1日30本程度は問題なく処理できます。  
`article_count=40` を頻繁に使う場合はレート制限に注意してください。

**Q: 土日はどうなりますか?**  
A: GitHub Actions の cron 設定で平日（月〜金）のみ実行されます。手動実行も可能です。

**Q: カテゴリ分類が間違っている場合は?**  
A: `collector.py` の `CATEGORY_KEYWORDS` を調整するか、  
明らかな誤分類は `fx_macro` にフォールバックされます。
