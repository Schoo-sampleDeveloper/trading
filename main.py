"""
main.py
collect → summarize → build_site の一括実行エントリポイント。
"""

import json
import logging
import sys
from collector import collect
from summarizer import summarize
from build_site import build, append_to_news_archive, append_to_insights_archive

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


def main():
    print("=" * 50)
    print("  デイリー金融ニュース 自動生成システム")
    print("=" * 50 + "\n")

    # 1. 収集
    articles = collect(top_n=30)
    if not articles:
        print("[ERROR] ニュースを取得できませんでした。終了します。")
        sys.exit(1)

    # 2. 要約 (戻り値: articles, daily_theme)
    summarized, daily_theme = summarize(articles)

    # 3層重要度スコアリング (失敗しても継続)
    try:
        from importance_scorer import enrich_articles_with_importance
        print("\n--- 重要度スコアリング (3層統合) ---")
        summarized = enrich_articles_with_importance(
            summarized,
            fetch_market=True,
            max_articles=25,
        )
        print(f"  スコアリング完了: {len(summarized)} 件")
    except Exception as e:
        print(f"  [WARN] 重要度スコアリングエラー: {e} → スキップします。")

    # 重要度★4以上の記事を抽出(洞察生成・アーカイブ用)
    top_news = [a for a in summarized if a.get("importance", 0) >= 4][:10]

    # 3. マーケットデータ取得 (失敗しても継続)
    market_data: dict = {}
    nikkei = None
    try:
        from market_data import fetch_index_data, save_history
        print("\n--- マーケットデータ取得 ---")
        nikkei = fetch_index_data("^N225", period="1y")
        if nikkei:
            save_history(nikkei)
            market_data["nikkei"] = nikkei
            if nikkei.get('change_percent') is not None:
                print(f"  日経平均: {nikkei.get('current')} ({nikkei.get('change_percent'):+.2f}%)")
            else:
                print(f"  日経平均: {nikkei.get('current')}")
        else:
            print("  [WARN] 日経平均データの取得に失敗しました。マーケットセクションをスキップします。")
        # S&P 500
        sp500 = fetch_index_data("^GSPC", period="1y")
        if sp500:
            market_data["sp500"] = sp500
            if sp500.get('change_percent') is not None:
                print(f"  S&P 500:  {sp500.get('current')} ({sp500.get('change_percent'):+.2f}%)")
            else:
                print(f"  S&P 500:  {sp500.get('current')}")
        else:
            print("  [WARN] S&P 500データの取得に失敗しました。スキップします。")
    except Exception as e:
        print(f"  [WARN] マーケットデータ取得エラー: {e} → マーケットセクションをスキップします。")

    # 3b. AI洞察生成 (失敗しても継続)
    insight: dict = {}
    try:
        from insight_generator import generate_daily_insight
        print("\n--- AI洞察生成 ---")
        if nikkei and top_news:
            recent_history = nikkei.get("ohlc", [])[-7:]
            result = generate_daily_insight(market_data, top_news, recent_history)
            if result:
                insight = result
                print(f"  主因: {insight.get('primary_driver', '')}")
                print(f"  センチメント: {insight.get('sentiment', '')}")
            else:
                print("  [WARN] AI洞察の生成に失敗しました。スキップします。")
        else:
            print("  [WARN] 市場データまたはニュースが不足。洞察生成スキップ。")
    except Exception as e:
        print(f"  [WARN] AI洞察生成エラー: {e} → スキップします。")

    # 4. アーカイブ更新 (失敗しても継続)
    try:
        from datetime import datetime, timezone, timedelta
        JST = timezone(timedelta(hours=9))
        date_str = datetime.now(JST).strftime("%Y-%m-%d")

        print("\n--- アーカイブ更新 ---")
        if top_news:
            append_to_news_archive(top_news, date_str)
        if insight and nikkei:
            append_to_insights_archive(insight, nikkei, date_str)
    except Exception as e:
        print(f"  [WARN] アーカイブ更新エラー: {e}")

    # 5. 長期データ取得 (失敗しても継続)
    long_term: dict = {}
    try:
        from long_term_data import fetch_long_term_data
        print("\n--- 長期データ取得 ---")
        long_term["n225"] = fetch_long_term_data("^N225", years=30)
        long_term["sp500"] = fetch_long_term_data("^GSPC", years=30)
    except Exception as e:
        print(f"  [WARN] 長期データ取得エラー: {e} → 分析ページをスキップします。")

    # 5b. シナリオデータ読み込み
    scenarios: dict = {"scenarios": []}
    try:
        from pathlib import Path
        scenarios_path = Path(__file__).parent / "data" / "historical_scenarios.json"
        if scenarios_path.exists():
            scenarios = json.loads(scenarios_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  [WARN] シナリオデータ読み込みエラー: {e}")

    # 6. サイト生成
    build(
        summarized,
        daily_theme=daily_theme,
        market_data=market_data,
        insight=insight,
        long_term=long_term,
        scenarios=scenarios,
    )

    # API使用統計
    try:
        from summarizer import get_api_stats
        stats = get_api_stats()
        call_count = stats["call_count"]
        total_tokens = stats["total_tokens"]
        daily_limit = 500_000
        usage_pct = total_tokens / daily_limit * 100 if daily_limit > 0 else 0
        print(f"\n--- API使用統計 ---")
        print(f"  Groq API 呼び出し: {call_count}回 (実測 {total_tokens:,} トークン)")
        print(f"  日次上限: {daily_limit:,} (llama-3.1-8b-instant)")
        print(f"  使用率: {usage_pct:.1f}%")
    except Exception as e:
        print(f"  [WARN] API統計取得失敗: {e}")

    print("=" * 50)
    print("  完了! docs/ を GitHub Pages で公開してください。")
    print("=" * 50)


if __name__ == "__main__":
    main()
