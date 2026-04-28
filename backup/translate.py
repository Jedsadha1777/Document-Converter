"""Translation: prompts, qwen/gemini batch, Apple Translate.
Shared LLM utils (_protect_segments, _build_batch_user_msg, _parse_batch_json,
_GEMINI_RESPONSE_SCHEMA) ถูก import โดย correct.py ด้วย"""
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from config import (
    APPLE_MIN_INPUT_CHARS,
    APPLE_SHORTCUT_EN,
    APPLE_SHORTCUT_TH,
    GEMINI_API_KEY,
    GEMINI_MODEL,
    GEMINI_TIMEOUT,
    OLLAMA_MODEL_TRANSLATE,
    OLLAMA_URL,
    SPEAKER_SKIP,
    TRANSLATE_BATCH_NUM_CTX,
    TRANSLATE_BATCH_TIMEOUT,
)


# Pattern เรียงจากเฉพาะเจาะจงไปกว้าง — match ก่อนได้ก่อน
_PROTECT_PATTERNS = [
    r"<[^<>]{1,200}>",
    r"https?://[^\s<>\"']+",
    r"www\.[^\s<>\"']+",
    r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
    r"\b[a-zA-Z][a-zA-Z0-9-]*\.(?:com|org|net|io|dev|app|co|edu|gov|info|me|ai|tech|xyz|biz)(?:\.[a-z]{2,3})?\b",
    r"`[^`]+`",
]


def _protect_segments(text: str) -> tuple[str, dict[str, str]]:
    """แทนที่ส่วนที่ไม่ควรแปล (URL/HTML/email/domain/code) ด้วย placeholder
    รูป "X9990X" — Apple Translate มักรักษาตัวเลข + uppercase หลัง preserve"""
    mapping: dict[str, str] = {}
    counter = [0]

    def make_token(value: str) -> str:
        key = f"X{9990 + counter[0]}X"
        counter[0] += 1
        mapping[key] = value
        return key

    out = text
    for pat in _PROTECT_PATTERNS:
        out = re.sub(pat, lambda m: make_token(m.group(0)), out)
    return out, mapping


def _restore_segments(text: str, mapping: dict[str, str]) -> str:
    if not mapping:
        return text
    # ทำหลายรอบในกรณี placeholder ถูก concat แปลก ๆ
    for _ in range(3):
        changed = False
        for key, value in mapping.items():
            if key in text:
                text = text.replace(key, value)
                changed = True
        if not changed:
            break
    return text


THAI_TO_ARABIC = str.maketrans("๐๑๒๓๔๕๖๗๘๙", "0123456789")


def _normalize_numerals(text: str) -> str:
    return text.translate(THAI_TO_ARABIC)


def _has_cjk(s: str) -> bool:
    return any(
        '぀' <= c <= 'ゟ' or
        '゠' <= c <= 'ヿ' or
        '一' <= c <= '鿿' or
        '㐀' <= c <= '䶿'
        for c in s
    )


def _has_thai(s: str) -> bool:
    return any('฀' <= c <= '๿' for c in s)


def _output_has_unwanted_script(target: str, text: str) -> bool:
    if target == "th":
        return _has_cjk(text)
    if target == "en":
        return _has_cjk(text) or _has_thai(text)
    return False


def _digits_changed(orig: str, out: str) -> bool:
    a = "".join(re.findall(r"[0-9]+", orig or ""))
    b = "".join(re.findall(r"[0-9]+", out or ""))
    return a != b


_REFUSAL_PATTERNS_TH = (
    "ไม่ควรแปล", "ไม่เหมาะสม", "ขอรบกวนเปลี่ยน", "กรุณาเปลี่ยน",
    "ไม่สามารถแปล", "ขออภัย", "ละเมิด", "ไม่อาจแปล",
    "ความมั่นคงทางสุขภาพ", "ละเอียดอ่อน",
)
_REFUSAL_PATTERNS_EN = (
    "i cannot", "i can't", "i'm sorry", "i am sorry",
    "inappropriate", "i won't", "i will not", "as an ai",
    "should not translate", "cannot translate", "unable to translate",
    "i refuse", "i'm not able",
)


