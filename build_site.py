"""
build_site.py
Jinja2 テンプレートから HTML / RSS を生成して docs/ に出力する。
glossary.html も生成する。preferences-history ページも生成する。
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


def _load_glossary() -> dict:
    """glossary.json か glossary_base.json を読み込む(新構造のみ受け付ける)。"""
    dynamic_path = DATA_DIR / "glossary.json"
    base_path = DATA_DIR / "glossary_base.json"

    for path in [dynamic_path, base_path]:
        if path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                first_val = next(iter(raw.values()), {})
                if isinstance(first_val, dict) and "definition_short" in first_val:
                    return raw
            except Exception:
                pass
    return {}


def build_glossary_html(base_url: str) -> None:
    """docs/glossary.html を生成する。"""
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    glossary = _load_glossary()

    if not glossary:
        print("  [INFO] 用語集データなし。glossary.html 生成スキップ。")
        return

    CATEGORY_ORDER = ["マクロ", "グローバル", "テクニカル", "個別銘柄", "制度", "その他"]
    CATEGORY_ICONS = {
        "マクロ": "🌍",
        "グローバル": "🏦",
        "テクニカル": "📈",
        "個別銘柄": "📋",
        "制度": "🏛️",
        "その他": "📚",
    }

    total = len(glossary)

    # カテゴリタブHTML
    cat_tabs_html = ""
    for cat in CATEGORY_ORDER:
        icon = CATEGORY_ICONS.get(cat, "📚")
        cat_tabs_html += f'<button class="cat-tab" data-cat="{cat}" onclick="setCat(this)">{icon} {cat}</button>\n'

    # 用語カードHTML
    cards_html = ""
    for term in sorted(glossary.keys()):
        data = glossary[term]
        cat = data.get("category", "その他")
        reading = data.get("reading", "")
        short = data.get("definition_short", "")
        full = data.get("definition_full", "")
        example = data.get("example", "")
        related = data.get("related", [])
        icon = CATEGORY_ICONS.get(cat, "📚")

        # 関連用語リンク
        related_html = ""
        if related and isinstance(related, list):
            links = " ".join(
                f'<a href="#" class="related-link" onclick="filterTerm(event,\'{r}\')">{r}</a>'
                for r in related if r
            )
            if links:
                related_html = f'<div class="gloss-related">関連: {links}</div>'

        # 展開可能コンテンツがあるかどうか
        has_detail = bool(full or example or related_html)
        expand_btn = '<button class="gloss-expand-btn" onclick="toggleGlossCard(this)">詳しく見る ▼</button>' if has_detail else ''
        detail_html = ""
        if has_detail:
            detail_html = '<div class="gloss-card-detail" style="display:none">'
            if full:
                detail_html += f'<div class="gloss-full">{full}</div>'
            if example:
                detail_html += f'<div class="gloss-example"><span class="ex-label">例:</span> {example}</div>'
            if related_html:
                detail_html += related_html
            detail_html += "</div>"

        # 五十音インデックス用の最初の文字
        first_char = reading[0] if reading else term[0]

        cards_html += f"""
    <div class="gloss-card" data-category="{cat}" data-term="{term}" data-reading="{reading}" data-first="{first_char}">
      <div class="gloss-card-header">
        <div class="gloss-card-top">
          <span class="gloss-cat-badge">{icon} {cat}</span>
        </div>
        <div class="gloss-term-name">{term}</div>
        {f'<div class="gloss-reading">{reading}</div>' if reading else ''}
        <div class="gloss-short">{short}</div>
      </div>
      {detail_html}
      {expand_btn}
    </div>"""

    # 五十音インデックス
    kana_rows = ["あいうえお", "かきくけこ", "さしすせそ", "たちつてと", "なにぬねの",
                 "はひふへほ", "まみむめも", "やゆよ", "らりるれろ", "わをん"]
    kana_html = '<div class="kana-index">'
    for row in kana_rows:
        for ch in row:
            kana_html += f'<button class="kana-btn" data-kana="{ch}" onclick="filterKana(this)">{ch}</button>'
    kana_html += '<button class="kana-btn" data-kana="A" onclick="filterKana(this)">A-Z</button>'
    kana_html += '<button class="kana-btn active" data-kana="all" onclick="filterKana(this)">全て</button>'
    kana_html += "</div>"

    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>用語集 | マーケットニュース</title>
  <style>
    :root {{
      --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --bg4: #2d333b;
      --border: #30363d; --text: #e6edf3; --text2: #8b949e;
      --accent: #58a6ff; --green: #3fb950; --red: #f85149;
      --yellow: #d29922;
    }}
    @media (prefers-color-scheme: light) {{
      :root {{
        --bg: #f6f8fa; --bg2: #ffffff; --bg3: #f0f2f5; --bg4: #e8ecf0;
        --border: #d0d7de; --text: #1f2328; --text2: #656d76;
        --accent: #0969da; --green: #1a7f37; --red: #cf222e; --yellow: #9a6700;
      }}
    }}
    body[data-theme="light"] {{
      --bg: #f6f8fa; --bg2: #ffffff; --bg3: #f0f2f5; --bg4: #e8ecf0;
      --border: #d0d7de; --text: #1f2328; --text2: #656d76;
      --accent: #0969da; --green: #1a7f37; --red: #cf222e; --yellow: #9a6700;
    }}
    body[data-theme="dark"] {{
      --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --bg4: #2d333b;
      --border: #30363d; --text: #e6edf3; --text2: #8b949e;
      --accent: #58a6ff; --green: #3fb950; --red: #f85149; --yellow: #d29922;
    }}
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Noto Sans JP', sans-serif;
      font-size: 16px; line-height: 1.7; }}
    a {{ color: var(--accent); text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .container {{ max-width: 960px; margin: 0 auto; padding: 16px; }}
    header {{ background: var(--bg2); border: 1px solid var(--border);
      border-radius: 12px; padding: 20px; margin-bottom: 16px; }}
    header h1 {{ font-size: 1.4rem; color: var(--accent); margin-bottom: 6px; }}
    .header-sub {{ font-size: .88rem; color: var(--text2); margin-bottom: 14px; }}
    .search-box {{ width: 100%; padding: 10px 14px; border-radius: 10px;
      background: var(--bg3); border: 1px solid var(--border);
      color: var(--text); font-size: 1rem; font-family: inherit; }}
    .search-box:focus {{ outline: none; border-color: var(--accent); }}
    .cat-tabs {{ display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }}
    .cat-tab {{ padding: 6px 14px; border-radius: 16px; border: 1px solid var(--border);
      background: var(--bg3); color: var(--text2); cursor: pointer; font-size: .83rem;
      font-weight: 600; min-height: 36px; transition: all .15s; }}
    .cat-tab.active {{ background: var(--accent); color: #fff; border-color: var(--accent); }}
    .kana-index {{ display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 16px; }}
    .kana-btn {{ padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border);
      background: var(--bg3); color: var(--text2); cursor: pointer; font-size: .78rem;
      min-width: 32px; transition: all .15s; }}
    .kana-btn.active {{ background: var(--accent); color: #fff; border-color: var(--accent); }}
    .stats {{ font-size: .85rem; color: var(--text2); margin-bottom: 12px; }}
    .cards-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px; margin-bottom: 40px; }}
    .gloss-card {{ background: var(--bg2); border: 1px solid var(--border);
      border-radius: 10px; padding: 14px; transition: border-color .2s; }}
    .gloss-card:hover {{ border-color: var(--accent); }}
    .gloss-card.hidden {{ display: none; }}
    .gloss-card-top {{ margin-bottom: 6px; }}
    .gloss-cat-badge {{ font-size: .72rem; font-weight: 600;
      background: var(--bg3); border: 1px solid var(--border);
      border-radius: 10px; padding: 2px 8px; color: var(--text2); }}
    .gloss-term-name {{ font-size: 1.05rem; font-weight: 700; color: var(--text);
      margin: 6px 0 2px; }}
    .gloss-reading {{ font-size: .78rem; color: var(--text2); margin-bottom: 4px; }}
    .gloss-short {{ font-size: .88rem; color: var(--text); line-height: 1.5; }}
    .gloss-card-detail {{ margin-top: 10px; padding-top: 10px;
      border-top: 1px solid var(--border); }}
    .gloss-full {{ font-size: .85rem; color: var(--text); line-height: 1.6; margin-bottom: 8px; }}
    .gloss-example {{ font-size: .82rem; color: var(--text2); line-height: 1.5;
      background: var(--bg3); border-radius: 6px; padding: 6px 10px; margin-bottom: 8px; }}
    .ex-label {{ font-weight: 700; color: var(--accent); }}
    .gloss-related {{ font-size: .78rem; color: var(--text2); }}
    .related-link {{ color: var(--accent); margin: 0 3px; }}
    .gloss-expand-btn {{ margin-top: 8px; font-size: .78rem; color: var(--accent);
      background: none; border: none; cursor: pointer; padding: 0; }}
    .gloss-expand-btn:hover {{ text-decoration: underline; }}
    .no-results {{ color: var(--text2); text-align: center; padding: 40px; font-size: .95rem; }}
    footer {{ text-align: center; color: var(--text2); font-size: .82rem;
      padding: 20px; border-top: 1px solid var(--border); margin-top: 20px; }}
    @media (max-width: 480px) {{ .cards-grid {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📚 金融用語集</h1>
      <p class="header-sub">投資歴1〜5年の中級者向け。よく使われる金融用語を解説します。({total}語収録)</p>
      <input type="search" id="search-box" class="search-box" placeholder="用語を検索... (例: VIX、移動平均)" oninput="filterTerms()">
      <div class="cat-tabs" id="cat-tabs">
        <button class="cat-tab active" data-cat="all" onclick="setCat(this)">📋 すべて</button>
        {cat_tabs_html}
      </div>
    </header>

    {kana_html}

    <div class="stats" id="stats">{total}語を表示中</div>

    <div class="cards-grid" id="cards-grid">
      {cards_html}
    </div>
    <div class="no-results" id="no-results" style="display:none">該当する用語が見つかりません。</div>
  </div>

  <footer>
    <a href="{base_url}/index.html">← マーケットニュースへ戻る</a><br>
    <span style="margin-top:6px;display:block">本サイトの情報はAIによる自動生成であり、投資推奨ではありません。</span>
  </footer>

  <script>
    let currentCat = 'all';
    let currentKana = 'all';
    let currentSearch = '';

    function applyFilter() {{
      const cards = document.querySelectorAll('.gloss-card');
      let visible = 0;
      cards.forEach(card => {{
        const cat = card.dataset.category;
        const term = card.dataset.term || '';
        const reading = card.dataset.reading || '';
        const first = card.dataset.first || '';
        const searchIn = (term + reading).toLowerCase();
        const matchCat = currentCat === 'all' || cat === currentCat;
        const matchKana = currentKana === 'all' || checkKana(first, currentKana);
        const matchSearch = !currentSearch || searchIn.includes(currentSearch.toLowerCase()) || term.includes(currentSearch);
        const show = matchCat && matchKana && matchSearch;
        card.classList.toggle('hidden', !show);
        if (show) visible++;
      }});
      document.getElementById('stats').textContent = visible + '語を表示中';
      document.getElementById('no-results').style.display = visible === 0 ? '' : 'none';
    }}

    function checkKana(first, kana) {{
      if (kana === 'A') {{
        return /^[A-Za-z]/.test(first);
      }}
      const row = {{
        'あ': 'あいうえお', 'か': 'かきくけこがぎぐげご', 'さ': 'さしすせそざじずぜぞ',
        'た': 'たちつてとだぢづでど', 'な': 'なにぬねの', 'は': 'はひふへほばびぶべぼぱぴぷぺぽ',
        'ま': 'まみむめも', 'や': 'やゆよ', 'ら': 'らりるれろ', 'わ': 'わをん'
      }};
      // Find which row kana belongs to
      for (const [rowStart, chars] of Object.entries(row)) {{
        if (chars.includes(kana)) {{
          return chars.includes(first);
        }}
      }}
      return first === kana;
    }}

    function setCat(btn) {{
      currentCat = btn.dataset.cat;
      document.querySelectorAll('.cat-tab').forEach(b => b.classList.toggle('active', b.dataset.cat === currentCat));
      applyFilter();
    }}

    function filterKana(btn) {{
      currentKana = btn.dataset.kana;
      document.querySelectorAll('.kana-btn').forEach(b => b.classList.toggle('active', b.dataset.kana === currentKana));
      applyFilter();
    }}

    function filterTerms() {{
      currentSearch = document.getElementById('search-box').value;
      applyFilter();
    }}

    function filterTerm(e, term) {{
      e.preventDefault();
      document.getElementById('search-box').value = term;
      currentSearch = term;
      currentCat = 'all';
      currentKana = 'all';
      document.querySelectorAll('.cat-tab').forEach(b => b.classList.toggle('active', b.dataset.cat === 'all'));
      document.querySelectorAll('.kana-btn').forEach(b => b.classList.toggle('active', b.dataset.kana === 'all'));
      applyFilter();
    }}

    function toggleGlossCard(btn) {{
      const detail = btn.previousElementSibling;
      if (!detail || !detail.classList.contains('gloss-card-detail')) return;
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : '';
      btn.textContent = open ? '詳しく見る ▼' : '閉じる ▲';
    }}
  </script>
</body>
</html>"""

    (DOCS_DIR / "glossary.html").write_text(html, encoding="utf-8")
    print("  生成: docs/glossary.html")


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
    # tojson フィルタを追加(JS埋め込み用)
    env.filters['tojson'] = lambda v: json.dumps(v, ensure_ascii=False)

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

    # 用語集データを読み込みJS埋め込み用に準備
    glossary = _load_glossary()
    glossary_terms = {term: data.get("definition_short", "") for term, data in glossary.items()}

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
        "glossary_terms_json": json.dumps(glossary_terms, ensure_ascii=False),
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

    _sub(channel, "title", "デイリーマーケットニュース")
    _sub(channel, "link", f"{BASE_URL}/index.html")
    _sub(channel, "description", "毎朝6:30 JST 更新。個人投資家向けの市況分析・シナリオ・投資視点。")
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
        points = art.get("points", [])

        item_title = f"{impact_emoji}[{category_tag}] {headline}"
        _sub(item, "title", item_title)
        _sub(item, "link", art.get("link", ""))

        desc_parts = [f"{stars} 重要度{importance}/5"]
        if points:
            desc_parts.extend([f"・{p}" for p in points[:3]])
        elif summary:
            desc_parts.append(summary)
        # シナリオがあれば追記
        sc = art.get("scenarios", {})
        sc_base = sc.get("base", {}) if isinstance(sc.get("base"), dict) else {}
        if sc_base.get("text"):
            desc_parts.append(f"ベースシナリオ: {sc_base['text']}")
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

    build_html(articles, date_str, daily_theme=daily_theme)
    build_rss(articles, date_str)
    build_glossary_html(BASE_URL)
    _build_preferences_history(BASE_URL)
    _copy_static()
    print("サイト生成完了\n")


def _copy_static() -> None:
    """manifest.json / sw.js が docs/ になければスキップ。"""
    for fname in ("manifest.json", "sw.js"):
        src = DOCS_DIR / fname
        if not src.exists():
            print(f"  [INFO] {fname} が存在しません。スキップ。")
