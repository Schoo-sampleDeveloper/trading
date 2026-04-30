"""
build_site.py
Jinja2 テンプレートから HTML / RSS を生成して docs/ に出力する。
用語集(glossary)の生成はスキップ(プロ向けリファイン後は不要)。
data/glossary.json は保持するが更新しない。
preferences-history ページも生成する。
"""

import json
import os
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import formatdate
from pathlib import Path

import httpx
from jinja2 import Environment, FileSystemLoader
from dotenv import load_dotenv

load_dotenv()

DOCS_DIR = Path(__file__).parent / "docs"
ARCHIVE_DIR = DOCS_DIR / "archive"
DATA_DIR = Path(__file__).parent / "data"
TEMPLATES_DIR = Path(__file__).parent / "templates"

JST = timezone(timedelta(hours=9))
BASE_URL = os.environ.get("SITE_BASE_URL", "https://example.github.io/trading").rstrip("/")


def _jst_now() -> datetime:
    return datetime.now(JST)


def _rss_date(dt: datetime) -> str:
    return formatdate(dt.timestamp(), usegmt=True)


def _build_preferences_history(base_url: str) -> None:
    """
    docs/preferences-history.html を生成。
    GitHub APIからcloseされた preferences ラベル付きIssueを取得して表示。
    """
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    token = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")

    history_items = []
    if token and repo:
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        url = (
            f"https://api.github.com/repos/{repo}/issues"
            f"?labels=preferences&state=closed&per_page=30&sort=created&direction=desc"
        )
        try:
            resp = httpx.get(url, headers=headers, timeout=15)
            issues = resp.json()
            for issue in issues:
                try:
                    prefs = json.loads(issue["body"])
                    history_items.append({
                        "number": issue["number"],
                        "title": issue["title"],
                        "created_at": issue["created_at"][:10],
                        "prefs": prefs,
                    })
                except Exception:
                    pass
        except Exception as e:
            print(f"  [WARN] preferences履歴取得失敗: {e}")

    cat_labels = {
        "jp_stock": "🇯🇵 日本株式",
        "jp_index": "📊 日本インデックス",
        "foreign_stock": "🇺🇸 外国株式",
        "foreign_index": "📈 外国インデックス",
        "futures": "🎯 先物",
        "fx_macro": "💱 為替・マクロ",
    }

    rows = ""
    for item in history_items:
        p = item["prefs"]
        cats = ", ".join(cat_labels.get(c, c) for c in p.get("focus_categories", []))
        kws = ", ".join(p.get("keywords", []) if isinstance(p.get("keywords"), list)
                        else [p.get("keywords", "")])
        count = p.get("article_count", 30)
        rows += f"""
        <div class="row">
          <span class="date">{item['created_at']}</span>
          <span class="cats">{cats or '—'}</span>
          <span class="kws">{kws or '—'}</span>
          <span class="count">{count}本</span>
        </div>"""

    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>設定履歴 | マーケットニュース</title>
  <style>
    body{{background:#0d1117;color:#e6edf3;font-family:-apple-system,sans-serif;
    font-size:16px;line-height:1.6;max-width:800px;margin:0 auto;padding:16px}}
    h1{{color:#58a6ff}}
    .header-row,.row{{display:grid;grid-template-columns:100px 1fr 1fr 60px;
    gap:8px;padding:10px 12px;border-bottom:1px solid #30363d;font-size:.88rem}}
    .header-row{{background:#161b22;border-radius:8px 8px 0 0;font-weight:700;color:#8b949e}}
    .row:hover{{background:#161b22}}
    .date{{color:#58a6ff}}
    .empty{{color:#8b949e;padding:20px;text-align:center}}
    footer{{text-align:center;color:#8b949e;font-size:.8rem;
    margin-top:40px;padding:20px 0;border-top:1px solid #30363d}}
    a{{color:#58a6ff;text-decoration:none}}
  </style>
</head>
<body>
  <h1>🕓 過去の設定履歴</h1>
  <p style="color:#8b949e;font-size:.9rem">「翌日重点設定」フォームで送信した設定の記録です。</p>
  <div class="header-row">
    <span>日付</span><span>重点カテゴリ</span><span>キーワード</span><span>本数</span>
  </div>
  {''.join(rows) if rows else '<div class="empty">まだ設定履歴がありません。</div>'}
  <footer>
    <a href="{base_url}/index.html">← トップへ</a><br>
    本サイトの情報はAIによる自動生成であり、投資推奨ではありません。
  </footer>
</body>
</html>"""
    (DOCS_DIR / "preferences-history.html").write_text(html, encoding="utf-8")
    print("  生成: docs/preferences-history.html")


def build_html(articles: list, date_str: str, daily_theme: str = "") -> None:
    """index.html と archive/{date}.html を生成。"""
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

    env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)), autoescape=True)
    tmpl = env.get_template("index.html.j2")

    featured = [a for a in articles if a.get("featured")]
    from collector import CATEGORY_LABELS
    categories_order = list(CATEGORY_LABELS.keys())
    categories: dict = {cat: [] for cat in categories_order}
    for art in articles:
        cat = art.get("category", "fx_macro")
        if cat not in categories:
            cat = "fx_macro"
        categories[cat].append(art)

    ctx = {
        "date_str": date_str,
        "generated_at": _jst_now().strftime("%Y/%m/%d %H:%M JST"),
        "featured": featured,
        "articles": articles,
        "categories": categories,
        "category_labels": CATEGORY_LABELS,
        "categories_order": categories_order,
        "daily_theme": daily_theme,
        "base_url": BASE_URL,
        "total_count": len(articles),
    }

    (DOCS_DIR / "index.html").write_text(tmpl.render(**ctx), encoding="utf-8")
    print(f"  生成: docs/index.html")

    archive_path = ARCHIVE_DIR / f"{date_str}.html"
    archive_path.write_text(tmpl.render(**ctx), encoding="utf-8")
    print(f"  生成: docs/archive/{date_str}.html")


def build_rss(articles: list, date_str: str) -> None:
    """RSS 2.0 フィードを docs/feed.xml に生成。"""
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    rss = ET.Element("rss", version="2.0")
    rss.set("xmlns:atom", "http://www.w3.org/2005/Atom")

    channel = ET.SubElement(rss, "channel")

    def _sub(parent, tag, text):
        el = ET.SubElement(parent, tag)
        el.text = text
        return el

    _sub(channel, "title", "プロ向けマーケットニュース")
    _sub(channel, "link", f"{BASE_URL}/index.html")
    _sub(channel, "description", "毎朝6:30 JST 更新。機関投資家向けの市況分析・シナリオ・トレードアイデア。")
    _sub(channel, "language", "ja")
    _sub(channel, "lastBuildDate", _rss_date(_jst_now()))
    atom_link = ET.SubElement(channel, "atom:link")
    atom_link.set("href", f"{BASE_URL}/feed.xml")
    atom_link.set("rel", "self")
    atom_link.set("type", "application/rss+xml")

    from collector import CATEGORY_LABELS
    for art in articles:
        item = ET.SubElement(channel, "item")
        category_tag = CATEGORY_LABELS.get(art.get("category", "fx_macro"), art.get("category", ""))
        headline = art.get("headline", art["title"])
        summary = art.get("summary", "")
        impact_emoji = art.get("impact_emoji", "➡️")
        impact_label = art.get("impact_label", "中立")
        importance = art.get("importance", 3)
        stars = "★" * importance + "☆" * (5 - importance)

        item_title = f"{impact_emoji}[{category_tag}] {headline}"
        _sub(item, "title", item_title)
        _sub(item, "link", art.get("link", ""))

        desc_parts = [f"{stars} 重要度{importance}/5"]
        if summary:
            desc_parts.append(summary)
        # シナリオがあれば追記
        sc = art.get("scenarios", {})
        if sc.get("base"):
            desc_parts.append(f"ベースシナリオ: {sc['base']}")
        desc_parts.append(f"市場影響: {impact_emoji} {impact_label}")
        desc_parts.append(f"出典: {art.get('source', '')}")
        _sub(item, "description", "\n".join(desc_parts))

        _sub(item, "pubDate", _rss_date(art["published"]))
        _sub(item, "guid", art.get("link", f"{BASE_URL}/{date_str}/{headline[:20]}"))
        _sub(item, "category", category_tag)

    tree = ET.ElementTree(rss)
    ET.indent(tree, space="  ")
    feed_path = DOCS_DIR / "feed.xml"
    with open(feed_path, "wb") as f:
        f.write(b'<?xml version="1.0" encoding="UTF-8"?>\n')
        tree.write(f, encoding="utf-8", xml_declaration=False)
    print(f"  生成: docs/feed.xml ({len(articles)} 件)")


def build(articles: list, daily_theme: str = "") -> None:
    date_str = _jst_now().strftime("%Y-%m-%d")
    print("=== サイト生成開始 ===")

    # 用語集更新・生成はスキップ(プロ向けリファイン後は不要)
    # data/glossary.json は保持するが更新しない

    build_html(articles, date_str, daily_theme=daily_theme)
    build_rss(articles, date_str)
    _build_preferences_history(BASE_URL)
    _copy_static()
    print("サイト生成完了\n")


def _copy_static() -> None:
    """manifest.json / sw.js が docs/ になければスキップ。"""
    for fname in ("manifest.json", "sw.js"):
        src = DOCS_DIR / fname
        if not src.exists():
            print(f"  [INFO] {fname} が存在しません。スキップ。")