def _is_refusal(text: str) -> bool:
    if not text:
        return False
    low = text.lower()
    return (
        any(p in text for p in _REFUSAL_PATTERNS_TH)
        or any(p in low for p in _REFUSAL_PATTERNS_EN)
    )


def _join_lines(text: str) -> str:
    """รวมบรรทัดที่ถูกตัดมาจาก OCR. CJK/Thai/Hangul ไม่มี space ระหว่างคำ
    → \\n ระหว่างอักษรเหล่านี้ join เปล่า, มิฉะนั้นใส่ space"""
    if not text:
        return ""

    def is_asian(c: str) -> bool:
        if not c:
            return False
        return (
            '぀' <= c <= 'ゟ' or
            '゠' <= c <= 'ヿ' or
            '一' <= c <= '鿿' or
            '㐀' <= c <= '䶿' or
            '가' <= c <= '힯' or
            '฀' <= c <= '๿'
        )

    text = re.sub(r"\r\n?|\t", "\n", text)
    text = re.sub(r"\n+", "\n", text)

    out: list[str] = []
    for i, ch in enumerate(text):
        if ch == "\n":
            left = next((text[j] for j in range(i - 1, -1, -1) if not text[j].isspace()), "")
            right = next((text[j] for j in range(i + 1, len(text)) if not text[j].isspace()), "")
            sep = "" if (is_asian(left) or is_asian(right)) else " "
            out.append(sep)
        else:
            out.append(ch)
    joined = "".join(out)
    joined = re.sub(r" {2,}", " ", joined)
    return joined.strip()


TRANSLATE_PROMPTS = {
    "th": (
        "Translate the user's text to natural Thai.\n"
        "Output ONLY the Thai translation. No explanation, no quotes, no preamble.\n"
        "Keep the meaning faithful. Do not add or omit information.\n"
        "RULES — STRICTLY FOLLOWED:\n"
        "- The output MUST be in Thai script ONLY.\n"
        "  Allowed characters: Thai (ก-๛), Latin letters (A-Z, a-z) for brand names, "
        "  Arabic digits (0-9), and basic punctuation.\n"
        "  FORBIDDEN in output: ANY Chinese characters (汉字), Japanese hiragana (あいう), "
        "  Japanese katakana (アイウ), or kanji. If you find such characters in your output, "
        "  rewrite them in Thai before responding.\n"
        "  WRONG: 'ชุดจับเอวและเสื้อผ้าที่มี图案ตระกูล' (contains 图案).\n"
        "  RIGHT: 'ชุดจับเอวและเสื้อผ้าที่มีลายตระกูล' (pure Thai).\n"
        "- NUMBERS — ABSOLUTE RULE: NEVER translate, modify, convert, or 'normalize' any number.\n"
        "  Every digit (0-9) in the input MUST appear EXACTLY THE SAME in the output, in the SAME ORDER.\n"
        "  NEVER convert to Thai numerals (no ๐๑๒๓๔๕๖๗๘๙).\n"
        "  NEVER convert calendars (ค.ศ. 1930 stays ค.ศ. 1930, NOT พ.ศ. 2473).\n"
        "  NEVER round, simplify, or change units (5 km stays '5 km', not '5000 m').\n"
        "  NEVER convert digits to words ('25' stays '25', NOT 'ยี่สิบห้า').\n"
        "  NEVER write a translation that does not contain the same digits as the input.\n"
        "  This applies to: years, dates, times, prices, percentages, phone numbers, "
        "  measurements, item counts, list numbers, version numbers — every numeric token.\n"
        "- KATAKANA WORDS (CRITICAL — most common mistake):\n"
        "  ALL katakana → transliterate by SOUND into Thai script. NEVER translate by meaning.\n"
        "  This applies to EVERYTHING in katakana: names, brand names, loanwords, foreign words.\n"
        "  WRONG examples (do NOT do this):\n"
        "    ブレザー → 'ชุดจับเอว' / 'เสื้อสูท' (translating by meaning — FORBIDDEN)\n"
        "    タータンチェック → 'ลายสก๊อต' (translating by meaning — FORBIDDEN)\n"
        "    スカート → 'กระโปรง' (translating by meaning — FORBIDDEN)\n"
        "    ミノル → 'ผลไม้' (translating name by meaning — FORBIDDEN)\n"
        "    カメラ → 'กล้อง' (translating loanword — FORBIDDEN)\n"
        "  RIGHT examples (do this):\n"
        "    ブレザー → 'เบลเซอร์' (sound)\n"
        "    タータンチェック → 'ทาร์ทันเช็ค' (sound)\n"
        "    スカート → 'สเกิร์ต' (sound)\n"
        "    ミノル → 'มิโนรุ' (sound)\n"
        "    シロタ → 'ชิโรตะ' (sound)\n"
        "    ヤマダ タロウ → 'ยามาดะ ทาโร่' (sound)\n"
        "    ヤクลト → 'ยาคูลท์' (established Thai brand form is OK)\n"
        "  Rule of thumb: katakana looks/reads like a foreign word, so the Thai must also "
        "  read like that foreign word's sound, never replaced with a native Thai equivalent.\n"
        "- For Japanese names written in kanji, transliterate the reading INTO THAI script; "
        "  never keep the kanji and never translate the meaning.\n"
        "If the input is already Thai, return it unchanged."
    ),
    "en": (
        "Translate the user's text to natural English.\n"
        "Output ONLY the English translation. No explanation, no quotes, no preamble.\n"
        "Keep the meaning faithful. Do not add or omit information.\n"
        "RULES — STRICTLY FOLLOWED:\n"
        "- The output MUST be in English (Latin script) ONLY.\n"
        "  FORBIDDEN: ANY Chinese, Japanese, Thai, Korean characters in the output.\n"
        "- NUMBERS — ABSOLUTE RULE: NEVER translate, modify, convert, or normalize any number.\n"
        "  Every digit (0-9) in the input MUST appear EXACTLY THE SAME in the output, in the SAME ORDER.\n"
        "  NEVER convert digits to words ('25' stays '25', NOT 'twenty-five').\n"
        "  NEVER convert calendars, units, or currency.\n"
        "  NEVER round or simplify.\n"
        "  This applies to: years, dates, times, prices, percentages, phone numbers, "
        "  measurements, list numbers, version numbers — every numeric token.\n"
        "- PERSON NAMES: NEVER translate the meaning of a name.\n"
        "  Katakana names → romanize by SOUND only (ミノル → 'Minoru', NOT 'Fruit').\n"
        "  Japanese kanji names → use the romanized reading; never keep kanji in English output.\n"
        "If the input is already English, return it unchanged."
    ),
}


