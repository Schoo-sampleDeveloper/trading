"""
summarizer.py
Groq API (llama-3.3-70b-versatile) で各記事を中級者向け分析JSONに変換する。
トップ7本を「今日の注目」として選定する。
"""

import json
import os
import time
from pathlib import Path
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

MODEL = "llama-3.3-70b-versatile"
TOP_FEATURED = 7
DATA_DIR = Path(__file__).parent / "data"

# レート制限対策: 記事間の待機秒数
RATE_LIMIT_DELAY = 1.2
RETRY_DELAYS = [2, 5, 15]  # 指数バックオフ(秒)

SYSTEM_PROMPT = """あなたは個人投資家向けに市況解説を書く経験豊富なアナリストです。
読み手は投資歴1〜5年の中級者で、基本的な金融知識はあります。

書き方の原則:
- 数字・固有名詞・具体的な水準を優先(感想や曖昧表現は最小限)
- 専門用語を使う場合は文脈で意味が掴めるよう工夫する
  例:「VIX(米国株の恐怖指数)が18台に低下」のように初出時は短く補足
- 機関投資家専用の用語(コンベクシティ、デュレーション、CFTC建玉、IV/HV、
  ベーシス、コンタンゴ、テールリスク等)は避ける。代わりに平易な表現で同じ内容を伝える
  例: ✕「ボラティリティのテール」→ ◯「想定外の急変動リスク」
  例: ✕「カーブのベアスティープ化」→ ◯「長期金利が短期金利より早く上昇」
- ブルームバーグ調のカタカナ多用も避ける。日本語として自然に
- 「重要です」「注目です」のような中身のない表現は禁止
- 「初心者向けに〇〇とは」のような前提解説は不要(読者は中級者)
- 推奨断定は禁止。「〜の可能性」「〜が想定される」と仮説として書く
- 情報がない項目は無理に埋めず null や空文字でOK

文章のトーン:
- 落ち着いた、誠実な、知性を感じさせる文体
- 1文を短く、結論先行
- 過剰なポジショントークやセンセーショナルな表現は避ける

必ず以下のJSON形式のみで回答してください。余分な説明は一切不要です。JSONのみ出力してください。

{
  "headline": "数字・固有名詞を含む簡潔な見出し(40字以内)",
  "importance": 1から5の整数(マクロ重大ニュース=5、地域的小ニュース=1),
  "category": "jp_stock | jp_index | foreign_stock | foreign_index | futures | fx_macro のいずれか",
  "impact": "強気 | 弱気 | 中立",

  "points": [
    "要点1(20-30字、数値や固有名詞を含む)",
    "要点2",
    "要点3"
  ],

  "summary": "状況の要約(数値・主体・日時を明示、3〜4行)",

  "key_data": [
    {"label": "前日比", "value": "+1.2%"},
    {"label": "出来高", "value": "通常比1.5倍"}
  ],

  "background": "なぜこのニュースが市場で取り上げられているか。前提知識を最小限補いつつ簡潔に(3〜4行)",

  "market_view": {
    "price_levels": "重要な価格水準(サポート・上値めどなど平易な言葉で)",
    "trend": "トレンドの方向性とモメンタム",
    "drivers": "値動きの主な要因(マクロ・需給・決算など)"
  },

  "scenarios": {
    "base": {"text": "メインシナリオの説明", "probability": "60%"},
    "bull": {"text": "強気シナリオとそのトリガー", "probability": "25%"},
    "bear": {"text": "弱気シナリオとそのトリガー", "probability": "15%"}
  },

  "investment_angle": {
    "long_term": "長期投資・インデックス投資家から見たこのニュースの意味",
    "swing_trade": "数日〜数週間のスイングトレード視点での着眼点",
    "risk_factors": "見落としがちなリスク要因"
  },

  "watch_points": [
    "今後数日で注目すべき経済指標・イベント・関連銘柄"
  ],

  "historical_context": "過去の類似局面と、その後の市場の動き(情報がなければ空文字)",

  "terms_used": ["この記事で登場した専門用語のリスト(例: VIX、イールドカーブ)"]
}"""

