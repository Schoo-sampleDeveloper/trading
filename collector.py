"""
collector.py
過去24時間の金融ニュースをRSSから収集し、重要度スコアリングで上位N本を返す。
意味的重複排除・ソース多様性制御・preferences Issueブーストを適用する。
"""

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
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


# ──────────────────────────────────────────────
# 重複検出ヘルパー (reモジュールのみ使用)
# ──────────────────────────────────────────────

def _normalize_title(title: str) -> str:
    """タイトルからノイズを除去して正規化。"""
    t = title.lower()
    # 【】[]()などのノイズタグを除去
    t = re.sub(r'【[^】]*】|\[[^\]]*\]|\([^)]*\)', '', t)
    # 速報・更新・Breakingなどのノイズワードを除去
    t = re.sub(r'\b(速報|更新|breaking|update|breaking news)\b', '', t, flags=re.IGNORECASE)
    # 記号・引用符を除去
    t = re.sub(r'[「」『』"\'""''《》〈〉、。・]', ' ', t)
    # 連続空白を単一化
    t = re.sub(r'\s+', ' ', t).strip()
    return t


def _tokenize(title: str) -> set:
    """簡易トークナイザ: 英単語と日本語ワードを抽出。"""
    normalized = _normalize_title(title)
    tokens = set()
    # 英単語(3文字以上)
    for word in re.findall(r'[a-z]{3,}', normalized):
        tokens.add(word)
    # 日本語の連続したひらがな/カタカナ/漢字(2文字以上)
    for word in re.findall(r'[\u3040-\u9fff]{2,}', normalized):
        tokens.add(word)
    # 数値(整数・小数・%・単位付き)
    for num in re.findall(r'\d+\.?\d*[%円ドル兆億万bpbps]?', normalized):
        if len(num) >= 2:
            tokens.add(num)
    return tokens


def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union > 0 else 0.0


def _extract_entities(title: str) -> set:
    """キーエンティティを抽出: 企業名・指数名・金額・%数値・人名。"""
    entities = set()
    tl = title.lower()
    # 数値+単位パターン
    for m in re.findall(r'\d+\.?\d*\s*[%円ドル兆億万bpbps]+', tl):
        entities.add(m.replace(' ', ''))
    # 大文字英字の固有名詞(2文字以上)
    for m in re.findall(r'[A-Z][A-Za-z&]{1,}', title):
        entities.add(m.lower())
    # 日本語固有名詞候補(カタカナ4文字以上)
    for m in re.findall(r'[\u30A0-\u30FF]{4,}', title):
        entities.add(m)
    # 主要指数・通貨ペアの固有名詞
    INDEX_NAMES = [
        '日経平均', 'topix', 's&p500', 's&p 500', 'nasdaq', 'ナスダック',
        'ダウ', 'vix', 'ドル円', 'ユーロドル', '原油', 'bitcoin',
    ]
    for idx in INDEX_NAMES:
        if idx in tl:
            entities.add(idx)
    return entities


def _is_semantic_duplicate(art1: dict, art2: dict,
                            jaccard_threshold: float = 0.5,
                            entity_threshold: int = 3) -> bool:
    """Jaccard係数またはキーエンティティ重複で意味的重複を検出。"""
    t1 = _tokenize(art1['title'])
    t2 = _tokenize(art2['title'])

    if _jaccard(t1, t2) >= jaccard_threshold:
        return True

    e1 = _extract_entities(art1['title'])
    e2 = _extract_entities(art2['title'])
    if len(e1 & e2) >= entity_threshold:
        return True

    return False


def _deduplicate_semantic(articles: list) -> tuple:
    """
    ステップ1: ハッシュで完全重複除去
    ステップ2: 6時間以内の意味的重複を除去(より詳しい記事を残す)
    返り値: (unique_articles, removed_articles)
    """
    # ハッシュ重複除去
    seen_hashes: set = set()
    hash_deduped = []
    removed = []
    for art in articles:
        key = hashlib.md5(art["title"].lower().encode()).hexdigest()
        if key not in seen_hashes:
            seen_hashes.add(key)
            hash_deduped.append(art)
        else:
            removed.append({**art, "_dup_reason": "exact_title_hash"})

    # 意味的重複除去
    unique = []
    for art in hash_deduped:
        is_dup = False
        for idx, existing in enumerate(unique):
            # 6時間以内の記事のみ比較
            time_diff = abs(
                (art['published'] - existing['published']).total_seconds()
            ) / 3600
            if time_diff > 6:
                continue
            if _is_semantic_duplicate(art, existing):
                # より詳しい記事(summaryが長い)を保持
                if len(art.get('summary', '')) > len(existing.get('summary', '')):
                    removed.append({
                        **existing,
                        "_dup_reason": f"semantic_replaced_by: {art['title'][:50]}"
                    })
                    unique[idx] = art
                else:
                    removed.append({
                        **art,
                        "_dup_reason": f"semantic_dup_of: {existing['title'][:50]}"
                    })
                is_dup = True
                break
        if not is_dup:
            unique.append(art)

    return unique, removed


def _apply_source_diversity(articles: list,
                             max_consecutive: int = 3,
                             max_per_source: int = 5) -> list:
    """
    同一ソースの連続を max_consecutive 本に制限し、
    ソース全体の上限を max_per_source に制限する。
    制限超過分は後ろに回して再挿入する。
    """
    result = []
    deferred = []
    source_counts: dict = {}
    consecutive_count = 0
    last_source = None

    for art in articles:
        src = art.get('source', '')
        count = source_counts.get(src, 0)

        if count >= max_per_source:
            deferred.append(art)
            continue

        if src == last_source:
            consecutive_count += 1
            if consecutive_count >= max_consecutive:
                deferred.append(art)
                continue
        else:
            consecutive_count = 1

        result.append(art)
        source_counts[src] = count + 1
        last_source = src

    # deferred を後方に追加(ソース上限が残っている場合のみ)
    for art in deferred:
        src = art.get('source', '')
        if source_counts.get(src, 0) < max_per_source:
            result.append(art)
            source_counts[src] = source_counts.get(src, 0) + 1

    return result


