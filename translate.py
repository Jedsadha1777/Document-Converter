"""Translation: prompts, qwen/gemini batch, Apple Translate.
Shared LLM utils (_protect_segments, _build_batch_user_msg, _parse_batch_json,
_GEMINI_RESPONSE_SCHEMA) ถูก import โดย correct.py ด้วย"""
import json
import re
import shutil
import subprocess
import tempfile
import unicodedata
from pathlib import Path

import httpx

from config import (
    APPLE_MIN_INPUT_CHARS,
    APPLE_SHORTCUT_EN,
    APPLE_SHORTCUT_JA,
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


def _normalize_numerals(text: str) -> str:
    """แปลงเลขทุก script (Thai ๐-๙, full-width ０-９, Arabic-Indic ٠-٩,
    Devanagari ०-९ ฯลฯ) → ASCII 0-9 ผ่าน Unicode standard digit value"""
    if not text:
        return text
    out = []
    for c in text:
        if c.isdecimal():
            try:
                out.append(str(unicodedata.digit(c)))
                continue
            except (TypeError, ValueError):
                pass
        out.append(c)
    return "".join(out)


def _digit_runs(text: str) -> list[str]:
    """ดึง run ของ digit (ตามที่ Unicode จัดเป็น decimal digit) — keep run boundary
    เช่น '5km 3miles' → ['5','3'] vs '53cm' → ['53'] (ไม่ปนกัน)"""
    if not text:
        return []
    runs: list[list[str]] = []
    cur: list[str] = []
    for c in text:
        if c.isdecimal():
            try:
                cur.append(str(unicodedata.digit(c)))
                continue
            except (TypeError, ValueError):
                pass
        if cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return ["".join(r) for r in runs]


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
    if target == "ja":
        return _has_thai(text)
    return False


def _detect_source_language(texts: str | list[str]) -> str | None:
    """Pick a source language code ('ja'/'th'/'en') for prompt selection.
    Any CJK kana/kanji → 'ja' (JP rules matter even for mixed text).
    Else 'th' if Thai dominates Latin, 'en' if Latin only, None if no script chars."""
    if isinstance(texts, str):
        texts = [texts]
    cjk = thai = latin = 0
    for t in texts:
        if not t:
            continue
        for c in t:
            if _has_cjk(c):
                cjk += 1
            elif _has_thai(c):
                thai += 1
            elif c.isascii() and c.isalpha():
                latin += 1
    if cjk > 0:
        return "ja"
    if thai > 0 and thai >= latin:
        return "th"
    if latin > 0:
        return "en"
    return None


def _digits_changed(orig: str, out: str) -> bool:
    """เทียบ run-by-run — ป้องกันเคส '5km 3miles' (runs=['5','3']) ปนกับ '53cm' (runs=['53']).
    ใช้ Unicode standard decimal digit value → ครอบ Thai/JP/Arabic-Indic/Devanagari/Lao ฯลฯ"""
    return _digit_runs(orig or "") != _digit_runs(out or "")


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
    "ja": (
        "Translate the user's text to natural Japanese, following the JTF Style Guide for "
        "Translators Working into Japanese (Ver. 1.5).\n"
        "Output ONLY the Japanese translation. No explanation, no quotes, no preamble.\n"
        "Keep the meaning faithful. Do not add or omit information.\n"
        "RULES (per JTF Style Guide):\n"
        "- Script (JTF §2.1): use hiragana, katakana, and kanji listed in the Jōyō Kanji "
        "Hyō (Cabinet Notification No. 2, 2010-11-30). Common business kanji not in the "
        "table (聡明, 推敲, 莫大, 罫線, 梱包, etc.) are also acceptable. If uncertain "
        "whether a character is a Japanese kanji, use hiragana. Do NOT output "
        "Chinese-only simplified or traditional characters (这, 们, 個, 麼, 沒, 來, 國, "
        "etc.) — replace with the Japanese kanji or with hiragana.\n"
        "- Punctuation (JTF §1.2): use double-byte 。 and 、 inside Japanese text. Use "
        "single-byte ASCII (.) and (,) only inside Latin-script proper nouns and numbers "
        "(e.g., '785,105'; '12.5'). Do not mix single-byte . , inside Japanese prose.\n"
        "- Numbers (JTF §2.2.2 + §2.1.8): use single-byte Arabic numerals for quantities, "
        "things that can be counted, and ordinal numerals. Use kanji numerals only for "
        "set phrases / fixed expressions (世界一, 一時的, 一部分, 第三者, 一種の, 数百倍, "
        "二次関数, 四捨五入, 四角い, 五大陸).\n"
        "- ABSOLUTE NUMBER PRESERVATION: every digit (0–9) in the input MUST appear "
        "EXACTLY the same and in the SAME ORDER in the output. Never convert Arabic "
        "digits to kanji numerals (do NOT write '25' as 二十五). Never convert calendar "
        "systems: a Western year stays a Western year ('1930' stays '1930'); never add "
        "or invent 令和/平成/昭和/西暦/紀元前 prefixes the input did not have. If the "
        "input has 令和7年, keep it; if the input has 2025, keep it. Never round, change "
        "units, or spell digits as words (no にじゅうご).\n"
        "- Number positioning (JTF §2.1.10): comma every 3 digits and a period for "
        "decimals (36,333.333). Commas may be omitted for years and short codes "
        "(2013, 11030).\n"
        "- Counters (JTF §2.2.3): write the counter with hiragana か (3か月, 10か所, "
        "5か年計画), not ヵ / カ / ヶ / 箇.\n"
        "- Katakana (JTF §2.1.5–2.1.7): use double-byte katakana. Keep the chōon at the "
        "end of katakana loanwords (コンピューター, ユーザー, プリンター, タイマー — "
        "not コンピュータ, ユーザ). Separate katakana compound words with nakaguro (・) "
        "or a single-byte space.\n"
        "- Foreign / Thai loanwords and names: transliterate by SOUND into katakana "
        "(Smith → スミス, Microsoft → マイクロソフト). Never translate a name by meaning. "
        "Established Latin-script brand names (Microsoft, Google, iPhone) may stay in "
        "Latin script when that is the conventional Japanese form.\n"
        "- Style: pick keitai (ですます) or jōtai (である) and stay consistent within the "
        "translation; do not mix.\n"
        "- Forbidden in output: Thai script (ก-๛) and Korean Hangul. If the model is "
        "about to emit a Chinese-only character, write hiragana instead.\n"
        "If the input is already Japanese, return it unchanged."
    ),
}


