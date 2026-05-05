"""
main.py
collect → summarize → build_site の一括実行エントリポイント。
"""

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

    # 5. サイト生成
    build(summarized, daily_theme=daily_theme, market_data=market_data, insight=insight)

    print("=" * 50)
    print("  完了! docs/ を GitHub Pages で公開してください。")
    print("=" * 50)


if __name__ == "__main__":
    main()
