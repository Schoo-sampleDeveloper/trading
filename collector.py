"""
collector.py
過去24時間の金融ニュースをRSSから収集し、重要度スコアリングで上位30本を返す。
"""

import hashlib
import re
import time
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode

import feedparser
import httpx

# ──────────────────────────────────────────────
# RSSソース定義
# ──────────────────────────────────────────────

STATIC_FEEDS = [
    {
        "url": "https://feeds.bloomberg.com/markets/news.rss",
        "source": "Bloomberg Markets",
        "category": "マクロ",
        "weight": 10,
    },
    {
        "url": "https://feeds.content.dowjones.io/public/rss/mw_topstories",
        "source": "MarketWatch",
        "category": "米国株",
        "weight": 8,
    },
    {
        "url": "https://www.investing.com/rss/news.rss",
        "source": "Investing.com",
        "category": "マクロ",
        "weight": 7,
    },
]

# Google News RSS キーワード検索
GOOGLE_NEWS_KEYWORDS = [
    ("日経平均", "日本株"),
    ("ドル円 為替", "為替"),
    ("FOMC 金利", "マクロ"),
    ("日銀 金融政策", "日本株"),
    ("S&P500", "米国株"),
    ("Nikkei stock", "日本株"),
    ("先物 CME", "先物"),
    ("インデックス投資 ETF", "指数"),
    ("原油価格", "マクロ"),
    ("米国株 ナスダック", "米国株"),
]

# カテゴリキーワードマッピング
CATEGORY_KEYWORDS = {
    "日本株": ["日経", "nikkei", "topix", "東証", "日本株", "任天堂", "トヨタ", "ソフトバンク", "日銀"],
    "米国株": ["nasdaq", "dow jones", "s&p", "nyse", "apple", "nvidia", "fed", "ダウ", "ナスダック", "米国株", "wall street"],
    "指数": ["index", "etf", "指数", "インデックス", "vix", "russell"],
    "先物": ["futures", "先物", "cme", "option", "オプション", "derivative"],
    "為替": ["usd", "jpy", "eur", "ドル", "円", "forex", "為替", "currency"],
    "マクロ": ["gdp", "inflation", "cpi", "fed", "boj", "fomc", "金利", "インフレ", "景気", "macro", "economy", "経済"],
}

# 重要度スコアアップワード
HIGH_IMPACT_WORDS = [
    "緊急", "速報", "急落", "急騰", "崩壊", "危機", "crash", "surge", "plunge",
    "record", "historic", "intervention", "emergency", "halt", "circuit breaker",
    "利上げ", "利下げ", "サプライズ", "shock", "unexpected", "黒田", "植田", "powell",
]


def _google_news_url(keyword: str) -> str:
    params = urlencode({"q": keyword, "hl": "ja", "gl": "JP", "ceid": "JP:ja"})
    return f"https://news.google.com/rss/search?{params}"


def _parse_date(entry) -> datetime:
    """feedparserエントリから datetime(UTC) を取得。取得不可なら現在時刻。"""
    for attr in ("published_parsed", "updated_parsed"):
        val = getattr(entry, attr, None)
        if val:
            try:
                return datetime(*val[:6], tzinfo=timezone.utc)
            except Exception:
                pass
    return datetime.now(timezone.utc)


def _deduplicate(articles: list[dict]) -> list[dict]:
    """タイトルのハッシュで重複除去。"""
    seen = set()
    unique = []
    for art in articles:
        key = hashlib.md5(art["title"].lower().encode()).hexdigest()
        if key not in seen:
            seen.add(key)
            unique.append(art)
    return unique


def _detect_category(title: str, summary: str, default: str) -> str:
    text = (title + " " + summary).lower()
    scores = {cat: 0 for cat in CATEGORY_KEYWORDS}
    for cat, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw.lower() in text:
                scores[cat] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else default


def _importance_score(article: dict, source_weight: int) -> float:
    text = (article["title"] + " " + article.get("summary", "")).lower()
    score = float(source_weight)
    for word in HIGH_IMPACT_WORDS:
        if word.lower() in text:
            score += 3.0
    # 新しいほど高スコア
    age_hours = (datetime.now(timezone.utc) - article["published"]).total_seconds() / 3600
    score += max(0, (24 - age_hours) / 24 * 5)
    return score


def _fetch_feed(url: str, source: str, default_category: str, weight: int, cutoff: datetime) -> list[dict]:
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; FinanceNewsBot/1.0)",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
    }
    try:
        resp = httpx.get(url, headers=headers, timeout=15, follow_redirects=True)
        feed = feedparser.parse(resp.text)
    except Exception as e:
        print(f"  [WARN] {source}: fetch error - {e}")
        return []

    articles = []
    for entry in feed.entries:
        pub = _parse_date(entry)
        if pub < cutoff:
            continue
        title = entry.get("title", "").strip()
        if not title:
            continue
        summary = re.sub(r"<[^>]+>", "", entry.get("summary", "")).strip()
        link = entry.get("link", "")
        category = _detect_category(title, summary, default_category)
        articles.append({
            "title": title,
            "summary": summary[:500],
            "link": link,
            "source": source,
            "category": category,
            "published": pub,
            "_weight": weight,
        })
    return articles


def collect(top_n: int = 30) -> list[dict]:
    """
    過去24時間のニュースを収集してスコア順上位 top_n 件を返す。
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    all_articles: list[dict] = []

    print("=== ニュース収集開始 ===")

    # 静的フィード
    for feed_def in STATIC_FEEDS:
        print(f"  取得中: {feed_def['source']}")
        articles = _fetch_feed(
            feed_def["url"],
            feed_def["source"],
            feed_def["category"],
            feed_def["weight"],
            cutoff,
        )
        print(f"    → {len(articles)} 件")
        all_articles.extend(articles)
        time.sleep(0.5)

    # Google News RSS
    for keyword, category in GOOGLE_NEWS_KEYWORDS:
        url = _google_news_url(keyword)
        print(f"  取得中: Google News [{keyword}]")
        articles = _fetch_feed(url, f"Google News ({keyword})", category, 6, cutoff)
        print(f"    → {len(articles)} 件")
        all_articles.extend(articles)
        time.sleep(0.3)

    print(f"\n重複除去前: {len(all_articles)} 件")
    all_articles = _deduplicate(all_articles)
    print(f"重複除去後: {len(all_articles)} 件")

    # スコアリング & ソート
    for art in all_articles:
        art["score"] = _importance_score(art, art.pop("_weight"))

    all_articles.sort(key=lambda x: x["score"], reverse=True)
    result = all_articles[:top_n]
    print(f"上位 {len(result)} 件を選定\n")
    return result