# Source-tailored prompts — picked when the input batch is clearly mono-script
# (e.g., pure English → Thai). Trims the JP-source-specific rules (katakana
# transliteration, kanji-name handling, Chinese-leak guards) that bloat the JSON.
# Fallback for unknown / mixed / Japanese source is TRANSLATE_PROMPTS above.
TRANSLATE_PROMPTS_BY_PAIR = {
    ("en", "th"): (
        "Translate the user's text from English to natural Thai.\n"
        "Output ONLY the Thai translation. No explanation, no quotes, no preamble.\n"
        "Keep the meaning faithful. Do not add or omit information.\n"
        "RULES — STRICTLY FOLLOWED:\n"
        "- The output MUST be in Thai script ONLY.\n"
        "  Allowed: Thai (ก-๛), Latin letters (A-Z, a-z) for brand names, "
        "  Arabic digits (0-9), and basic punctuation.\n"
        "  FORBIDDEN: any non-Thai script in the output.\n"
        "- NUMBERS — ABSOLUTE RULE: every digit (0-9) in the input MUST appear "
        "  EXACTLY THE SAME and in the SAME ORDER in the output.\n"
        "  NEVER convert to Thai numerals (no ๐๑๒๓๔๕๖๗๘๙).\n"
        "  NEVER convert calendars, units, or currency.\n"
        "  NEVER round, simplify, or spell digits as words ('25' stays '25', NOT 'ยี่สิบห้า').\n"
        "  Applies to: years, dates, times, prices, percentages, phone numbers, "
        "  measurements, list/version numbers — every numeric token.\n"
        "- PROPER NOUNS / NAMES: transliterate by sound into Thai (Smith → สมิธ). "
        "  Established Latin-script brand names (Microsoft, Google, iPhone) may "
        "  stay in Latin script when that is the conventional form.\n"
        "If the input is already Thai, return it unchanged."
    ),
    ("th", "en"): (
        "Translate the user's text from Thai to natural English.\n"
        "Output ONLY the English translation. No explanation, no quotes, no preamble.\n"
        "Keep the meaning faithful. Do not add or omit information.\n"
        "RULES — STRICTLY FOLLOWED:\n"
        "- Output MUST be in English (Latin script) ONLY.\n"
        "  FORBIDDEN: any non-Latin script in the output.\n"
        "- NUMBERS — ABSOLUTE RULE: every digit (0-9) in the input MUST appear "
        "  EXACTLY THE SAME and in the SAME ORDER in the output.\n"
        "  NEVER convert digits to words ('25' stays '25', NOT 'twenty-five').\n"
        "  NEVER convert calendars, units, or currency.\n"
        "  NEVER round or simplify.\n"
        "  Applies to: years, dates, times, prices, percentages, phone numbers, "
        "  measurements, list/version numbers — every numeric token.\n"
        "- PROPER NOUNS / THAI NAMES: romanize by sound (สมชาย → 'Somchai'). "
        "  Never translate the meaning of a name.\n"
        "If the input is already English, return it unchanged."
    ),
}