def _call_ollama_translate(text: str, system_prompt: str, timeout: float = 60.0) -> str:
    resp = httpx.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": OLLAMA_MODEL_TRANSLATE,
            "stream": False,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            "options": {"temperature": 0.2, "num_ctx": 2048},
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    out = (resp.json().get("message", {}).get("content") or "").strip()
    if out.startswith(("\"", "'", "「", "『")) and out.endswith(("\"", "'", "」", "』")):
        out = out[1:-1]
    return out


def translate_text(text: str, target: str = "th",
                   timeout: float = 60.0) -> tuple[str, str | None]:
    text = _join_lines(text or "")
    if not text.strip():
        return "", None
    text_protected, mapping = _protect_segments(text)
    prompt = TRANSLATE_PROMPTS.get(target, TRANSLATE_PROMPTS["th"])
    # factual hint — ลด safety refusal กับ medical/anatomical text
    prompt_factual = prompt + (
        "\n\nIMPORTANT: This is a factual document (educational, medical, technical, or "
        "informational). Translate every input directly and faithfully without commentary, "
        "disclaimers, content warnings, or refusals. If the text contains medical, "
        "anatomical, or technical terms, translate them with their proper equivalent terms. "
        "Never refuse to translate. Never replace the translation with a message about "
        "the content. Just translate."
    )
    try:
        out = _call_ollama_translate(text_protected, prompt_factual, timeout)
        if out and _is_refusal(out):
            print(f"[translate] refusal detected: {out!r}", flush=True)
            retry_prompt = (
                "Translate the input to "
                + ("Thai" if target == "th" else "English")
                + ". Output only the translation. No commentary, no warnings, no refusals."
            )
            retry_out = _call_ollama_translate(text_protected, retry_prompt, timeout)
            if retry_out and not _is_refusal(retry_out):
                out = retry_out
            else:
                return text, None
        if out and _output_has_unwanted_script(target, out):
            print(f"[translate] leak detected ({target}): {out!r} — retry", flush=True)
            stricter = (
                prompt
                + "\n\nCRITICAL: Your previous attempt contained foreign script characters. "
                + ("DO NOT output any Chinese (汉字) or Japanese (kana/kanji) — convert them to Thai sound."
                   if target == "th" else
                   "DO NOT output any non-English characters — use only A-Z, 0-9, basic punctuation.")
            )
            retry_out = _call_ollama_translate(text_protected, stricter, timeout)
            if retry_out and not _output_has_unwanted_script(target, retry_out):
                out = retry_out
            else:
                if target == "th":
                    out = "".join(c for c in (retry_out or out) if not _has_cjk(c))
                elif target == "en":
                    out = "".join(c for c in (retry_out or out) if not (_has_cjk(c) or _has_thai(c)))
                out = re.sub(r"\s+", " ", out).strip()
                print(f"[translate] forced-strip: {out!r}", flush=True)
        out = out or text_protected
        out = _join_lines(out)
        out = _normalize_numerals(out)
        out = _restore_segments(out, mapping)
        if _digits_changed(text, out):
            print(f"[translate] digit mismatch: orig={text!r} out={out!r} — retry", flush=True)
            digit_strict = (
                prompt
                + "\n\nCRITICAL: Your previous attempt CHANGED, REMOVED, or REORDERED numbers. "
                "Every digit (0-9) in the input must appear EXACTLY THE SAME and in the SAME ORDER in the output. "
                "Do NOT translate, convert, round, or change any number."
            )
            retry_out = _call_ollama_translate(text_protected, digit_strict, timeout)
            retry_out = _normalize_numerals(retry_out or "")
            retry_out = _restore_segments(retry_out, mapping)
            if retry_out and not _digits_changed(text, retry_out) and \
                    not _output_has_unwanted_script(target, retry_out):
                out = retry_out
            else:
                print(f"[translate] digit retry failed, returning original", flush=True)
                return text, None
        return out, None
    except Exception as e:
        return text, str(e)


