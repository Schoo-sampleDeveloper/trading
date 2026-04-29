"""
main.py
collect → summarize → build_site の一括実行エントリポイント。
"""

import sys
from collector import collect
from summarizer import summarize
from build_site import build


def main():
    print("=" * 50)
    print("  デイリー金融ニュース 自動生成システム")
    print("=" * 50 + "\n")

    # 1. 収集
    articles = collect(top_n=30)
    if not articles:
        print("[ERROR] ニュースを取得できませんでした。終了します。")
        sys.exit(1)

    # 2. 要約
    summarized = summarize(articles)

    # 3. サイト生成
    build(summarized)

    print("=" * 50)
    print("  完了! docs/ を GitHub Pages で公開してください。")
    print("=" * 50)


if __name__ == "__main__":
    main()
