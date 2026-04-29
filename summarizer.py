"""
summarizer.py
Groq API (llama-3.3-70b-versatile) で各記事を要約・解説し、
学習コンテンツ化した拡張JSONを生成する。
トップ7本を「今日の注目」として選定する。
"""

import json
import os
import time
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

MODEL = "llama-3.3-70b-versatile"
TOP_FEATURED = 7

# レート制限対策: 記事間の待機秒数
RATE_LIMIT_DELAY = 1.2
RETRY_DELAYS = [2, 5, 15]  # 指数バックオフ(秒)

SYSTEM_PROMPT = """あなたは金融・投資専門のニュースアナリストであり、投資初心者向けの教育者でもあります。
提供された金融ニュースを日本語で分析し、必ず以下のJSON形式のみで回答してください。
余分な説明は一切不要です。JSONのみ出力してください。

{
  "headline": "40字程度の見出し(数字・固有名詞を含める)",
  "importance": 1から5の整数(マクロ重大ニュース=5、地域的小ニュース=1),
  "category": "jp_stock または jp_index または foreign_stock または foreign_index または futures または fx_macro のいずれか1つ",
  "impact": "強気 または 弱気 または 中立",
  "what_happened": "何が起きたか。3〜4行、具体的な数字や固有名詞込みで記述。",
  "why_important": "なぜ重要か。投資初心者向けに前提から4〜5行で解説。",
  "terms": [
    {"term": "用語名", "definition": "平易な定義(1〜2行)", "example": "具体例(1行)"}
  ],
  "market_impact": {
    "short_term": "短期(数日〜1週間)の予想される動き",
    "mid_term": "中期(1〜3ヶ月)の予想される動き",
    "affected_assets": [
      {"asset": "資産名(例:ドル円)", "direction": "🔼 または 🔽 または ➡️"}
    ]
  },
  "investment_perspective": {
    "long_term_investor": "インデックス長期投資家がこのニュースをどう解釈し、自分のスタイルに照らしてどう考えるか(売買推奨禁止)",
    "active_trader": "アクティブトレーダーが注目すべき観点・判断軸(売買推奨禁止)",
    "cautions": "注意点・リスク要因"
  },
  "related_concepts": ["関連学習トピック1", "関連学習トピック2"]
}

重要な制約:
- investment_perspectiveは「〇〇を買え/売れ」という具体的な売買推奨を絶対に含めないこと。
- 「このニュースをどう解釈し、自分のスタイルに照らしてどう考えるか」という教育的・思考枠組み的な記述にすること。
- termsは1〜3個。記事に専門用語が少なければ1個でよい。
- market_impactのaffected_assetsは1〜4個。"""

IMPACT_EMOJI = {
    "強気": "🔼",
    "弱気": "🔽",
    "中立": "➡️",
    # 英語フォールバック
    "bullish": "🔼",
    "bearish": "🔽",
    "neutral": "➡️",
}

IMPACT_LABEL = {
    "強気": "強気",
    "弱気": "弱気",
    "中立": "中立",
    "bullish": "強気",
    "bearish": "弱気",
    "neutral": "中立",
}

# 短縮版フォールバック (Groq失敗時)
SHORT_SYSTEM_PROMPT = """あなたは金融ニュースアナリストです。以下のJSON形式のみで回答してください。
{
  "headline": "40字以内の見出し",
  "importance": 3,
  "category": "fx_macro",
  "impact": "中立",
  "what_happened": "3行の要約",
  "why_important": "初心者向け解説",
  "terms": [{"term": "用語", "definition": "定義", "example": "例"}],
  "market_impact": {
    "short_term": "短期の動き",
    "mid_term": "中期の動き",
    "affected_assets": [{"asset": "市場全般", "direction": "➡️"}]
  },
  "investment_perspective": {
    "long_term_investor": "長期投資家の視点(売買推奨なし)",
    "active_trader": "トレーダーの注目点(売買推奨なし)",
    "cautions": "注意点"
  },
  "related_concepts": ["関連トピック"]
}"""


def _call_groq(client: Groq, title: str, summary: str) -> dict:
    """Groq APIを呼び出してJSONを返す。失敗時は指数バックオフでリトライ。"""
    user_msg = f"タイトル: {title}\n内容: {summary}"

    for attempt, system in enumerate([SYSTEM_PROMPT, SYSTEM_PROMPT, SHORT_SYSTEM_PROMPT]):
        try:
            if attempt > 0:
                delay = RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)]
                print(f"  [RETRY] {delay}秒後にリトライ (attempt {attempt + 1})")
                time.sleep(delay)

            resp = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_msg},
                ],
                temperature=0.3,
                max_tokens=1024,
                response_format={"type": "json_object"},
            )
            data = json.loads(resp.choices[0].message.content)
            return _normalize(data, title, summary)
        except Exception as e:
            print(f"  [WARN] Groq API error (attempt {attempt + 1}): {e}")
            if attempt >= 2:
                return _fallback(title, summary)
    return _fallback(title, summary)