def _build_batch_user_msg(texts: list[str],
                          speakers: list[str | None] | None = None
                          ) -> tuple[str, list[dict]]:
    """[N]-prefixed lines (text format ประหยัด token กว่า JSON).
    speakers (optional): tag {speaker=X} หลัง [N] เพื่อ persona voice"""
    lines = []
    per_item = []
    for i, t in enumerate(texts, 1):
        clean = _join_lines(t or "")
        protected, mapping = _protect_segments(clean)
        protected = re.sub(r"\s*\n+\s*", " ", protected).strip()
        sp = (speakers[i - 1] if speakers and i - 1 < len(speakers) else None)
        prefix = f"[{i}]"
        if sp:
            prefix = f"[{i}|speaker={sp}]"
        lines.append(f"{prefix} {protected}")
        per_item.append({"original": t, "protected": protected, "mapping": mapping})
    return "\n".join(lines), per_item


def _parse_batch_json(raw: str, n: int) -> list[str | None]:
    """ทนต่อ id ที่ขาด/เกินช่วง — ทุก case ที่ผิด schema → mark missing"""
    result: list[str | None] = [None] * n
    try:
        obj = json.loads(raw)
    except Exception:
        return result
    items = obj.get("items") if isinstance(obj, dict) else None
    if not isinstance(items, list):
        return result
    for item in items:
        if not isinstance(item, dict):
            continue
        idx = item.get("id")
        text = item.get("text")
        if not isinstance(idx, int) or not isinstance(text, str):
            continue
        if 1 <= idx <= n:
            result[idx - 1] = text
    return result


def _build_characters_section(characters: list[dict] | None) -> str:
    """character profiles section. ส่งข้อมูลตรง ๆ ไม่ตีความ ไม่ map"""
    if not characters:
        return ""
    lines = []
    lines.append("\n\nCHARACTER PROFILES")
    lines.append("Each input line tagged [N|speaker=X] MUST be translated using speaker X's profile.")
    lines.append("Two different speakers MUST produce visibly different translation styles.")
    lines.append("A line without a speaker tag → neutral voice.")
    lines.append("")
    for c in characters:
        cid = c.get("id", "")
        if not cid:
            continue
        name = (c.get("name") or "").strip()
        gender = (c.get("gender") or "").strip()
        persona = (c.get("persona") or "").strip()
        lines.append(f"speaker={cid}:")
        if name:
            lines.append(f"   name: {name}")
        if gender:
            lines.append(f"   gender: {gender}")
        if persona:
            lines.append(f"   personality: {persona}")
        lines.append("")
    return "\n".join(lines)