def _write_duplicate_log(removed: list, date_str: str) -> None:
    """重複除外記事のデバッグログを docs/debug/ にHTML出力。"""
    docs_debug = Path(__file__).parent / "docs" / "debug"
    docs_debug.mkdir(parents=True, exist_ok=True)

    rows = ""
    for art in removed:
        reason = art.get('_dup_reason', '')
        pub = art.get('published', '')
        if hasattr(pub, 'strftime'):
            pub = pub.strftime('%m/%d %H:%M UTC')
        title = art.get('title', '')[:80]
        source = art.get('source', '')
        rows += (
            f"<tr><td>{source}</td>"
            f"<td>{title}</td>"
            f"<td>{pub}</td>"
            f"<td style='color:#8b949e;font-size:.8rem'>{reason}</td></tr>\n"
        )

    html = f"""<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<title>重複ログ {date_str}</title>
<style>
body{{background:#0d1117;color:#e6edf3;font-family:monospace;font-size:13px;padding:16px}}
h2{{color:#58a6ff}}
table{{width:100%;border-collapse:collapse}}
th,td{{text-align:left;padding:6px 8px;border-bottom:1px solid #30363d;vertical-align:top}}
th{{color:#58a6ff;background:#161b22;position:sticky;top:0}}
tr:hover{{background:#161b22}}
</style></head><body>
<h2>重複除外ログ: {date_str} ({len(removed)} 件)</h2>
<table>
<tr><th>ソース</th><th>タイトル</th><th>公開日時</th><th>除外理由</th></tr>
{rows}
</table></body></html>"""

    log_path = docs_debug / f"duplicates-{date_str}.html"
    log_path.write_text(html, encoding="utf-8")
    print(f"  重複ログ: docs/debug/duplicates-{date_str}.html ({len(removed)} 件除外)")


# ──────────────────────────────────────────────
# RSS収集ヘルパー
# ──────────────────────────────────────────────

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
        return default if default in CATEGORY_KEYWORDS else "fx_macro"
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
    age_hours = (datetime.now(timezone.utc) - article["published"]).total_seconds() / 3600
    score += max(0, (24 - age_hours) / 24 * 5)
    return score


def _fetch_feed(url: str, source: str, default_category: str, weight: int, cutoff: datetime) -> list:
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
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not token or not repo:
        print("  [INFO] GITHUB_TOKEN/GITHUB_REPOSITORY未設定。preferencesスキップ。")
        return None

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    url = (
        f"https://api.github.com/repos/{repo}/issues"
        f"?labels=preferences&state=open&per_page=1&sort=created&direction=desc"
    )
    try:
        resp = httpx.get(url, headers=headers, timeout=15)
        issues = resp.json()
        if not issues:
            print("  [INFO] preferences Issue なし。デフォルト設定で動作。")
            return None
        issue = issues[0]
        prefs = json.loads(issue["body"])
        print(f"  [INFO] preferences Issue #{issue['number']} を取得: {prefs}")
        close_url = f"https://api.github.com/repos/{repo}/issues/{issue['number']}"
        httpx.patch(close_url, headers=headers, json={"state": "closed"}, timeout=15)
        print(f"  [INFO] Issue #{issue['number']} をcloseしました。")
        return prefs
    except Exception as e:
        print(f"  [WARN] preferences取得失敗: {e}")
        return None


def collect(top_n: int = 30) -> list:
    """
    過去24時間のニュースを収集してスコア順上位 top_n 件を返す。
    意味的重複排除・ソース多様性制御・preferences Issueブーストを適用する。
    """
    # --- preferences 読み込み ---
    prefs = _load_preferences()
    focus_categories: list = []
    focus_keywords: list = []
    if prefs:
        focus_categories = prefs.get("focus_categories", [])
        kw_raw = prefs.get("keywords", [])
        if isinstance(kw_raw, str):
            focus_keywords = [k.strip() for k in kw_raw.split(",") if k.strip()]
        else:
            focus_keywords = [k.strip() for k in kw_raw if k.strip()]
        pref_count = prefs.get("article_count", top_n)
        if isinstance(pref_count, int) and pref_count in (20, 30, 40):
            top_n = pref_count

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    all_articles: list = []

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

    # 意味的重複除去
    all_articles, removed = _deduplicate_semantic(all_articles)
    print(f"重複除去後: {len(all_articles)} 件 ({len(removed)} 件除外)")

    # 重複ログ出力
    if removed:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        try:
            _write_duplicate_log(removed, date_str)
        except Exception as e:
            print(f"  [WARN] 重複ログ出力失敗: {e}")

    # スコアリング & preferences ブースト
    for art in all_articles:
        base = _importance_score(art, art.pop("_weight"))
        if focus_categories and art["category"] in focus_categories:
            base *= 1.5
        if focus_keywords:
            text = (art["title"] + " " + art.get("summary", "")).lower()
            for kw in focus_keywords:
                if kw.lower() in text:
                    base += 5.0
                    break
        art["score"] = base

    all_articles.sort(key=lambda x: x["score"], reverse=True)

    # ソース多様性制御
    diverse = _apply_source_diversity(all_articles, max_consecutive=3, max_per_source=5)

    result = diverse[:top_n]
    print(f"上位 {len(result)} 件を選定\n")
    return result
