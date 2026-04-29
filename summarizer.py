"""
summarizer.py
Groq API (llama-3.3-70b-versatile) で各記事を要約・解説し、
トップ7本を「今日の注目」として選定する。
"""

import os
import time
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

MODEL = "llama-3.3-70b-versatile"
TOP_FEATURED = 7

SYSTEM_PROMPT = """あなたは金融・投資専門のニュースアナリストです。
提供された金融ニュースを日本語で分析し、必ず以下のJSON形式で回答してください。
余分な説明は不要です。JSONのみ出力してください。

{
  "headline": "30字以内の見出し",
  "summary": "3行要約（改行で区切る）",
  "explanation": "投資初心者向けの解説（100字以内）",
  "impact": "bullish または bearish または neutral",
  "impact_reason": "市場への影響理由（50字以内）"
}"""

IMPACT_EMOJI = {
    "bullish": "🔼",
    "bearish": "🔽",
    "neutral": "➡️",
}

IMPACT_LABEL = {
    "bullish": "強気",
    "bearish": "弱気",
    "neutral": "中立",
}


def _call_groq(client: Groq, title: str, summary: str) -> dict:
    user_msg = f"タイトル: {title}\n内容: {summary}"
    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.3,
            max_tokens=512,
            response_format={"type": "json_object"},
        )
        import json
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        print(f"  [WARN] Groq API error: {e}")
        return {
            "headline": title[:30],
            "summary": summary[:150] if summary else "要約取得失敗",
            "explanation": "要約の取得に失敗しました。",
            "impact": "neutral",
            "impact_reason": "-",
        }


def summarize(articles: list[dict]) -> list[dict]:
    """
    各記事を Groq で要約。featured フラグでトップ7本を選定して返す。
    """
    api_key = os.environ.get("GROQ_API_KEY", "")
    if not api_key:
        raise EnvironmentError("GROQ_API_KEY が設定されていません。")

    client = Groq(api_key=api_key)
    results = []

    print("=== 要約処理開始 ===")
    for i, art in enumerate(articles):
        print(f"  [{i+1}/{len(articles)}] {art['title'][:50]}...")
        analysis = _call_groq(client, art["title"], art.get("summary", ""))
        impact_key = analysis.get("impact", "neutral")
        enriched = {
            **art,
            "headline": analysis.get("headline", art["title"][:30]),
            "summary_lines": analysis.get("summary", "").split("\n"),
            "explanation": analysis.get("explanation", ""),
            "impact": impact_key,
            "impact_emoji": IMPACT_EMOJI.get(impact_key, "➡️"),
            "impact_label": IMPACT_LABEL.get(impact_key, "中立"),
            "impact_reason": analysis.get("impact_reason", ""),
            "featured": i < TOP_FEATURED,
        }
        results.append(enriched)
        # Groq無料枠のレート制限対策
        time.sleep(0.8)

    print(f"要約完了: {len(results)} 件\n")
    return results