def _resolve_prompt(source: str | None, target: str) -> str:
    """Pick source-tailored prompt if available, else fall back to the universal one."""
    if source:
        pair_prompt = TRANSLATE_PROMPTS_BY_PAIR.get((source, target))
        if pair_prompt:
            return pair_prompt
    return TRANSLATE_PROMPTS.get(target, TRANSLATE_PROMPTS["th"])


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
    source = _detect_source_language(text)
    prompt = _resolve_prompt(source, target)
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
            target_name = {"th": "Thai", "ja": "Japanese"}.get(target, "English")
            retry_prompt = (
                f"Translate the input to {target_name}. "
                "Output only the translation. No commentary, no warnings, no refusals."
            )
            retry_out = _call_ollama_translate(text_protected, retry_prompt, timeout)
            if retry_out and not _is_refusal(retry_out):
                out = retry_out
            else:
                return text, None
        if out and _output_has_unwanted_script(target, out):
            print(f"[translate] leak detected ({target}): {out!r} — retry", flush=True)
            if target == "th":
                strict_extra = "DO NOT output any Chinese (汉字) or Japanese (kana/kanji) — convert them to Thai sound."
            elif target == "ja":
                strict_extra = "DO NOT output any Thai (ก-๛) or Hangul characters — use only Japanese script (hiragana/katakana/kanji), Latin letters, and digits."
            else:
                strict_extra = "DO NOT output any non-English characters — use only A-Z, 0-9, basic punctuation."
            stricter = prompt + "\n\nCRITICAL: Your previous attempt contained foreign script characters. " + strict_extra
            retry_out = _call_ollama_translate(text_protected, stricter, timeout)
            if retry_out and not _output_has_unwanted_script(target, retry_out):
                out = retry_out
            else:
                if target == "th":
                    out = "".join(c for c in (retry_out or out) if not _has_cjk(c))
                elif target == "en":
                    out = "".join(c for c in (retry_out or out) if not (_has_cjk(c) or _has_thai(c)))
                elif target == "ja":
                    out = "".join(c for c in (retry_out or out) if not _has_thai(c))
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


def _is_translatable(text: str | None) -> bool:
    """text มีตัวอักษร/ตัวเลขจริงไหม — คัดกรอง OCR garbage (dots-only `．．．．．．`, ellipsis, ฯลฯ)"""
    if not text:
        return False
    s = text.strip()
    if not s:
        return False
    return any(c.isalnum() for c in s)


