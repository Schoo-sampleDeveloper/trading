"""
build_site.py
Jinja2 テンプレートから HTML / RSS を生成して docs/ に出力する。
"""

import os
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import formatdate
from pathlib import Path

from jinja2 import Environment, FileSystemLoader
from dotenv import load_dotenv

load_dotenv()

DOCS_DIR = Path(__file__).parent / "docs"
ARCHIVE_DIR = DOCS_DIR / "archive"
TEMPLATES_DIR = Path(__file__).parent / "templates"

JST = timezone(timedelta(hours=9))
BASE_URL = os.environ.get("SITE_BASE_URL", "https://example.github.io/trading").rstrip("/")


def _jst_now() -> datetime:
    return datetime.now(JST)


def _rss_date(dt: datetime) -> str:
    return formatdate(dt.timestamp(), usegmt=True)


def build_html(articles: list[dict], date_str: str) -> None:
    """index.html と archive/{date}.html を生成。"""
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

    env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)), autoescape=True)
    tmpl = env.get_template("index.html.j2")

    featured = [a for a in articles if a.get("featured")]
    all_articles = articles

    ctx = {
        "date_str": date_str,
        "generated_at": _jst_now().strftime("%Y/%m/%d %H:%M JST"),
        "featured": featured,
        "articles": all_articles,
        "base_url": BASE_URL,
    }

    # index.html (最新版)
    (DOCS_DIR / "index.html").write_text(tmpl.render(**ctx), encoding="utf-8")
    print(f"  生成: docs/index.html")

    # archive/YYYY-MM-DD.html
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

    for art in articles:
        item = ET.SubElement(channel, "item")
        category_tag = art.get("category", "")
        headline = art.get("headline", art["title"])
        summary_lines = art.get("summary_lines", [])
        explanation = art.get("explanation", "")
        impact_emoji = art.get("impact_emoji", "➡️")
        impact_label = art.get("impact_label", "中立")

        item_title = f"{impact_emoji}[{category_tag}] {headline}"
        _sub(item, "title", item_title)
        _sub(item, "link", art.get("link", ""))

        desc_parts = ["<br>".join(summary_lines)]
        if explanation:
            desc_parts.append(f"📌 {explanation}")
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


def build(articles: list[dict]) -> None:
    date_str = _jst_now().strftime("%Y-%m-%d")
    print("=== サイト生成開始 ===")
    build_html(articles, date_str)
    build_rss(articles, date_str)
    _copy_static()
    print("サイト生成完了\n")


def _copy_static() -> None:
    """manifest.json / sw.js が docs/ になければコピー。"""
    for fname in ("manifest.json", "sw.js"):
        src = DOCS_DIR / fname
        if not src.exists():
            print(f"  [INFO] {fname} が存在しません。スキップ。")
