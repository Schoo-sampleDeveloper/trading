"""
validate_importance.py
過去30日のアーカイブから重要度判定の精度を検証し、
docs/validation/YYYY-MM.html にレポートを出力する。
"""

import json
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
DOCS_DIR = Path(__file__).parent / "docs" / "validation"


def load_archive(days: int = 30) -> list[dict]:
    """news_archive.jsonl から直近 days 日の記事を読み込む。"""
    path = DATA_DIR / "news_archive.jsonl"
    if not path.exists():
        print(f"[ERROR] {path} が見つかりません。")
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    articles = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            art = json.loads(line)
            # date フィールドでフィルタ
            date_str = art.get("date", "")
            if date_str:
                try:
                    art_date = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                    if art_date >= cutoff:
                        articles.append(art)
                except ValueError:
                    pass
        except json.JSONDecodeError:
            pass
    return articles


def fetch_reactions_for_archive(articles: list[dict]) -> list[dict]:
    """各記事に市場反応データを付与して返す。"""
    try:
        from market_reaction import fetch_market_reaction
    except ImportError:
        print("[WARN] market_reaction モジュールが見つかりません。市場反応なしで集計します。")
        return [{**a, "_reaction": None} for a in articles]

    enriched = []
    total = len(articles)
    for i, art in enumerate(articles, 1):
        pub = art.get("datetime", art.get("date", ""))
        cat = art.get("category", "fx_macro")
        link = art.get("link", "")
        print(f"  [{i}/{total}] 市場反応取得中: {art.get('headline', '')[:40]}...")
        try:
            reaction = fetch_market_reaction(pub, cat, link)
        except Exception as e:
            print(f"    [WARN] {e}")
            reaction = None
        enriched.append({**art, "_reaction": reaction})
    return enriched


def aggregate(articles: list[dict]) -> dict:
    """
    星別に市場反応を集計する。
    Returns:
        {
            "by_stars": {
                1: {"count": int, "reactions": [...], "avg_abs_pct": float},
                ...
                5: {...}
            },
            "mismatches": {
                "high_stars_low_reaction": [...],   # ★4+ なのに反応 0.1% 以下
                "low_stars_high_reaction": [...],   # ★2以下 なのに反応 1.5% 以上
            }
        }
    """
    by_stars: dict = defaultdict(lambda: {"count": 0, "reactions": [], "abs_pcts": []})

    for art in articles:
        stars = art.get("importance", 3)
        stars = max(1, min(5, int(stars)))
        reaction = art.get("_reaction")

        by_stars[stars]["count"] += 1

        abs_pct = None
        if reaction and reaction.get("data_quality") != "unavailable":
            abs_pct = reaction.get("abs_change_pct", 0.0)
            by_stars[stars]["abs_pcts"].append(abs_pct)

        by_stars[stars]["reactions"].append({
            "headline":    art.get("headline", ""),
            "date":        art.get("date", ""),
            "link":        art.get("link", ""),
            "abs_change":  abs_pct,
            "reaction":    reaction,
        })

    # 平均計算
    result_by_stars = {}
    for s in range(1, 6):
        data = by_stars[s]
        avg = (
            sum(data["abs_pcts"]) / len(data["abs_pcts"])
            if data["abs_pcts"] else None
        )
        result_by_stars[s] = {
            "count":        data["count"],
            "avg_abs_pct":  round(avg, 3) if avg is not None else None,
            "articles":     data["reactions"],
        }

    # ミスマッチ検出
    high_stars_low_reaction = []
    low_stars_high_reaction = []

    for art in articles:
        stars = max(1, min(5, int(art.get("importance", 3))))
        reaction = art.get("_reaction")
        if reaction and reaction.get("data_quality") != "unavailable":
            abs_pct = reaction.get("abs_change_pct", 0.0)
            if stars >= 4 and abs_pct <= 0.1:
                high_stars_low_reaction.append({
                    "stars":    stars,
                    "headline": art.get("headline", ""),
                    "date":     art.get("date", ""),
                    "link":     art.get("link", ""),
                    "abs_pct":  abs_pct,
                })
            elif stars <= 2 and abs_pct >= 1.5:
                low_stars_high_reaction.append({
                    "stars":    stars,
                    "headline": art.get("headline", ""),
                    "date":     art.get("date", ""),
                    "link":     art.get("link", ""),
                    "abs_pct":  abs_pct,
                })

    return {
        "by_stars": result_by_stars,
        "mismatches": {
            "high_stars_low_reaction": high_stars_low_reaction,
            "low_stars_high_reaction": low_stars_high_reaction,
        },
    }


def print_report(stats: dict, days: int) -> None:
    """コンソールに集計結果を出力。"""
    print(f"\n過去{days}日 重要度判定の精度検証")
    print("=" * 45)
    by_stars = stats["by_stars"]
    for s in range(5, 0, -1):
        data = by_stars.get(s, {})
        count = data.get("count", 0)
        avg   = data.get("avg_abs_pct")
        avg_str = f"{avg:.2f}%" if avg is not None else "データなし"
        print(f"  ★{s}判定: {count:3d}件 → 平均市場反応 {avg_str}")

    mm = stats["mismatches"]
    high_low = mm["high_stars_low_reaction"]
    low_high = mm["low_stars_high_reaction"]

    print("\nミスマッチ:")
    if high_low:
        print(f"  ★4以上なのに市場反応0.1%以下: {len(high_low)}件")
        for item in high_low[:5]:
            print(f"    - ★{item['stars']} / {item['date']} / {item['headline'][:40]} ({item['abs_pct']:.3f}%)")
    else:
        print("  ★4以上なのに市場反応0.1%以下: 0件")

    if low_high:
        print(f"  ★2以下なのに市場反応1.5%以上: {len(low_high)}件 (見落とし候補)")
        for item in low_high[:5]:
            print(f"    - ★{item['stars']} / {item['date']} / {item['headline'][:40]} ({item['abs_pct']:.3f}%)")
    else:
        print("  ★2以下なのに市場反応1.5%以上: 0件")


