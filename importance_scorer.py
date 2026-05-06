"""
importance_scorer.py
市場反応・構造的重要度・AI判断の3層スコアを統合し、
最終的な重要度(1-5星)と透明性テキストを計算する。
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional


def _stars_from_score(final_score: float) -> int:
    if final_score >= 8.5:
        return 5
    elif final_score >= 7.0:
        return 4
    elif final_score >= 5.0:
        return 3
    elif final_score >= 3.0:
        return 2
    return 1


def _build_transparency_text(
    stars: int,
    market: dict,
    structural: dict,
    ai: dict,
    final_score: float,
) -> str:
    """
    ユーザー向けに「なぜこの重要度か」を説明する1行テキストを生成する。
    例: "★5の根拠: 公開後S&P500が-1.8%下落 / FOMC政策金利決定に該当 / AI評価9/10"
    """
    parts: list[str] = []

    # 市場反応パート
    if market.get("data_quality") != "unavailable":
        ind = market.get("indicator_name", market.get("indicator", ""))
        pct = market.get("change_pct", 0.0)
        sign = "+" if pct >= 0 else ""
        parts.append(f"公開後{ind}が{sign}{pct:.2f}%変動")
    else:
        parts.append("市場データ取得不可")

    # 構造的分類パート
    rules = structural.get("matched_rules", [])
    if rules:
        names = "・".join(r["name"] for r in rules[:2])
        parts.append(f"{names}に該当")
    else:
        parts.append("一般ニュース")

    # AI評価パート
    ai_score    = ai.get("score", 0)
    ai_signal   = ai.get("key_signal", "")
    ai_part = f"AI評価{ai_score}/10"
    if ai_signal:
        short_signal = ai_signal[:30] + ("…" if len(ai_signal) > 30 else "")
        ai_part += f"「{short_signal}」"
    parts.append(ai_part)

    return f"★{stars}の根拠: " + " / ".join(parts)


def calculate_final_importance(
    article: dict,
    market_reaction: Optional[dict] = None,
    ai_importance: Optional[dict] = None,
) -> dict:
    """
    3層スコアを統合して最終重要度を返す。

    Args:
        article:         collector/summarizer の出力記事 dict
        market_reaction: market_reaction.fetch_market_reaction() の返り値（省略可）
        ai_importance:   summarizer の ai_importance フィールド（省略可）

    Returns:
        {
            "stars":             int (1-5),
            "final_score":       float,
            "breakdown": {
                "market_reaction": dict,
                "structural":      dict,
                "ai":              dict,
            },
            "transparency_text": str,
        }
    """
    from collector import calculate_structural_score

    # ── 構造的重要度 ──────────────────────────────
    structural = calculate_structural_score(article)
    structural_score = float(structural.get("score", 3))

    # ── 市場反応 ─────────────────────────────────
    if market_reaction is None:
        market_reaction = {
            "indicator": "",
            "indicator_name": "",
            "before_price": 0.0,
            "after_price": 0.0,
            "change_pct": 0.0,
            "abs_change_pct": 0.0,
            "reaction_score": 0.0,
            "data_quality": "unavailable",
            "note": "取得スキップ",
        }
    reaction_score  = float(market_reaction.get("reaction_score", 0.0))
    data_quality    = market_reaction.get("data_quality", "unavailable")

    # ── AI判断 ──────────────────────────────────
    if ai_importance is None:
        ai_importance = article.get("ai_importance") or {
            "score":      5,
            "rationale":  "",
            "key_signal": "",
            "uncertainty": "medium",
        }
    ai_score = float(ai_importance.get("score", 5))

    # ── 重み付け統合 ─────────────────────────────
    if data_quality == "unavailable":
        # 市場データなし → 構造 60% + AI 40%
        final_score = structural_score * 0.6 + ai_score * 0.4
    elif data_quality == "limited":
        # 精度が低い市場データ → 構造 40% + 市場 30% + AI 30%
        final_score = (
            reaction_score  * 0.30 +
            structural_score * 0.40 +
            ai_score        * 0.30
        )
    else:
        # 良質な市場データあり → 市場 50% + 構造 30% + AI 20%
        final_score = (
            reaction_score  * 0.50 +
            structural_score * 0.30 +
            ai_score        * 0.20
        )

    final_score = round(final_score, 2)
    stars = _stars_from_score(final_score)

    transparency_text = _build_transparency_text(
        stars, market_reaction, structural, ai_importance, final_score
    )

    return {
        "stars":       stars,
        "final_score": final_score,
        "breakdown": {
            "market_reaction": market_reaction,
            "structural":      structural,
            "ai":              ai_importance,
        },
        "transparency_text": transparency_text,
    }


def enrich_articles_with_importance(
    articles: list[dict],
    fetch_market: bool = True,
    max_articles: int = 25,
) -> list[dict]:
    """
    記事リストに importance スコアリングを適用して返す。

    Args:
        articles:     summarize() の出力リスト
        fetch_market: 市場反応データを取得するか（API呼び出しあり）
        max_articles: AI評価付き記事の上限（トークン消費抑制）

    Returns:
        各記事に "importance_detail" キーを追加したリスト
    """
    if fetch_market:
        try:
            from market_reaction import fetch_market_reaction
            _fetch_fn = fetch_market_reaction
        except ImportError:
            print("  [WARN] market_reaction モジュール未検出。市場反応取得をスキップ。")
            _fetch_fn = None
    else:
        _fetch_fn = None

    enriched = []
    for i, art in enumerate(articles[:max_articles]):
        market_data = None
        if _fetch_fn:
            pub = art.get("published")
            if pub:
                pub_str = pub.isoformat() if hasattr(pub, "isoformat") else str(pub)
            else:
                pub_str = datetime.now(timezone.utc).isoformat()
            try:
                market_data = _fetch_fn(
                    article_published_at=pub_str,
                    category=art.get("category", "fx_macro"),
                    article_url=art.get("link", ""),
                )
            except Exception as e:
                print(f"  [WARN] 市場反応取得エラー (記事{i+1}): {e}")

        ai_imp = art.get("ai_importance")
        detail = calculate_final_importance(art, market_data, ai_imp)
        enriched.append({**art, "importance_detail": detail})

    # max_articles を超えた残り記事には簡易スコアのみ付与
    for art in articles[max_articles:]:
        ai_imp = art.get("ai_importance")
        detail = calculate_final_importance(art, None, ai_imp)
        enriched.append({**art, "importance_detail": detail})

    return enriched