def _normalize(data: dict, title: str, summary: str) -> dict:
    """APIレスポンスを正規化・デフォルト値補完。"""
    impact_raw = data.get("impact", "中立")
    impact_label = IMPACT_LABEL.get(impact_raw, "中立")
    impact_emoji = IMPACT_EMOJI.get(impact_raw, "➡️")

    # affected_assets の direction を絵文字に正規化
    ai_assets = data.get("market_impact", {}).get("affected_assets", [])
    for asset in ai_assets:
        d = asset.get("direction", "➡️")
        if d not in ("🔼", "🔽", "➡️"):
            # テキスト変換
            if any(w in d for w in ["上", "上昇", "高", "↑", "bullish", "強"]):
                asset["direction"] = "🔼"
            elif any(w in d for w in ["下", "下落", "安", "↓", "bearish", "弱"]):
                asset["direction"] = "🔽"
            else:
                asset["direction"] = "➡️"

    return {
        "headline": data.get("headline", title[:40]),
        "importance": max(1, min(5, int(data.get("importance", 3)))),
        "category_ai": data.get("category", ""),  # AIが判定したカテゴリ(参考)
        "impact": impact_label,
        "impact_emoji": impact_emoji,
        "impact_label": impact_label,
        "what_happened": data.get("what_happened", summary[:200]),
        "why_important": data.get("why_important", ""),
        "terms": data.get("terms", []),
        "market_impact": {
            "short_term": data.get("market_impact", {}).get("short_term", ""),
            "mid_term": data.get("market_impact", {}).get("mid_term", ""),
            "affected_assets": ai_assets,
        },
        "investment_perspective": {
            "long_term_investor": data.get("investment_perspective", {}).get("long_term_investor", ""),
            "active_trader": data.get("investment_perspective", {}).get("active_trader", ""),
            "cautions": data.get("investment_perspective", {}).get("cautions", ""),
        },
        "related_concepts": data.get("related_concepts", []),
    }


def _fallback(title: str, summary: str) -> dict:
    return {
        "headline": title[:40],
        "importance": 2,
        "category_ai": "",
        "impact": "中立",
        "impact_emoji": "➡️",
        "impact_label": "中立",
        "what_happened": summary[:200] if summary else "要約取得失敗",
        "why_important": "要約の取得に失敗しました。",
        "terms": [],
        "market_impact": {
            "short_term": "-",
            "mid_term": "-",
            "affected_assets": [],
        },
        "investment_perspective": {
            "long_term_investor": "-",
            "active_trader": "-",
            "cautions": "-",
        },
        "related_concepts": [],
    }


def generate_daily_theme(client: Groq, articles: list[dict]) -> str:
    """
    全記事から「今日のテーマ」ミニコラム(300字程度)を生成する。
    """
    headlines = "\n".join(
        f"- [{art.get('category', '')}] {art.get('headline', art.get('title', ''))}"
        for art in articles[:15]  # 上位15本を材料に
    )
    prompt = f"""以下は本日の主な金融ニュース見出しです。
{headlines}

これらを踏まえて、本日の金融市場を貫く「今日のテーマ」を1つ抽出し、
投資初心者にわかりやすい300字程度のミニコラムを書いてください。
形式: 「今日のテーマ: [テーマタイトル]」という書き出しで始め、
そのテーマの背景・重要性・初心者が学べるポイントをまとめてください。
JSONではなく、日本語の平文テキストで出力してください。"""

    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "あなたは金融教育の専門家です。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.5,
            max_tokens=512,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        print(f"  [WARN] 今日のテーマ生成失敗: {e}")
        return ""


def summarize(articles: list[dict]) -> tuple[list[dict], str]:
    """
    各記事を Groq で要約。featured フラグでトップ7本を選定して返す。
    戻り値: (enriched_articles, daily_theme_text)
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
        enriched = {
            **art,
            **analysis,
            # collectorのカテゴリを優先(AIは参考のみ)
            "featured": i < TOP_FEATURED,
        }
        results.append(enriched)
        time.sleep(RATE_LIMIT_DELAY)

    print(f"要約完了: {len(results)} 件\n")

    # 今日のテーマ生成
    print("=== 今日のテーマ生成中 ===")
    daily_theme = generate_daily_theme(client, results)
    if daily_theme:
        print(f"  テーマ生成完了\n")
    else:
        print(f"  テーマ生成スキップ\n")

    return results, daily_theme