def _build_batch_user_msg(texts: list[str],
                          speakers: list[str | None] | None = None,
                          id_start: int = 1,
                          ids: list[int] | None = None,
                          ) -> tuple[str, list[dict]]:
    """[N]-prefixed lines (text format ประหยัด token กว่า JSON).
    speakers (optional): tag {speaker=X} หลัง [N] เพื่อ persona voice.
    id_start: chunk-aware numbering สำหรับเคส ids ติดกัน
    ids (optional): explicit per-text id list — รองรับ sparse / row id ตามจริง.
    text ที่ไม่มีตัวอักษร/ตัวเลข (dots-only) ส่งเป็น empty `[N] ` กัน LLM แปล junk"""
    lines = []
    per_item = []
    for i, t in enumerate(texts):
        sp = (speakers[i] if speakers and i < len(speakers) else None)
        # SKIP / dots-only / empty → ส่ง content ว่าง (ประหยัด token, LLM ไม่แปล junk)
        if sp == SPEAKER_SKIP or not _is_translatable(t):
            protected = ""
            mapping = {}
        else:
            clean = _join_lines(t or "")
            protected, mapping = _protect_segments(clean)
            protected = re.sub(r"\s*\n+\s*", " ", protected).strip()
        gid = ids[i] if ids else (id_start + i)
        prefix = f"[{gid}]"
        if sp and sp != SPEAKER_SKIP:
            prefix = f"[{gid}|speaker={sp}]"
        lines.append(f"{prefix} {protected}")
        per_item.append({"original": t, "protected": protected, "mapping": mapping})
    return "\n".join(lines), per_item


def _coerce_int_id(v) -> int | None:
    """LLM อาจส่ง id เป็น string ('9'), float (9.0), หรือ int ก็ได้ — coerce เป็น int.
    bool ถือว่าไม่ใช่ id (Python: bool is subclass of int)"""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v) if v.is_integer() else None
    if isinstance(v, str):
        try:
            return int(v.strip(), 10)
        except (ValueError, TypeError):
            return None
    return None


