"""
collector.py
過去24時間の金融ニュースをRSSから収集し、重要度スコアリングで上位N本を返す。
preferences Issueがあればカテゴリブーストとキーワードブーストを適用する。
"""

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone, timedelta
from typing import Optional
from urllib.parse import urlencode

import feedparser
import httpx
from dotenv import load_dotenv

load_dotenv()

# ──────────────────────────────────────────────
# RSSソース定義
# ──────────────────────────────────────────────

STATIC_FEEDS = [
    {
        "url": "https://feeds.bloomberg.com/markets/news.rss",
        "source": "Bloomberg Markets",
        "category": "fx_macro",
        "weight": 10,
    },
    {
        "url": "https://feeds.content.dowjones.io/public/rss/mw_topstories",
        "source": "MarketWatch",
        "category": "foreign_stock",
        "weight": 8,
    },
    {
        "url": "https://www.investing.com/rss/news.rss",
        "source": "Investing.com",
        "category": "fx_macro",
        "weight": 7,
    },
]

# Google News RSS キーワード検索 → (keyword, default_category)
GOOGLE_NEWS_KEYWORDS = [
    ("日経平均", "jp_index"),
    ("ドル円 為替", "fx_macro"),
    ("FOMC 金利", "fx_macro"),
    ("日銀 金融政策", "fx_macro"),
    ("S&P500", "foreign_index"),
    ("Nikkei stock", "jp_index"),
    ("先物 CME", "futures"),
    ("インデックス投資 ETF", "foreign_index"),
    ("原油価格", "fx_macro"),
    ("米国株 ナスダック", "foreign_index"),
]

# ──────────────────────────────────────────────
# 6カテゴリのキーワードマッピング
# ──────────────────────────────────────────────
# jp_stock     : 日本個別株(企業名・4桁銘柄コード)
# jp_index     : 日本インデックス(日経/TOPIX/グロース等)
# foreign_stock: 外国個別株(Apple/Tesla等)
# foreign_index: 外国インデックス(S&P500/NASDAQ/DAX等)
# futures      : 株価指数先物・商品先物・金利先物
# fx_macro     : 為替・金利・中央銀行・マクロ・コモディティ

CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "jp_stock": [
        "トヨタ", "ソフトバンク", "任天堂", "ソニー", "三菱", "三井", "住友",
        "ホンダ", "キーエンス", "ファナック", "東京エレクトロン", "信越化学",
        "リクルート", "オリエンタルランド", "伊藤忠", "丸紅", "神戸製鋼",
        "7203", "9984", "6758", "4063", "8316", "6501", "6902",
        "東証プライム 個別", "上場企業 決算", "japan individual stock",
        "japanese company earnings",
    ],
    "jp_index": [
        "日経平均", "nikkei 225", "topix", "jpx400", "マザーズ", "グロース市場",
        "東証指数", "日経vi", "jasdaq", "東証reit", "nikkei index",
        "japan stock index", "日本株指数", "東証全体",
    ],
    "foreign_stock": [
        "apple", "nvidia", "tesla", "microsoft", "amazon", "meta", "alphabet",
        "google", "netflix", "berkshire", "jpmorgan", "goldman sachs",
        "tsmc", "samsung", "alibaba", "tencent", "asml", "lvmh",
        "欧州株 個別", "アジア株 個別", "us stock earnings", "individual stock",
    ],
    "foreign_index": [
        "s&p500", "s&p 500", "nasdaq", "ナスダック", "dow jones", "ダウ平均",
        "russell 2000", "dax", "ftse", "cac 40", "euro stoxx",
        "hang seng", "上海総合", "shanghai composite", "kospi",
        "vix", "fear index", "global index", "world market index",
        "米国株指数", "欧州株指数",
    ],
    "futures": [
        "先物", "futures", "cme", "option", "オプション", "derivative",
        "日経先物", "nikkei futures", "corn futures", "oil futures",
        "gold futures", "bond futures", "原油先物", "金先物", "国債先物",
        "大阪取引所", "ose", "限月", "ロールオーバー",
    ],
    "fx_macro": [
        "usd", "jpy", "eur", "gbp", "cny", "ドル", "円", "ユーロ",
        "forex", "為替", "currency", "ドル円", "ユーロドル",
        "fed", "fomc", "boj", "日銀", "ecb", "rba",
        "金利", "利上げ", "利下げ", "利下げ観測",
        "gdp", "inflation", "cpi", "ppi", "インフレ",
        "景気", "macro", "economy", "経済",
        "原油", "gold", "金価格", "commodity", "コモディティ",
        "powell", "植田", "黒田", "lagarde",
    ],
}