# 短縮版フォールバック (Groq失敗時)
SHORT_SYSTEM_PROMPT = """あなたは個人投資家向けアナリストです。以下のJSON形式のみで回答してください。
{
  "headline": "40字以内の見出し",
  "importance": 3,
  "category": "fx_macro",
  "impact": "中立",
  "points": ["要点1", "要点2", "要点3"],
  "summary": "3行の事実要約",
  "key_data": [{"label": "主要指標", "value": "-"}],
  "background": "",
  "market_view": {"price_levels": "", "trend": "", "drivers": ""},
  "scenarios": {
    "base": {"text": "", "probability": "60%"},
    "bull": {"text": "", "probability": "25%"},
    "bear": {"text": "", "probability": "15%"}
  },
  "investment_angle": {"long_term": "", "swing_trade": "", "risk_factors": ""},
  "watch_points": [],
  "historical_context": "",
  "terms_used": []
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
                max_tokens=2000,
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

    # points
    points = data.get("points", [])
    if not isinstance(points, list):
        points = []

    # market_view
    mv = data.get("market_view") or {}
    market_view = {
        "price_levels": (mv.get("price_levels") or ""),
        "trend": (mv.get("trend") or ""),
        "drivers": (mv.get("drivers") or ""),
    }

    # scenarios (new format: {text, probability})
    def _sc_item(x):
        if isinstance(x, dict):
            return {"text": x.get("text", ""), "probability": x.get("probability", "")}
        return {"text": str(x) if x else "", "probability": ""}

    sc = data.get("scenarios") or {}
    scenarios = {
        "base": _sc_item(sc.get("base")),
        "bull": _sc_item(sc.get("bull")),
        "bear": _sc_item(sc.get("bear")),
    }

    # investment_angle
    ia = data.get("investment_angle") or {}
    investment_angle = {
        "long_term": (ia.get("long_term") or ""),
        "swing_trade": (ia.get("swing_trade") or ""),
        "risk_factors": (ia.get("risk_factors") or ""),
    }

    # watch_points
    watch_points = data.get("watch_points", [])
    if not isinstance(watch_points, list):
        watch_points = []

    # terms_used
    terms_used = data.get("terms_used", [])
    if not isinstance(terms_used, list):
        terms_used = []

    return {
        "headline": data.get("headline", title[:40]),
        "importance": max(1, min(5, int(data.get("importance", 3)))),
        "category_ai": data.get("category", ""),
        "impact": impact_label,
        "impact_emoji": impact_emoji,
        "impact_label": impact_label,
        "points": points,
        "summary": (data.get("summary") or summary[:200]),
        "key_data": key_data,
        "background": (data.get("background") or ""),
        "market_view": market_view,
        "scenarios": scenarios,
        "investment_angle": investment_angle,
        "watch_points": watch_points,
        "historical_context": (data.get("historical_context") or ""),
        "terms_used": terms_used,
    }


def _fallback(title: str, summary: str) -> dict:
    return {
        "headline": title[:40],
        "importance": 2,
        "category_ai": "",
        "impact": "中立",
        "impact_emoji": "➡️",
        "impact_label": "中立",
        "points": [],
        "summary": summary[:200] if summary else "要約取得失敗",
        "key_data": [],
        "background": "",
        "market_view": {"price_levels": "", "trend": "", "drivers": ""},
        "scenarios": {
            "base": {"text": "", "probability": "60%"},
            "bull": {"text": "", "probability": "25%"},
            "bear": {"text": "", "probability": "15%"},
        },
        "investment_angle": {"long_term": "", "swing_trade": "", "risk_factors": ""},
        "watch_points": [],
        "historical_context": "",
        "terms_used": [],
    }


def generate_daily_theme(client: Groq, articles: list[dict]) -> str:
    """
    全記事から「本日のマーケット要約」を生成する(中級者向け、200字+カタリスト3点)。
    """
    headlines = "\n".join(
        f"- [{art.get('category', '')}] {art.get('headline', art.get('title', ''))} ({art.get('impact', '中立')})"
        for art in articles[:15]
    )
    prompt = f"""以下は本日の主な金融ニュース見出しです。
{headlines}

投資歴1〜5年の個人投資家向けに、本日のマーケット状況を以下の形式でまとめてください。
JSONではなく、日本語の平文テキストで出力してください。

1行目: 「本日のマーケット要約: [市場環境の一言判定と根拠を1行で]」
続けて3〜4行: 主要市場(米株・日本株・為替・金利)の動きと注目テーマを200字程度で記述。
数値・固有名詞を具体的に。専門用語は初出時に短い補足を添える。感想・曖昧表現は禁止。