def _parse_batch_json(raw: str, n: int, id_start: int = 1,
                      ids: list[int] | None = None) -> list[str | None]:
    """ids: optional explicit list — รับเฉพาะ id ที่อยู่ใน list. ถ้าไม่ใส่ → ช่วง [id_start, id_start+n-1].
    id ใน items รองรับทั้ง int และ string-of-int (LLM web UI ส่ง "9" บ่อย)"""
    result: list[str | None] = [None] * n
    try:
        obj = json.loads(raw)
    except Exception:
        return result
    items = obj.get("items") if isinstance(obj, dict) else None
    if not isinstance(items, list):
        return result
    if ids:
        id_to_pos = {gid: pos for pos, gid in enumerate(ids)}
        for item in items:
            if not isinstance(item, dict):
                continue
            idx = _coerce_int_id(item.get("id"))
            text = item.get("text")
            if idx is None or not isinstance(text, str):
                continue
            pos = id_to_pos.get(idx)
            if pos is not None:
                result[pos] = text
        return result
    id_end = id_start + n - 1
    for item in items:
        if not isinstance(item, dict):
            continue
        idx = _coerce_int_id(item.get("id"))
        text = item.get("text")
        if idx is None or not isinstance(text, str):
            continue
        if id_start <= idx <= id_end:
            result[idx - id_start] = text
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
                               characters: list[dict] | None = None,
                               id_start: int = 1,
                               ids: list[int] | None = None,
                               texts: list[str] | None = None,
                               source: str | None = None) -> str:
    if source is None and texts is not None:
        source = _detect_source_language(texts)
    base_prompt = _resolve_prompt(source, target)
    chars_section = _build_characters_section(characters)
    ids_to_use = ids if ids else list(range(id_start, id_start + n))
    first = ids_to_use[0]
    last = ids_to_use[-1]
    is_contiguous = (last - first + 1 == n)
    if is_contiguous:
        schema_instruction = (
            f"\n\nBATCH MODE: You will translate exactly {n} numbered items.\n"
            f"OUTPUT (JSON ONLY — no prose, no markdown):\n"
            f'{{"items": [\n'
            f'  {{"id": {first}, "text": "<translation of input [{first}]>"}},\n'
            f'  {{"id": {first + 1}, "text": "<translation of input [{first + 1}]>"}},\n'
            f"  ...\n"
            f'  {{"id": {last}, "text": "<translation of input [{last}]>"}}\n'
            f"]}}\n"
            f"RULES:\n"
            f'- "items" array must contain EXACTLY {n} elements.\n'
            f'- Each element has "id" (integer {first}..{last}) and "text" (the translation).\n'
            f"- IDs must be {first} through {last} in ascending order, no skips, no duplicates.\n"
            f"- Each text is the translation of the input line with the same number.\n"
        )
    else:
        ids_str = ", ".join(str(x) for x in ids_to_use)
        schema_instruction = (
            f"\n\nBATCH MODE: You will translate exactly {n} numbered items.\n"
            f"OUTPUT (JSON ONLY — no prose, no markdown):\n"
            f'{{"items": [{{"id": <int>, "text": "<translation>"}}, ...]}}\n'
            f"RULES:\n"
            f'- "items" array must contain EXACTLY {n} elements.\n'
            f'- IDs MUST be exactly: {ids_str} (matching the [N] markers in input — preserve any gaps).\n'
            f"- Each text is the translation of the input line with the same id.\n"
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
    # Guards = advisory. LLM output ห้ามถูกแทนด้วย original — ผู้ใช้ต้องเห็นเสมอ
    # และตัดสินใจเองว่าจะ apply หรือไม่ (ผ่าน warning marker ใน UI).
    # error = None: ใช้ได้เลย; error set + translation มีค่า: ใช้ได้แต่มี warning;
    # error set + translation ว่าง: ไม่ได้แปลจริง (LLM ไม่ตอบ id นี้)
    for i, raw in enumerate(parsed):
        original = texts[i]
        mapping = per_item[i]["mapping"]

        if raw is None or not raw.strip():
            translations.append("")
            errors.append("missing")
            continue

        try:
            t = _join_lines(raw)
            t = _normalize_numerals(t)
            t = _restore_segments(t, mapping)

            warnings: list[str] = []
            if _is_refusal(t):
                warnings.append("refusal")
            if _output_has_unwanted_script(target, t):
                warnings.append("foreign_script")
            if _digits_changed(original, t):
                warnings.append("digit_mismatch")

            translations.append(t)
            errors.append(", ".join(warnings) if warnings else None)
        except Exception as e:
            translations.append("")
            errors.append(f"exception: {e}")
    return translations, errors


def _translate_temp_for_attempt(attempt: int) -> float:
    """attempt 0 → 0.2, retry → 0.4, 0.6, 0.7 (cap)"""
    return min(0.7, 0.2 + 0.2 * max(0, attempt))


def _translate_batch_qwen(texts: list[str], target: str,
                          custom_rules: str | None,
                          timeout: float, attempt: int = 0,
                          speakers: list[str | None] | None = None,
                          characters: list[dict] | None = None,
                          id_start: int = 1,
                          ids: list[int] | None = None,
                          ) -> tuple[list[str], list[str | None]]:
    n = len(texts)
    user_msg, per_item = _build_batch_user_msg(texts, speakers, id_start=id_start, ids=ids)
    system_prompt = _build_batch_system_prompt(target, n, custom_rules, characters,
                                               id_start=id_start, ids=ids, texts=texts)

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
        parsed = _parse_batch_json(raw_out, n, id_start=id_start, ids=ids)
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
                            id_start: int = 1,
                            ids: list[int] | None = None,
                            ) -> tuple[list[str], list[str | None]]:
    n = len(texts)

    if not GEMINI_API_KEY:
        return list(texts), ["GEMINI_API_KEY is not set in .env"] * n

    try:
        from google import genai
        from google.genai import types as gtypes
    except ImportError as e:
        return list(texts), [f"google-genai is not installed: {e}"] * n

    user_msg, per_item = _build_batch_user_msg(texts, speakers, id_start=id_start, ids=ids)
    system_prompt = _build_batch_system_prompt(target, n, custom_rules, characters,
                                               id_start=id_start, ids=ids, texts=texts)

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
        parsed = _parse_batch_json(raw_out, n, id_start=id_start, ids=ids)
    except Exception as e:
        return list(texts), [f"gemini: {e}"] * n

    return _post_process_batch(texts, parsed, per_item, target)


