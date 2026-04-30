"""
summarizer.py
Groq API (llama-3.3-70b-versatile) で各記事を機関投資家向けプロ分析JSONに変換する。
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

SYSTEM_PROMPT = """あなたは機関投資家向けに市況コメントを書くシニアアナリストです。
読み手は10年以上の投資経験を持つプロです。

絶対遵守:
- 「初心者にもわかりやすく」「〇〇とは何か」のような説明は一切不要
- 専門用語(デュレーション、ベーシス、コンタンゴ、テールリスク、IV/HV、コンベクシティ等)はそのまま使用する
- 数値・日時・固有名詞を最優先。形容詞や感想は最小限
- 「重要です」「注目です」のような曖昧表現を禁止。代わりに具体的な含意を述べる
- 「投資推奨ではない」等のディスクレーマーは個別記事には不要(サイト全体のフッターで一括表示)
- trade_ideas は「推奨」ではなく「市場参加者がどう動きうるかの仮説」として記述
- 不確実性が高い項目は「〜の可能性」「〜が示唆される」と表現するが、過剰な留保は避ける
- 情報が不足している項目は無理に埋めず null や空文字でOK

スタイル:
- ブルームバーグ・ロイターのアナリストレポート調
- 1文を短く、定量情報を最大限に
- 「マーケットインパクト」「ポジショニング」「シナリオ」を必ず分けて記述

必ず以下のJSON形式のみで回答してください。余分な説明は一切不要です。JSONのみ出力してください。