def _mismatch_rows(items: list[dict], label: str, color: str) -> str:
    if not items:
        return f"<p style='color:#8b949e'>{label}: 0件</p>"
    rows = ""
    for item in items:
        link = item.get("link", "#")
        headline = item.get("headline", "")
        stars = item.get("stars", "?")
        date  = item.get("date", "")
        abs_pct = item.get("abs_pct", 0.0)
        rows += (
            f"<tr>"
            f"<td>★{stars}</td>"
            f"<td>{date}</td>"
            f"<td><a href='{link}' target='_blank' style='color:#58a6ff'>{headline[:60]}</a></td>"
            f"<td style='color:{color}'>{abs_pct:.3f}%</td>"
            f"</tr>"
        )
    return (
        f"<h4 style='color:{color}'>{label}: {len(items)}件</h4>"
        f"<table><thead><tr><th>星</th><th>日付</th><th>見出し</th><th>市場反応</th></tr></thead>"
        f"<tbody>{rows}</tbody></table>"
    )


def generate_html(stats: dict, ym: str, days: int) -> str:
    """月次レポートの HTML を生成。"""
    by_stars = stats["by_stars"]
    mm = stats["mismatches"]
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    # 集計テーブル
    rows = ""
    for s in range(5, 0, -1):
        data = by_stars.get(s, {})
        count = data.get("count", 0)
        avg   = data.get("avg_abs_pct")
        avg_str = f"{avg:.2f}%" if avg is not None else "—"
        star_color = {5: "#f85149", 4: "#d29922", 3: "#e3b341", 2: "#58a6ff", 1: "#8b949e"}.get(s, "#e6edf3")
        rows += (
            f"<tr>"
            f"<td style='color:{star_color}'>{'★'*s}{'☆'*(5-s)}</td>"
            f"<td>{count}</td>"
            f"<td>{avg_str}</td>"
            f"</tr>"
        )

    high_low_html = _mismatch_rows(
        mm["high_stars_low_reaction"],
        "★4以上なのに市場反応0.1%以下",
        "#f85149",
    )
    low_high_html = _mismatch_rows(
        mm["low_stars_high_reaction"],
        "★2以下なのに市場反応1.5%以上（見落とし候補）",
        "#e3b341",
    )

    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>重要度精度検証 {ym}</title>
  <style>
    body {{ background:#0d1117; color:#e6edf3; font-family:'Segoe UI',sans-serif; padding:24px; max-width:900px; margin:auto }}
    h1 {{ color:#58a6ff; font-size:1.3rem }}
    h2 {{ color:#e3b341; font-size:1.1rem; margin-top:28px }}
    h4 {{ margin-top:16px }}
    table {{ width:100%; border-collapse:collapse; margin-bottom:16px }}
    th,td {{ text-align:left; padding:7px 10px; border-bottom:1px solid #30363d; vertical-align:top }}
    th {{ background:#161b22; color:#58a6ff; position:sticky; top:0 }}
    tr:hover {{ background:#161b22 }}
    .meta {{ color:#8b949e; font-size:0.82rem; margin-bottom:20px }}
    a {{ color:#58a6ff; text-decoration:none }}
    a:hover {{ text-decoration:underline }}
  </style>
</head>
<body>
<h1>重要度判定 精度検証レポート — {ym}</h1>
<p class="meta">集計期間: 過去{days}日 | 生成: {generated_at}</p>

<h2>星別 平均市場反応</h2>
<table>
  <thead><tr><th>重要度</th><th>件数</th><th>平均市場反応(±%)</th></tr></thead>
  <tbody>{rows}</tbody>
</table>

<h2>ミスマッチ分析</h2>
{high_low_html}
{low_high_html}

</body>
</html>"""


def run(days: int = 30, fetch: bool = True) -> None:
    ym = datetime.now(timezone.utc).strftime("%Y-%m")
    print(f"=== 重要度精度検証 ({ym}, 過去{days}日) ===")

    articles = load_archive(days)
    if not articles:
        print("[ERROR] アーカイブが空です。終了。")
        return

    print(f"対象記事: {len(articles)} 件")

    if fetch:
        articles = fetch_reactions_for_archive(articles)
    else:
        articles = [{**a, "_reaction": None} for a in articles]

    stats = aggregate(articles)
    print_report(stats, days)

    # HTML 出力
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    html = generate_html(stats, ym, days)
    out_path = DOCS_DIR / f"{ym}.html"
    out_path.write_text(html, encoding="utf-8")
    print(f"\nレポート出力: {out_path}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="重要度判定精度検証")
    parser.add_argument("--days",    type=int, default=30, help="集計対象日数 (デフォルト: 30)")
    parser.add_argument("--no-fetch", action="store_true",  help="市場反応データの取得をスキップ")
    args = parser.parse_args()
    run(days=args.days, fetch=not args.no_fetch)