def _extract_json_payload(raw: str) -> str:
    """ดึง JSON object/array จาก response ของ LLM อย่าง robust:
    1. ลอง parse ทั้งก้อนก่อน (fast path)
    2. ถ้าเป็น markdown fence (```json ... ```) ลอก wrapper
    3. หา `{` ตัวแรก แล้วใช้ json.JSONDecoder.raw_decode หาขอบเขต object ที่ valid
    raw_decode คือ method มาตรฐานของ stdlib ที่ json library ใช้แยก concatenated JSON —
    เชื่อถือได้กว่า regex / find('}') ที่จะหลุดเคส nested braces ใน string
    """
    if not raw:
        return ""
    s = raw.strip()
    if not s:
        return ""
    # fast path
    try:
        json.loads(s)
        return s
    except json.JSONDecodeError:
        pass
    # markdown fence wrapper
    if s.startswith("```"):
        nl = s.find("\n")
        if nl > 0:
            s = s[nl + 1:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3].rstrip()
        try:
            json.loads(s)
            return s
        except json.JSONDecodeError:
            pass
    # raw_decode — เริ่มจาก `{` หรือ `[` ตัวแรก ที่ตามด้วย JSON ที่ valid
    decoder = json.JSONDecoder()
    for opener in ("{", "["):
        idx = s.find(opener)
        while idx >= 0:
            try:
                _, end = decoder.raw_decode(s, idx)
                return s[idx:end]
            except json.JSONDecodeError:
                idx = s.find(opener, idx + 1)
    return s


# legacy alias เผื่อ caller เก่า
_strip_markdown_fence = _extract_json_payload


def apply_manual_batch(texts: list[str], target: str, raw_response: str,
                       speakers: list[str | None] | None = None,
                       characters: list[dict] | None = None,
                       id_start: int = 1,
                       ids: list[int] | None = None,
                       ) -> tuple[list[str], list[str | None]]:
    """Parse manual response — apply ignore SKIP / empty source.
    ids: explicit list (override id_start) — รองรับ slice ไม่ติดกัน"""
    n = len(texts)
    translations: list[str] = ["" for _ in range(n)]
    errors: list[str | None] = [None] * n
    if n == 0:
        return translations, errors

    sp_list: list[str | None] = list(speakers) if speakers else [None] * n
    if len(sp_list) < n:
        sp_list += [None] * (n - len(sp_list))
    if ids is None or len(ids) != n:
        ids = [id_start + i for i in range(n)]

    has_real_speaker = any(s for s in sp_list if s and s != SPEAKER_SKIP)
    has_skip = any(s == SPEAKER_SKIP for s in sp_list)
    eff_speakers = sp_list if (has_real_speaker or has_skip) else None
    _, per_item = _build_batch_user_msg(texts, eff_speakers, id_start=id_start, ids=ids)

    cleaned = _strip_markdown_fence(raw_response)
    parsed = _parse_batch_json(cleaned, n, id_start=id_start, ids=ids)
    sub_t, sub_e = _post_process_batch(list(texts), parsed, per_item, target)

    for i in range(n):
        if sp_list[i] == SPEAKER_SKIP:
            continue
        if not _is_translatable(texts[i]):
            continue
        if parsed[i] is None:
            continue  # id ไม่อยู่ใน paste → ปล่อย row, ไม่ error
        translations[i] = sub_t[i]
        errors[i] = sub_e[i]
    return translations, errors