{
  "headline": "事実ベースの簡潔な見出し(数字・固有名詞優先、40字以内)",
  "importance": 1から5の整数(マクロ重大ニュース=5、地域的小ニュース=1),
  "category": "jp_stock | jp_index | foreign_stock | foreign_index | futures | fx_macro のいずれか1つ",
  "impact": "強気 | 弱気 | 中立",
  "summary": "事実の要点。数値・日時・主体を明示し、感想を含めない3〜4行",

  "key_data": [
    {"label": "前日比", "value": "+1.2%"},
    {"label": "出来高", "value": "通常比1.5倍"},
    {"label": "VIX", "value": "18.3 → 16.7"}
  ],

  "technical_view": {
    "levels": "重要な価格水準・サポート/レジスタンス(例: 日経 39,500のレジ突破、次は40,000)",
    "momentum": "モメンタム・出来高・RSI等の示唆(該当する場合)",
    "pattern": "チャートパターンや過去の類似局面"
  },

  "fundamental_view": {
    "drivers": "ファンダ要因・マクロ背景(数字ベース)",
    "valuation": "バリュエーション観点(PER・PBR・スプレッド等、わかる範囲で)",
    "catalysts": "今後数日〜数週間で意識すべきカタリスト"
  },

  "positioning": {
    "consensus": "市場コンセンサス・既に織り込まれている部分",
    "surprise_factor": "サプライズ要素・コンセンサスとの乖離",
    "flow": "資金フローや需給示唆(機関投資家動向、ETFフロー等わかる範囲)"
  },

  "scenarios": {
    "base": "メインシナリオ(50-60%)とその場合の各資産の動き",
    "bull": "強気シナリオ(20-25%)とトリガー",
    "bear": "弱気シナリオ(20-25%)とトリガー"
  },

  "trade_ideas": {
    "directional": "方向性のあるアイデア(具体的なエントリー水準・損切り目処。仮説として)",
    "relative_value": "ペアトレード・スプレッド戦略のアイデア",
    "hedge": "既存ポジション保有者向けのヘッジ案",
    "risk_reward": "想定リスクリワード比"
  },

  "watch_points": [
    "翌営業日に注目すべき経済指標・要人発言",
    "関連銘柄・関連商品の動き"
  ],

  "historical_analog": "過去の類似局面とその後の展開(2018年VIXショック時、2015年人民元切り下げ時など)"
}"""

# 短縮版フォールバック (Groq失敗時)
SHORT_SYSTEM_PROMPT = """あなたは機関投資家向けシニアアナリストです。以下のJSON形式のみで回答してください。
{
  "headline": "40字以内の見出し",
  "importance": 3,
  "category": "fx_macro",
  "impact": "中立",
  "summary": "3行の事実要約",
  "key_data": [{"label": "主要指標", "value": "-"}],
  "technical_view": {"levels": "", "momentum": "", "pattern": ""},
  "fundamental_view": {"drivers": "", "valuation": "", "catalysts": ""},
  "positioning": {"consensus": "", "surprise_factor": "", "flow": ""},
  "scenarios": {"base": "", "bull": "", "bear": ""},
  "trade_ideas": {"directional": "", "relative_value": "", "hedge": "", "risk_reward": ""},
  "watch_points": [],
  "historical_analog": ""
}"""

IMPACT_EMOJI = {
    "強気": "🔼",
    "弱気": "🔽",
    "中立": "➡️",
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
                max_tokens=1500,
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

    # key_data の型チェック
    key_data = data.get("key_data", [])
    if not isinstance(key_data, list):
        key_data = []

    # technical_view
    tv = data.get("technical_view") or {}
    technical_view = {
        "levels": (tv.get("levels") or ""),
        "momentum": (tv.get("momentum") or ""),
        "pattern": (tv.get("pattern") or ""),
    }

    # fundamental_view
    fv = data.get("fundamental_view") or {}
    fundamental_view = {
        "drivers": (fv.get("drivers") or ""),
        "valuation": (fv.get("valuation") or ""),
        "catalysts": (fv.get("catalysts") or ""),
    }

    # positioning
    pv = data.get("positioning") or {}
    positioning = {
        "consensus": (pv.get("consensus") or ""),
        "surprise_factor": (pv.get("surprise_factor") or ""),
        "flow": (pv.get("flow") or ""),
    }

    # scenarios
    sc = data.get("scenarios") or {}
    scenarios = {
        "base": (sc.get("base") or ""),
        "bull": (sc.get("bull") or ""),
        "bear": (sc.get("bear") or ""),
    }

    # trade_ideas
    ti = data.get("trade_ideas") or {}
    trade_ideas = {
        "directional": (ti.get("directional") or ""),
        "relative_value": (ti.get("relative_value") or ""),
        "hedge": (ti.get("hedge") or ""),
        "risk_reward": (ti.get("risk_reward") or ""),
    }

    # watch_points
    watch_points = data.get("watch_points", [])
    if not isinstance(watch_points, list):
        watch_points = []

    return {
        "headline": data.get("headline", title[:40]),
        "importance": max(1, min(5, int(data.get("importance", 3)))),
        "category_ai": data.get("category", ""),
        "impact": impact_label,
        "impact_emoji": impact_emoji,
        "impact_label": impact_label,
        "summary": (data.get("summary") or summary[:200]),
        "key_data": key_data,
        "technical_view": technical_view,
        "fundamental_view": fundamental_view,
        "positioning": positioning,
        "scenarios": scenarios,
        "trade_ideas": trade_ideas,
        "watch_points": watch_points,
        "historical_analog": (data.get("historical_analog") or ""),
    }


def _fallback(title: str, summary: str) -> dict:
    return {
        "headline": title[:40],
        "importance": 2,
        "category_ai": "",
        "impact": "中立",
        "impact_emoji": "➡️",
        "impact_label": "中立",
        "summary": summary[:200] if summary else "要約取得失敗",
        "key_data": [],
        "technical_view": {"levels": "", "momentum": "", "pattern": ""},
        "fundamental_view": {"drivers": "", "valuation": "", "catalysts": ""},
        "positioning": {"consensus": "", "surprise_factor": "", "flow": ""},
        "scenarios": {"base": "", "bull": "", "bear": ""},
        "trade_ideas": {"directional": "", "relative_value": "", "hedge": "", "risk_reward": ""},
        "watch_points": [],
        "historical_analog": "",
    }


def generate_daily_theme(client: Groq, articles: list[dict]) -> str:
    """
    全記事から「本日のマーケット環境」サマリーを生成する(プロ向け、200-300字+カタリスト3点)。
    """
    headlines = "\n".join(
        f"- [{art.get('category', '')}] {art.get('headline', art.get('title', ''))} ({art.get('impact', '中立')})"
        for art in articles[:15]
    )
    prompt = f"""以下は本日の主な金融ニュース見出しです。
{headlines}

プロのシニアアナリストとして、本日のマーケット環境を以下の形式でまとめてください。
JSONではなく、日本語の平文テキストで出力してください。

1行目: 「本日のマーケット環境: [リスクオン/リスクオフ/混在の判定と根拠を1行で]」
続けて2〜4行: ボラティリティ環境・注目フロー・テールリスクをマクロ視点で200-300字で記述。
数値・固有名詞を最大限に使用。感想・曖昧表現は禁止。

最後に空行を挟んで「■ 明日以降のキーカタリスト:」という見出しの下に、
注目すべき3点を箇条書き(・)で簡潔に記述してください。"""

    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "あなたは機関投資家向けシニアマーケットアナリストです。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
            max_tokens=512,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        print(f"  [WARN] マーケット環境生成失敗: {e}")
        return ""


def summarize(articles: list[dict]) -> tuple[list[dict], str]:
    """
    各記事を Groq でプロ向け分析JSONに変換。featured フラグでトップ7本を選定して返す。
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

    # マーケット環境生成
    print("=== 本日のマーケット環境生成中 ===")
    daily_theme = generate_daily_theme(client, results)
    if daily_theme:
        print(f"  生成完了\n")
    else:
        print(f"  生成スキップ\n")

    return results, daily_theme