# カテゴリの優先順位(同点の場合)
CATEGORY_PRIORITY = ["jp_stock", "foreign_stock", "jp_index", "foreign_index", "futures", "fx_macro"]

# 重要度スコアアップワード
HIGH_IMPACT_WORDS = [
    "緊急", "速報", "急落", "急騰", "崩壊", "危機", "crash", "surge", "plunge",
    "record", "historic", "intervention", "emergency", "halt", "circuit breaker",
    "利上げ", "利下げ", "サプライズ", "shock", "unexpected", "黒田", "植田", "powell",
    "リセッション", "recession", "デフォルト", "default", "破綻", "暴落",
]

# カテゴリの表示名
CATEGORY_LABELS = {
    "jp_stock": "🇯🇵 日本株式",
    "jp_index": "📊 日本インデックス",
    "foreign_stock": "🇺🇸 外国株式",
    "foreign_index": "📈 外国インデックス",
    "futures": "🎯 先物",
    "fx_macro": "💱 為替・マクロ",
}


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
    """6カテゴリのキーワードマッチング。最もスコアが高いカテゴリを返す。"""
    text = (title + " " + summary).lower()
    scores: dict[str, int] = {cat: 0 for cat in CATEGORY_KEYWORDS}
    for cat, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw.lower() in text:
                scores[cat] += 1
    best_score = max(scores.values())
    if best_score == 0:
        # defaultが新カテゴリ体系内にあればそれを使う
        return default if default in CATEGORY_KEYWORDS else "fx_macro"
    # 同スコアの場合は優先順位で決定
    for cat in CATEGORY_PRIORITY:
        if scores[cat] == best_score:
            return cat
    return max(scores, key=scores.get)


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


def _load_preferences() -> Optional[dict]:
    """
    GitHub APIから preferences ラベル付き Open Issue を1件取得してパース。
    GITHUB_TOKEN が未設定または取得失敗時は None を返す。
    """
    token = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")  # "owner/repo" 形式
    if not token or not repo:
        print("  [INFO] GITHUB_TOKEN/GITHUB_REPOSITORY未設定。preferencesスキップ。")
        return None

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    url = f"https://api.github.com/repos/{repo}/issues?labels=preferences&state=open&per_page=1&sort=created&direction=desc"
    try:
        resp = httpx.get(url, headers=headers, timeout=15)
        issues = resp.json()
        if not issues:
            print("  [INFO] preferences Issue なし。デフォルト設定で動作。")
            return None
        issue = issues[0]
        prefs = json.loads(issue["body"])
        print(f"  [INFO] preferences Issue #{issue['number']} を取得: {prefs}")
        # Issueをclose
        close_url = f"https://api.github.com/repos/{repo}/issues/{issue['number']}"
        httpx.patch(close_url, headers=headers, json={"state": "closed"}, timeout=15)
        print(f"  [INFO] Issue #{issue['number']} をcloseしました。")
        return prefs
    except Exception as e:
        print(f"  [WARN] preferences取得失敗: {e}")
        return None


def collect(top_n: int = 30) -> list[dict]:
    """
    過去24時間のニュースを収集してスコア順上位 top_n 件を返す。
    preferences Issueがあればブーストを適用し、article_countを上書きする。
    """
    # --- preferences 読み込み ---
    prefs = _load_preferences()
    focus_categories: list[str] = []
    focus_keywords: list[str] = []
    if prefs:
        focus_categories = prefs.get("focus_categories", [])
        kw_raw = prefs.get("keywords", [])
        # カンマ区切り文字列にも対応
        if isinstance(kw_raw, str):
            focus_keywords = [k.strip() for k in kw_raw.split(",") if k.strip()]
        else:
            focus_keywords = [k.strip() for k in kw_raw if k.strip()]
        pref_count = prefs.get("article_count", top_n)
        if isinstance(pref_count, int) and pref_count in (20, 30, 40):
            top_n = pref_count

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

    # スコアリング & preferences ブースト
    for art in all_articles:
        base = _importance_score(art, art.pop("_weight"))
        # カテゴリブースト (×1.5 = +50%)
        if focus_categories and art["category"] in focus_categories:
            base *= 1.5
        # キーワードブースト (+5)
        if focus_keywords:
            text = (art["title"] + " " + art.get("summary", "")).lower()
            for kw in focus_keywords:
                if kw.lower() in text:
                    base += 5.0
                    break
        art["score"] = base

    all_articles.sort(key=lambda x: x["score"], reverse=True)
    result = all_articles[:top_n]
    print(f"上位 {len(result)} 件を選定\n")
    return result