def translate_batch(texts: list[str], target: str = "th",
                    engine: str = "qwen",
                    custom_rules: str | None = None,
                    timeout: float | None = None,
                    attempt: int = 0,
                    speakers: list[str | None] | None = None,
                    characters: list[dict] | None = None,
                    id_start: int = 1,
                    ids: list[int] | None = None,
                    ) -> tuple[list[str], list[str | None]]:
    """ส่งทุก row ให้ LLM — ไม่ filter, apply step ignore SKIP / empty source.
    ids: explicit list (override id_start) — รองรับ slice ที่ไม่ติดกัน เช่น retry fail"""
    if not texts:
        return [], []

    n = len(texts)
    translations: list[str] = ["" for _ in range(n)]
    errors: list[str | None] = [None] * n

    sp_list: list[str | None] = list(speakers) if speakers else [None] * n
    if len(sp_list) < n:
        sp_list += [None] * (n - len(sp_list))
    if ids is None or len(ids) != n:
        ids = [id_start + i for i in range(n)]

    has_real_speaker = any(s for s in sp_list if s and s != SPEAKER_SKIP)
    has_skip = any(s == SPEAKER_SKIP for s in sp_list)
    eff_speakers = sp_list if (has_real_speaker or has_skip) else None
    if has_real_speaker and characters:
        used_ids = {s for s in sp_list if s and s != SPEAKER_SKIP}
        eff_chars = [c for c in characters if c.get("id") in used_ids]
    else:
        eff_chars = None
    has_speaker = has_real_speaker

    if engine == "gemini":
        eff_timeout = timeout if timeout is not None else GEMINI_TIMEOUT
        sub_t, sub_e = _translate_batch_gemini(
            texts, target, custom_rules, eff_timeout, attempt,
            speakers=eff_speakers, characters=eff_chars, ids=ids,
        )
    else:
        eff_timeout = timeout if timeout is not None else TRANSLATE_BATCH_TIMEOUT
        sub_t, sub_e = _translate_batch_qwen(
            texts, target, custom_rules, eff_timeout, attempt,
            speakers=eff_speakers, characters=eff_chars, ids=ids,
        )

    skipped_user = 0
    skipped_empty = 0
    for i in range(n):
        if sp_list[i] == SPEAKER_SKIP:
            skipped_user += 1
            continue
        if not _is_translatable(texts[i]):
            skipped_empty += 1
            continue
        translations[i] = sub_t[i]
        errors[i] = sub_e[i]

    n_ok = sum(1 for i in range(n) if errors[i] is None
               and sp_list[i] != SPEAKER_SKIP and _is_translatable(texts[i]))
    n_real = n - skipped_user - skipped_empty
    detected_source = _detect_source_language([texts[i] for i in range(n)
                                               if sp_list[i] != SPEAKER_SKIP
                                               and _is_translatable(texts[i])])
    using_pair = (detected_source, target) in TRANSLATE_PROMPTS_BY_PAIR
    print(
        f"[translate-batch] engine={engine} n={n} real={n_real} "
        f"skipped_user={skipped_user} skipped_empty={skipped_empty} "
        f"ok={n_ok} fail={n_real - n_ok} attempt={attempt} speakers={has_speaker} "
        f"source={detected_source or 'unknown'} prompt={'pair' if using_pair else 'default'}",
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
        return text, "shortcuts CLI not found (requires macOS 12+)"

    name = {
        "th": APPLE_SHORTCUT_TH,
        "ja": APPLE_SHORTCUT_JA,
    }.get(target, APPLE_SHORTCUT_EN)
    if name not in _list_shortcuts():
        return text, (
            f"Shortcut '{name}' has not been created — see instructions at /apple-translate-setup"
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