最後に空行を挟んで「■ 明日以降の注目ポイント:」という見出しの下に、
意識すべき3点を箇条書き(・)で簡潔に記述してください(各15字程度)。"""

    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "あなたは投資歴1〜5年の個人投資家向けに市況解説を書く経験豊富なアナリストです。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
            max_tokens=512,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        print(f"  [WARN] マーケット要約生成失敗: {e}")
        return ""


def _generate_term_definition(client: Groq, term: str) -> dict | None:
    """用語の定義をLLMで生成して返す。失敗時はNone。"""
    prompt = f"""以下の金融用語について、日本の個人投資家(投資歴1〜5年の中級者)向けに定義を提供してください。
用語: {term}

以下のJSON形式のみで回答してください:
{{
  "category": "マクロ | テクニカル | 個別銘柄 | 制度 | グローバル | その他 のいずれか",
  "reading": "読み仮名(ひらがな/カタカナ)",
  "definition_short": "ひと言定義(30字以内)",
  "definition_full": "詳しい説明(100字程度)",
  "example": "使用例(40字程度)",
  "related": ["関連用語1", "関連用語2"]
}}"""
    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "あなたは金融用語の専門家です。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=400,
            response_format={"type": "json_object"},
        )
        data = json.loads(resp.choices[0].message.content)
        return {
            "category": data.get("category", "その他"),
            "reading": data.get("reading", ""),
            "definition_short": data.get("definition_short", ""),
            "definition_full": data.get("definition_full", ""),
            "example": data.get("example", ""),
            "related": data.get("related", []) if isinstance(data.get("related"), list) else [],
        }
    except Exception as e:
        print(f"  [WARN] 用語定義生成失敗 ({term}): {e}")
        return None


def update_glossary(client: Groq, articles: list[dict]) -> None:
    """
    記事の terms_used を集計し、glossary_base に未登録のものはLLMで定義を生成して
    data/glossary.json に追加する。
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    base_path = DATA_DIR / "glossary_base.json"
    dynamic_path = DATA_DIR / "glossary.json"

    # glossary_base.json を読み込む(キュレーション済みベース)
    base_glossary = {}
    if base_path.exists():
        try:
            base_glossary = json.loads(base_path.read_text(encoding="utf-8"))
        except Exception:
            base_glossary = {}

    # glossary.json を読み込む(動的追加分、新構造かチェック)
    dynamic_glossary = {}
    if dynamic_path.exists():
        try:
            raw = json.loads(dynamic_path.read_text(encoding="utf-8"))
            first_val = next(iter(raw.values()), {})
            if isinstance(first_val, dict) and "definition_short" in first_val:
                dynamic_glossary = raw
        except Exception:
            dynamic_glossary = {}

    # baseで初期化してdynamicでオーバーレイ(dynamicの追加分を保持)
    merged = {**base_glossary, **dynamic_glossary}

    # 全記事の terms_used を収集
    all_terms: set[str] = set()
    for art in articles:
        for term in art.get("terms_used", []):
            if isinstance(term, str) and term.strip():
                all_terms.add(term.strip())

    # 未登録の用語を定義生成
    new_terms_added = 0
    for term in sorted(all_terms):
        if term not in merged:
            print(f"  [GLOSSARY] 新規用語を定義生成中: {term}")
            definition = _generate_term_definition(client, term)
            if definition:
                merged[term] = definition
                new_terms_added += 1
                time.sleep(0.5)  # レート制限対策

    # 保存
    dynamic_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    if new_terms_added > 0:
        print(f"  [GLOSSARY] {new_terms_added}件の新規用語を追加。合計: {len(merged)}件")
    else:
        print(f"  [GLOSSARY] 用語集更新完了。{len(merged)}件")


def summarize(articles: list[dict]) -> tuple[list[dict], str]:
    """
    各記事を Groq で中級者向け分析JSONに変換。featured フラグでトップ7本を選定して返す。
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

    # マーケット要約生成
    print("=== 本日のマーケット要約生成中 ===")
    daily_theme = generate_daily_theme(client, results)
    if daily_theme:
        print("  生成完了\n")
    else:
        print("  生成スキップ\n")

    # 用語集更新
    print("=== 用語集更新中 ===")
    update_glossary(client, results)

    return results, daily_theme