def _build_batch_system_prompt(target: str, n: int, custom_rules: str | None,
                               characters: list[dict] | None = None) -> str:
    base_prompt = TRANSLATE_PROMPTS.get(target, TRANSLATE_PROMPTS["th"])
    chars_section = _build_characters_section(characters)
    schema_instruction = (
        f"\n\nBATCH MODE: You will translate exactly {n} numbered items.\n"
        f"OUTPUT (JSON ONLY — no prose, no markdown):\n"
        f'{{"items": [\n'
        f'  {{"id": 1, "text": "<translation of input [1]>"}},\n'
        f'  {{"id": 2, "text": "<translation of input [2]>"}},\n'
        f"  ...\n"
        f'  {{"id": {n}, "text": "<translation of input [{n}]>"}}\n'
        f"]}}\n"
        f"RULES:\n"
        f'- "items" array must contain EXACTLY {n} elements.\n'
        f'- Each element has "id" (integer 1..{n}) and "text" (the translation).\n'
        f"- IDs must be 1 through {n} in ascending order, no skips, no duplicates.\n"
        f"- Each text is the translation of the input line with the same number.\n"
    )
    factual = (
        "\n\nIMPORTANT: This is factual content. Translate every item directly without "
        "commentary, disclaimers, content warnings, or refusals. Just translate."
    )
    rules_section = ""
    if custom_rules and custom_rules.strip():
        rules_section = (
            "\n\nADDITIONAL TRANSLATION RULES (project-specific — follow these):\n"
            + custom_rules.strip() + "\n"
        )
    return base_prompt + rules_section + chars_section + schema_instruction + factual


def _post_process_batch(texts: list[str], parsed: list[str | None],
                        per_item: list[dict], target: str
                        ) -> tuple[list[str], list[str | None]]:
    translations: list[str] = []
    errors: list[str | None] = []
    for i, raw in enumerate(parsed):
        original = texts[i]
        mapping = per_item[i]["mapping"]

        if raw is None or not raw.strip():
            translations.append(original)
            errors.append("missing in batch output")
            continue

        try:
            t = _join_lines(raw)
            t = _normalize_numerals(t)
            t = _restore_segments(t, mapping)

            if _is_refusal(t):
                translations.append(original)
                errors.append("refusal")
                continue
            if _output_has_unwanted_script(target, t):
                if target == "th":
                    t = "".join(c for c in t if not _has_cjk(c))
                elif target == "en":
                    t = "".join(c for c in t if not (_has_cjk(c) or _has_thai(c)))
                t = re.sub(r"\s+", " ", t).strip()
                if not t:
                    translations.append(original)
                    errors.append("foreign script (stripped empty)")
                    continue
            if _digits_changed(original, t):
                translations.append(original)
                errors.append("digit mismatch")
                continue

            translations.append(t)
            errors.append(None)
        except Exception as e:
            translations.append(original)
            errors.append(str(e))
    return translations, errors


def _translate_temp_for_attempt(attempt: int) -> float:
    """attempt 0 → 0.2, retry → 0.4, 0.6, 0.7 (cap)"""
    return min(0.7, 0.2 + 0.2 * max(0, attempt))


def _translate_batch_qwen(texts: list[str], target: str,
                          custom_rules: str | None,
                          timeout: float, attempt: int = 0,
                          speakers: list[str | None] | None = None,
                          characters: list[dict] | None = None,
                          ) -> tuple[list[str], list[str | None]]:
    n = len(texts)
    user_msg, per_item = _build_batch_user_msg(texts, speakers)
    system_prompt = _build_batch_system_prompt(target, n, custom_rules, characters)

    try:
        resp = httpx.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL_TRANSLATE,
                "stream": False,
                "format": "json",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_msg},
                ],
                "options": {
                    "temperature": _translate_temp_for_attempt(attempt),
                    "num_ctx": TRANSLATE_BATCH_NUM_CTX,
                },
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        raw_out = (resp.json().get("message", {}).get("content") or "").strip()
        parsed = _parse_batch_json(raw_out, n)
    except Exception as e:
        return list(texts), [str(e)] * n

    return _post_process_batch(texts, parsed, per_item, target)


