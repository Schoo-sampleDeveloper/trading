"""
insight_generator.py
本日の価格動向とニュースの因果関係をGroq AIに分析させ、
「今日の動きの背景」を生成する。
結果は data/insights_cache/{date}.json にキャッシュ。
"""

import json
import logging
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))
DATA_DIR = Path(__file__).parent / "data"
CACHE_DIR = DATA_DIR / "insights_cache"


def _jst_now() -> datetime:
    return datetime.now(JST)


def generate_daily_insight(
    market_data: dict,
    top_news: list,
    recent_history: list,
    date_str: Optional[str] = None,
) -> Optional[dict]:
    """
    本日の価格動向とニュースの因果関係をAIに分析させる。

    Args:
        market_data: {"nikkei": {...}} 形式のマーケットデータ
        top_news: 重要度4以上のニュース記事リスト
        recent_history: 過去5〜7日のOHLCリスト [{date, close, ...}, ...]
        date_str: 対象日 (YYYY-MM-DD)。None なら今日のJST日付。

    Returns:
        {
            "primary_driver": "30字以内の主因",
            "insight": "300字程度の解説",
            "related_news_indices": [0, 2, ...],
            "sentiment": "強気" | "弱気" | "中立",
            "key_factors": [
                {"factor": "要因名", "impact": "+"|"-"|"0", "weight": 0.0〜1.0},
                ...
            ]
        }
        または失敗時 None
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if date_str is None:
        date_str = _jst_now().strftime("%Y-%m-%d")

    cache_file = CACHE_DIR / f"{date_str}.json"

    # 同日キャッシュがあれば返す
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            logger.info(f"[insight] キャッシュ使用: {date_str}")
            return cached
        except Exception:
            pass

    # APIキー確認
    api_key = os.environ.get("GROQ_API_KEY", "")
    if not api_key:
        logger.warning("[insight] GROQ_API_KEY 未設定。洞察生成スキップ。")
        return None

    nk = market_data.get("nikkei", {})
    current = nk.get("current")
    change = nk.get("change")
    change_pct = nk.get("change_percent")

    if current is None:
        logger.warning("[insight] 日経平均データなし。洞察生成スキップ。")
        return None

    # 本日データ文字列
    current_str = f"{current:,.2f}" if current else "—"
    change_str = f"{change:+,.2f}" if change is not None else "—"
    change_pct_str = f"{change_pct:+.2f}%" if change_pct is not None else "—"

    # 過去5日の動き文字列 (最新5件)
    history_text = ""
    for h in recent_history[-5:]:
        d = h.get("date", "")
        c = h.get("close")
        v = h.get("volume")
        if c:
            history_text += f"- {d}: {c:,.0f}\n"
    if not history_text:
        history_text = "（データなし）"

    # ニュース一覧文字列
    news_text = ""
    for i, art in enumerate(top_news[:10], 1):
        headline = art.get("headline", art.get("title", ""))
        impact = art.get("impact", "中立")
        imp = art.get("importance", 3)
        category = art.get("category", "")
        news_text += f"{i}. [{impact}/★{imp}] {headline}\n"
    if not news_text:
        news_text = "（ニュースデータなし）"

    prompt = f"""あなたは中級個人投資家向けに市況解説を書くアナリストです。
本日の日経平均の動きと、当日の主要ニュースを与えますので、「なぜ動いたか」「どのニュースが効いたか」を冷静に分析してください。

【本日のデータ】
日経平均: 終値{current_str} (前日比{change_str}, {change_pct_str})

【過去5日の動き】
{history_text}
【本日の主要ニュース(重要度順)】
{news_text}
【出力形式】
以下のJSON形式のみ出力してください。JSON以外は一切出力しないこと:
{{
  "primary_driver": "本日の最大の動因(30字以内)",
  "insight": "300字程度の解説。価格変動とニュースを結びつけ「〜が好感された」「〜への警戒は限定的」のような因果説明を含める。推奨断定は避ける",
  "related_news_indices": [最も影響したニュースの番号(0始まり)最大3つ],
  "sentiment": "強気または弱気または中立",
  "key_factors": [
    {{"factor": "要因名15字以内", "impact": "+または-または0", "weight": 0.0から1.0の数値}},
    最大5つ
  ]
}}

書き方の原則:
- 数値・固有名詞を優先
- 「〇〇とは何か」の説明は不要
- 1文を短く、結論先行
- 機関投資家用語は避ける"""

    try:
        from groq import Groq
        client = Groq(api_key=api_key)

        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=800,
        )

        raw = response.choices[0].message.content.strip()

        # JSONブロック抽出
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            raw = raw[start:end]

        result = json.loads(raw)

        # バリデーション・正規化
        result["date"] = date_str
        result.setdefault("primary_driver", "")
        result.setdefault("insight", "")
        result.setdefault("related_news_indices", [])
        result.setdefault("sentiment", "中立")
        result.setdefault("key_factors", [])

        # key_factors の weight を 0〜1 に正規化
        for kf in result.get("key_factors", []):
            w = kf.get("weight", 0.5)
            kf["weight"] = max(0.0, min(1.0, float(w)))

        # キャッシュ保存
        cache_file.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        logger.info(
            f"[insight] 生成完了: {date_str} - {result.get('primary_driver', '')}"
        )
        return result

    except json.JSONDecodeError as e:
        logger.error(f"[insight] JSON解析失敗: {e}\n  raw={raw[:200]}")
        return None
    except Exception as e:
        logger.error(f"[insight] 生成失敗: {e}")
        return None
