"""
build_site.py
Jinja2 テンプレートから HTML / RSS を生成して docs/ に出力する。
用語集(glossary.json)の永続化、preferences-history ページも生成する。
"""

import json
import os
import unicodedata
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

GLOSSARY_FILE = DATA_DIR / "glossary.json"


def _jst_now() -> datetime:
    return datetime.now(JST)


def _rss_date(dt: datetime) -> str:
    return formatdate(dt.timestamp(), usegmt=True)


def _kana_key(text: str) -> str:
    """五十音順ソート用キー。ひらがな→カタカナ統一、英数字はZZZ...プレフィックス。"""
    t = text.strip()
    # ひらがな→カタカナ変換
    result = ""
    for ch in t:
        code = ord(ch)
        if 0x3041 <= code <= 0x3096:
            result += chr(code + 0x60)
        else:
            result += ch
    # 英数字始まりは後ろへ
    if result and (result[0].isascii()):
        return "zzz" + result.lower()
    return unicodedata.normalize("NFKC", result)


def _update_glossary(articles: list[dict], date_str: str) -> dict:
    """
    記事の terms を glossary.json に追記・更新する。
    {term: {definition, example, articles: [{date, headline, link}]}}
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    glossary: dict = {}
    if GLOSSARY_FILE.exists():
        try:
            glossary = json.loads(GLOSSARY_FILE.read_text(encoding="utf-8"))
        except Exception:
            glossary = {}

    for art in articles:
        for term_obj in art.get("terms", []):
            term = term_obj.get("term", "").strip()
            if not term:
                continue
            entry = glossary.setdefault(term, {
                "definition": term_obj.get("definition", ""),
                "example": term_obj.get("example", ""),
                "articles": [],
            })
            # 定義を最新で更新
            entry["definition"] = term_obj.get("definition", entry["definition"])
            entry["example"] = term_obj.get("example", entry["example"])
            # 記事リンクを追記(重複チェック)
            art_ref = {
                "date": date_str,
                "headline": art.get("headline", art.get("title", ""))[:40],
                "link": art.get("link", ""),
            }
            existing_links = {a["link"] for a in entry["articles"]}
            if art_ref["link"] not in existing_links:
                entry["articles"].append(art_ref)
                # 最新20件に制限
                entry["articles"] = entry["articles"][-20:]

    GLOSSARY_FILE.write_text(json.dumps(glossary, ensure_ascii=False, indent=2), encoding="utf-8")
    return glossary


def _build_glossary_html(glossary: dict) -> None:
    """docs/glossary.html を生成。"""
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    # 五十音 / 英数字 に分類してソート
    jp_terms = {}
    en_terms = {}
    for term, data in glossary.items():
        if term and term[0].isascii():
            en_terms[term] = data
        else:
            jp_terms[term] = data

    jp_sorted = sorted(jp_terms.items(), key=lambda x: _kana_key(x[0]))
    en_sorted = sorted(en_terms.items(), key=lambda x: x[0].lower())

    env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)), autoescape=True)
    try:
        tmpl = env.get_template("glossary.html.j2")
    except Exception:
        # テンプレートが無ければ簡易HTML生成
        _write_glossary_html_simple(jp_sorted, en_sorted)
        return

    ctx = {
        "jp_terms": jp_sorted,
        "en_terms": en_sorted,
        "generated_at": _jst_now().strftime("%Y/%m/%d %H:%M JST"),
        "base_url": BASE_URL,
    }
    (DOCS_DIR / "glossary.html").write_text(tmpl.render(**ctx), encoding="utf-8")
    print("  生成: docs/glossary.html")


def _write_glossary_html_simple(jp_sorted: list, en_sorted: list) -> None:
    """テンプレートなしの簡易用語集HTML。"""
    lines = [
        '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1.0">',
        '<title>用語集 | デイリー金融ニュース</title>',
        '<style>',
        'body{background:#0d1117;color:#e6edf3;font-family:-apple-system,sans-serif;',
        'font-size:16px;line-height:1.6;max-width:800px;margin:0 auto;padding:16px}',
        'h1{color:#58a6ff}h2{color:#8b949e;border-bottom:1px solid #30363d;padding-bottom:6px}',
        '.term{background:#161b22;border:1px solid #30363d;border-radius:10px;',
        'padding:14px;margin-bottom:12px}',
        '.term-name{font-size:1.1rem;font-weight:700;color:#58a6ff}',
        '.definition{margin:6px 0;font-size:.9rem}',
        '.example{font-size:.85rem;color:#8b949e}',
        '.art-link{font-size:.8rem;color:#58a6ff;text-decoration:none}',
        'a{color:#58a6ff}',
        '</style></head><body>',
        '<h1>📚 用語集</h1>',
        '<p style="color:#8b949e;font-size:.85rem">AIが記事から自動抽出した用語集です。</p>',
    ]
    if jp_sorted:
        lines.append('<h2>日本語</h2>')
        for term, data in jp_sorted:
            lines.append(f'<div class="term" id="term-{term}">')
            lines.append(f'<div class="term-name">{term}</div>')
            lines.append(f'<div class="definition">{data.get("definition","")}</div>')
            if data.get("example"):
                lines.append(f'<div class="example">例: {data["example"]}</div>')
            for art in data.get("articles", [])[-3:]:
                lines.append(f'<a class="art-link" href="{art["link"]}" target="_blank" rel="noopener">→ {art["headline"]} ({art["date"]})</a><br>')
            lines.append('</div>')
    if en_sorted:
        lines.append('<h2>English / 英数字</h2>')
        for term, data in en_sorted:
            lines.append(f'<div class="term" id="term-{term}">')
            lines.append(f'<div class="term-name">{term}</div>')
            lines.append(f'<div class="definition">{data.get("definition","")}</div>')
            if data.get("example"):
                lines.append(f'<div class="example">例: {data["example"]}</div>')
            for art in data.get("articles", [])[-3:]:
                lines.append(f'<a class="art-link" href="{art["link"]}" target="_blank" rel="noopener">→ {art["headline"]} ({art["date"]})</a><br>')
            lines.append('</div>')
    lines.append('<footer style="text-align:center;color:#8b949e;font-size:.8rem;margin-top:40px;padding:20px 0;border-top:1px solid #30363d">')
    lines.append(f'<a href="{BASE_URL}/index.html" style="color:#58a6ff">← トップへ</a><br>')
    lines.append('本サイトの情報はAIによる自動生成であり、投資推奨ではありません。</footer>')
    lines.append('</body></html>')
    (DOCS_DIR / "glossary.html").write_text("\n".join(lines), encoding="utf-8")
    print("  生成: docs/glossary.html (簡易版)")


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
        url = f"https://api.github.com/repos/{repo}/issues?labels=preferences&state=closed&per_page=30&sort=created&direction=desc"
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
  <title>設定履歴 | デイリー金融ニュース</title>
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
  <p style="color:#8b949e;font-size:.9rem">「明日の重点設定」フォームで送信した設定の記録です。</p>
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


def build_html(articles: list[dict], date_str: str, daily_theme: str = "") -> None:
    """index.html と archive/{date}.html を生成。"""
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

    env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)), autoescape=True)
    tmpl = env.get_template("index.html.j2")

    featured = [a for a in articles if a.get("featured")]
    # カテゴリ別グループ化
    from collector import CATEGORY_LABELS
    categories_order = list(CATEGORY_LABELS.keys())
    categories: dict[str, list[dict]] = {cat: [] for cat in categories_order}
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


def build_rss(articles: list[dict], date_str: str) -> None:
    """RSS 2.0 フィードを docs/feed.xml に生成。"""
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    rss = ET.Element("rss", version="2.0")
    rss.set("xmlns:atom", "http://www.w3.org/2005/Atom")

    channel = ET.SubElement(rss, "channel")

    def _sub(parent, tag, text):
        el = ET.SubElement(parent, tag)
        el.text = text
        return el

    _sub(channel, "title", "デイリー金融ニュース")
    _sub(channel, "link", f"{BASE_URL}/index.html")
    _sub(channel, "description", "毎朝6:30 JST 更新。日本株・米国株・為替・マクロ経済の重要ニュースをAIが要約。")
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
        what_happened = art.get("what_happened", "")
        why_important = art.get("why_important", "")
        impact_emoji = art.get("impact_emoji", "➡️")
        impact_label = art.get("impact_label", "中立")
        importance = art.get("importance", 3)
        stars = "★" * importance + "☆" * (5 - importance)

        item_title = f"{impact_emoji}[{category_tag}] {headline}"
        _sub(item, "title", item_title)
        _sub(item, "link", art.get("link", ""))

        desc_parts = [f"{stars} 重要度{importance}/5"]
        if what_happened:
            desc_parts.append(what_happened)
        if why_important:
            desc_parts.append(f"📌 {why_important}")
        desc_parts.append(f"市場影響: {impact_emoji} {impact_label}")
        desc_parts.append(f"出典: {art.get('source', '')}")
        desc_parts.append("※AIによる解釈であり投資推奨ではありません")
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


def build(articles: list[dict], daily_theme: str = "") -> None:
    date_str = _jst_now().strftime("%Y-%m-%d")
    print("=== サイト生成開始 ===")

    # 用語集更新
    glossary = _update_glossary(articles, date_str)
    print(f"  用語集更新: {len(glossary)} 語")

    build_html(articles, date_str, daily_theme=daily_theme)
    build_rss(articles, date_str)
    _build_glossary_html(glossary)
    _build_preferences_history(BASE_URL)
    _copy_static()
    print("サイト生成完了\n")


def _copy_static() -> None:
    """manifest.json / sw.js が docs/ になければスキップ。"""
    for fname in ("manifest.json", "sw.js"):
        src = DOCS_DIR / fname
        if not src.exists():
            print(f"  [INFO] {fname} が存在しません。スキップ。")
