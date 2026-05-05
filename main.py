"""
main.py
collect → summarize → build_site の一括実行エントリポイント。
"""

import logging
import sys
from collector import collect
from summarizer import summarize
from build_site import build

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

    # 3. マーケットデータ取得 (失敗しても継続)
    market_data: dict = {}
    try:
        from market_data import fetch_index_data, save_history
        print("\n--- マーケットデータ取得 ---")
        nikkei = fetch_index_data("^N225", period="1y")
        if nikkei:
            save_history(nikkei)
            market_data["nikkei"] = nikkei
            print(f"  日経平均: {nikkei.get('current')} ({nikkei.get('change_percent'):+.2f}%)" if nikkei.get('change_percent') is not None else f"  日経平均: {nikkei.get('current')}")
        else:
            print("  [WARN] 日経平均データの取得に失敗しました。マーケットセクションをスキップします。")
    except Exception as e:
        print(f"  [WARN] マーケットデータ取得エラー: {e} → マーケットセクションをスキップします。")

    # 4. サイト生成
    build(summarized, daily_theme=daily_theme, market_data=market_data)

    print("=" * 50)
    print("  完了! docs/ を GitHub Pages で公開してください。")
    print("=" * 50)


if __name__ == "__main__":
    main()
