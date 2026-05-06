"""
migrate_archive.py
news_archive.jsonl の旧スキーマを新フォーマット（importance_detail フィールド付き）に変換する。
バックアップを data/news_archive.jsonl.bak に作成してから実行する。
"""

import json
import shutil
import sys
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
ARCHIVE_PATH = DATA_DIR / "news_archive.jsonl"
BACKUP_PATH  = DATA_DIR / "news_archive.jsonl.bak"


def _default_importance_detail(stars: int) -> dict:
    """旧記事用のデフォルト importance_detail を生成。"""
    return {
        "stars": stars,
        "final_score": float(stars * 2),  # 大まかな推定値
        "breakdown": {
            "market_reaction": {
                "indicator":      "",
                "indicator_name": "",
                "before_price":   0.0,
                "after_price":    0.0,
                "change_pct":     0.0,
                "abs_change_pct": 0.0,
                "reaction_score": 0.0,
                "data_quality":   "unavailable",
                "note":           "旧データ: 取得未実施",
            },
            "structural": {
                "score":         stars * 2,
                "matched_rules": [],
                "rationale":     "旧スキーマからの移行",
            },
            "ai": {
                "score":       stars * 2,
                "rationale":   "",
                "key_signal":  "",
                "uncertainty": "high",
            },
        },
        "transparency_text": f"★{stars}（旧スキーマ: 詳細内訳なし）",
    }


def migrate(dry_run: bool = False) -> None:
    """
    news_archive.jsonl を新フォーマットに変換。

    変換内容:
    - importance_detail フィールドがない記事に追加
    - ai_importance フィールドがない記事に追加
    """
    if not ARCHIVE_PATH.exists():
        print(f"[ERROR] {ARCHIVE_PATH} が見つかりません。")
        sys.exit(1)

    lines = ARCHIVE_PATH.read_text(encoding="utf-8").splitlines()
    total = sum(1 for l in lines if l.strip())
    print(f"対象行数: {total}")

    if not dry_run:
        shutil.copy2(ARCHIVE_PATH, BACKUP_PATH)
        print(f"バックアップ作成: {BACKUP_PATH}")

    migrated_count = 0
    unchanged_count = 0
    error_count = 0
    output_lines: list[str] = []

    for i, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
        try:
            art = json.loads(line)
        except json.JSONDecodeError as e:
            print(f"  [WARN] 行{i}: JSONパースエラー → スキップ ({e})")
            error_count += 1
            continue

        changed = False

        # importance_detail がない場合に追加
        if "importance_detail" not in art:
            stars = max(1, min(5, int(art.get("importance", 3))))
            art["importance_detail"] = _default_importance_detail(stars)
            changed = True

        # ai_importance がない場合に追加
        if "ai_importance" not in art:
            stars = max(1, min(5, int(art.get("importance", 3))))
            art["ai_importance"] = {
                "score":      stars * 2,
                "rationale":  "",
                "key_signal": "",
                "uncertainty": "high",
            }
            changed = True

        if changed:
            migrated_count += 1
        else:
            unchanged_count += 1

        output_lines.append(json.dumps(art, ensure_ascii=False))

    print(f"\n集計:")
    print(f"  変換済み: {migrated_count} 件")
    print(f"  変更なし: {unchanged_count} 件")
    print(f"  エラー:   {error_count} 件")

    if dry_run:
        print("\n[DRY RUN] 実際の書き込みはスキップしました。")
        print("  実行するには --run オプションを付けてください。")
        return

    ARCHIVE_PATH.write_text("\n".join(output_lines) + "\n", encoding="utf-8")
    print(f"\n{ARCHIVE_PATH} を更新しました。")
    print(f"バックアップは {BACKUP_PATH} に保存されています。")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="news_archive.jsonl スキーマ移行")
    parser.add_argument("--run",     action="store_true", help="実際に書き込みを行う（デフォルトはDRY RUN）")
    parser.add_argument("--no-backup", action="store_true", help="バックアップを省略（--run と組み合わせ）")
    args = parser.parse_args()

    dry = not args.run
    migrate(dry_run=dry)