_GEMINI_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "text": {"type": "string"},
                },
                "required": ["id", "text"],
            },
        },
    },
    "required": ["items"],
}


def _translate_batch_gemini(texts: list[str], target: str,
                            custom_rules: str | None,
                            timeout: float, attempt: int = 0,
                            speakers: list[str | None] | None = None,
                            characters: list[dict] | None = None,
                            ) -> tuple[list[str], list[str | None]]:
    n = len(texts)

    if not GEMINI_API_KEY:
        return list(texts), ["GEMINI_API_KEY ยังไม่ตั้งใน .env"] * n

    try:
        from google import genai
        from google.genai import types as gtypes
    except ImportError as e:
        return list(texts), [f"google-genai ยังไม่ติดตั้ง: {e}"] * n

    user_msg, per_item = _build_batch_user_msg(texts, speakers)
    system_prompt = _build_batch_system_prompt(target, n, custom_rules, characters)

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[user_msg],
            config=gtypes.GenerateContentConfig(
                system_instruction=system_prompt,
                response_mime_type="application/json",
                response_schema=_GEMINI_RESPONSE_SCHEMA,
                temperature=_translate_temp_for_attempt(attempt),
            ),
        )
        raw_out = (response.text or "").strip()
        parsed = _parse_batch_json(raw_out, n)
    except Exception as e:
        return list(texts), [f"gemini: {e}"] * n

    return _post_process_batch(texts, parsed, per_item, target)


def _strip_markdown_fence(raw: str) -> str:
    """LLM web UIs (Gemini/ChatGPT) มัก wrap JSON ใน ```json ... ```"""
    s = raw.strip()
    if s.startswith("```"):
        s = re.sub(r"^```\w*\s*\n?", "", s)
        s = re.sub(r"\n?```\s*$", "", s)
    # ถ้ามี prose ก่อน/หลัง — ดึง object แรกที่เจอ
    if not s.startswith("{"):
        i = s.find("{")
        j = s.rfind("}")
        if i >= 0 and j > i:
            s = s[i:j + 1]
    return s.strip()


def apply_manual_batch(texts: list[str], target: str, raw_response: str,
                       speakers: list[str | None] | None = None,
                       characters: list[dict] | None = None,
                       ) -> tuple[list[str], list[str | None]]:
    """Parse LLM response ที่ user paste manual + post-process เหมือน batch ปกติ.
    ใช้ filter + per_item mapping เดียวกับ translate_batch เพื่อให้ guard ทำงานครบ"""
    n = len(texts)
    translations: list[str] = ["" for _ in range(n)]
    errors: list[str | None] = [None] * n

    work_idxs: list[int] = []
    work_texts: list[str] = []
    work_speakers: list[str | None] = []
    for i, t in enumerate(texts):
        if not (t and t.strip()):
            continue
        sp = speakers[i] if speakers and i < len(speakers) else None
        if sp == SPEAKER_SKIP:
            continue
        work_idxs.append(i)
        work_texts.append(t)
        work_speakers.append(sp)

    if not work_texts:
        return translations, errors

    has_speaker = any(s for s in work_speakers)
    eff_speakers = work_speakers if has_speaker else None
    _, per_item = _build_batch_user_msg(work_texts, eff_speakers)

    cleaned = _strip_markdown_fence(raw_response)
    parsed = _parse_batch_json(cleaned, len(work_texts))
    sub_t, sub_e = _post_process_batch(work_texts, parsed, per_item, target)

    for j, orig_idx in enumerate(work_idxs):
        translations[orig_idx] = sub_t[j]
        errors[orig_idx] = sub_e[j]
    return translations, errors


def translate_batch(texts: list[str], target: str = "th",
                    engine: str = "qwen",
                    custom_rules: str | None = None,
                    timeout: float | None = None,
                    attempt: int = 0,
                    speakers: list[str | None] | None = None,
                    characters: list[dict] | None = None,
                    ) -> tuple[list[str], list[str | None]]:
    if not texts:
        return [], []

    n = len(texts)
    translations: list[str] = ["" for _ in range(n)]
    errors: list[str | None] = [None] * n

    work_idxs: list[int] = []
    work_texts: list[str] = []
    work_speakers: list[str | None] = []
    skipped_user = 0
    for i, t in enumerate(texts):
        if not (t and t.strip()):
            continue
        sp = speakers[i] if speakers and i < len(speakers) else None
        if sp == SPEAKER_SKIP:
            skipped_user += 1
            continue
        work_idxs.append(i)
        work_texts.append(t)
        work_speakers.append(sp)

    if not work_texts:
        if skipped_user:
            print(f"[translate-batch] user skipped {skipped_user} (ไม่แปล)", flush=True)
        return translations, errors

    has_speaker = any(s for s in work_speakers)
    eff_speakers = work_speakers if has_speaker else None
    if has_speaker and characters:
        used_ids = {s for s in work_speakers if s}
        eff_chars = [c for c in characters if c.get("id") in used_ids]
    else:
        eff_chars = None

    if engine == "gemini":
        eff_timeout = timeout if timeout is not None else GEMINI_TIMEOUT
        sub_t, sub_e = _translate_batch_gemini(
            work_texts, target, custom_rules, eff_timeout, attempt,
            speakers=eff_speakers, characters=eff_chars,
        )
    else:
        eff_timeout = timeout if timeout is not None else TRANSLATE_BATCH_TIMEOUT
        sub_t, sub_e = _translate_batch_qwen(
            work_texts, target, custom_rules, eff_timeout, attempt,
            speakers=eff_speakers, characters=eff_chars,
        )

    for j, orig_idx in enumerate(work_idxs):
        translations[orig_idx] = sub_t[j]
        errors[orig_idx] = sub_e[j]

    n_ok = sum(1 for e in errors if e is None)
    print(
        f"[translate-batch] engine={engine} n={n} sent={len(work_texts)} "
        f"skipped_user={skipped_user} ok={n_ok} fail={n - n_ok} attempt={attempt} speakers={has_speaker}",
        flush=True,
    )
    return translations, errors


# ── Apple Translate (macOS Shortcuts CLI) ──

def _shortcuts_available() -> bool:
    return shutil.which("shortcuts") is not None


def _list_shortcuts() -> set[str]:
    if not _shortcuts_available():
        return set()
    try:
        r = subprocess.run(
            ["shortcuts", "list"],
            capture_output=True, text=True, timeout=5,
        )
        return {ln.strip() for ln in r.stdout.splitlines() if ln.strip()}
    except Exception:
        return set()


def apple_translate_text(text: str, target: str = "th") -> tuple[str, str | None]:
    text = _join_lines(text or "")
    if not text:
        return "", None

    stripped = text.strip()
    if len(stripped) < APPLE_MIN_INPUT_CHARS:
        return text, None

    if not _shortcuts_available():
        return text, "ไม่พบ shortcuts CLI (ต้องใช้ macOS 12+)"

    name = APPLE_SHORTCUT_TH if target == "th" else APPLE_SHORTCUT_EN
    if name not in _list_shortcuts():
        return text, (
            f"ยังไม่ได้สร้าง Shortcut '{name}' — ดูคำแนะนำที่ /apple-translate-setup"
        )

    text_to_send, mapping = _protect_segments(text)

    in_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as fin:
            fin.write(text_to_send)
            in_path = fin.name
        r = subprocess.run(
            ["shortcuts", "run", name, "-i", in_path],
            capture_output=True, text=True, timeout=60,
        )
        out = (r.stdout or "").strip()
        stderr = (r.stderr or "").strip()
        unsupported = (
            "not be supported" in stderr
            or "language of the text" in stderr
            or ("Translate." in stderr and "supported" in stderr)
        )
        if r.returncode != 0 or not out:
            if unsupported:
                print(f"[apple] unsupported (skip): {text!r}", flush=True)
                return text, None
            return text, (stderr or f"shortcuts exit {r.returncode}")
        out = _restore_segments(out, mapping)
        out = _normalize_numerals(out)
        return out or text, None
    except subprocess.TimeoutExpired:
        return text, "shortcuts timeout"
    except Exception as e:
        return text, str(e)
    finally:
        if in_path:
            try:
                Path(in_path).unlink(missing_ok=True)
            except Exception:
                pass
