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
    APPLE_SHORTCUT_VI,
    GEMINI_API_KEY,
    GEMINI_MODEL,
    GEMINI_TIMEOUT,
    NLLB_MODEL,
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
    if target == "vi":
        return _has_cjk(text) or _has_thai(text)
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
        "- KATAKANA WORDS — แยกตามประเภท (อ่านให้ละเอียด ก่อนเลือก):\n"
        "  (A) NAMES (คน/สถานที่/แบรนด์ที่ไม่มีรูปแบบไทยที่นิยม) → transliterate by SOUND.\n"
        "    ミノル → 'มิโนรุ' (sound) — person name\n"
        "    シロタ → 'ชิโรตะ' (sound)\n"
        "    ヤマダ タロウ → 'ยามาดะ ทาโร่' (sound)\n"
        "  (B) COMMON LOANWORDS — คำที่มีคำไทยเทียบเคียงใช้แพร่หลาย → ใช้คำไทยที่มีอยู่จริง.\n"
        "    カメラ → 'กล้อง' (มีคำไทยมาตรฐาน)\n"
        "    スカート → 'กระโปรง'\n"
        "    コーヒー → 'กาแฟ'\n"
        "    テーブル → 'โต๊ะ'\n"
        "    ベッド → 'เตียง'\n"
        "    ホテル → 'โรงแรม'\n"
        "  (C) LOANWORDS ที่ไม่มีคำไทยมาตรฐาน (fashion/tech/foreign concept) → SOUND.\n"
        "    ブレザー → 'เบลเซอร์'\n"
        "    タータンチェック → 'ทาร์ทันเช็ค'\n"
        "    アプリ → 'แอป' (รูปไทยที่นิยม) หรือ 'แอปพลิเคชัน'\n"
        "  (D) ESTABLISHED THAI BRAND FORM — ใช้ตามรูปที่คนไทยใช้จริง.\n"
        "    ヤクルト → 'ยาคูลท์'\n"
        "  DECISION RULE: ถ้านึกคำไทยมาตรฐาน (ใช้ในชีวิตประจำวัน, มี dictionary entry) ออก "
        "  ใช้คำไทย; ถ้าไม่มี/ไม่ชัด/เป็นชื่อเฉพาะ ใช้ sound.\n"
        "- For Japanese names written in kanji, transliterate the reading INTO THAI script; "
        "  never keep the kanji and never translate the meaning.\n"
        "- GREETINGS / FIXED EXPRESSIONS (DEFAULT — character voice overrides this entire section)\n"
        "  ถ้ามี CHARACTER PROFILE ระบุ persona/voice → ตามตัวละครเสมอ (รวมถึง 'ขอบใจ' / 'บาย' / 'ไฮ')\n"
        "  ถ้าไม่มี persona หรือเป็น neutral → ใช้ default ด้านล่าง\n"
        "  IMPORTANT: คนไทย**ไม่**พูด 'สวัสดีตอนเช้า/บ่าย/เย็น/ค่ำ' (แปลตรงตัว ไม่ใช้จริง)\n"
        "  ทุกช่วงเวลาใช้ 'สวัสดี' คำเดียว; 'อรุณสวัสดิ์' / 'ราตรีสวัสดิ์' = formal เท่านั้น\n"
        "  Japanese → Thai (neutral):\n"
        "    おはよう / おはよ → 'อรุณสวัสดิ์' (formal) / 'ตื่นแล้วเหรอ' (casual) / 'สวัสดี'\n"
        "    こんにちは → 'สวัสดี'\n"
        "    こんばんは → 'สวัสดี' / 'ราตรีสวัสดิ์' (ถ้ากำลังจะนอน)\n"
        "    おやすみ → 'ราตรีสวัสดิ์' / 'ฝันดี' / 'นอนแล้วนะ'\n"
        "    ありがとう → 'ขอบคุณ'\n"
        "    ごめん / すみません → 'ขอโทษ' (หรือ 'ขอตัวก่อน' ถ้าใช้เรียกความสนใจ)\n"
        "    さようなら → 'ลาก่อน' / 'แล้วเจอกัน'\n"
        "    いただきます → 'จะกินแล้วนะ' / ตัดออก (ไม่มีสำนวนไทยตรง)\n"
        "    ごちそうさま → 'อิ่มแล้ว ขอบคุณ'\n"
        "    はじめまして → 'ยินดีที่ได้รู้จัก'\n"
        "  English → Thai (เลือกตามโทน):\n"
        "    Casual (chat/manga/บทสนทนาเพื่อน):\n"
        "      hi / hello → 'สวัสดี' / 'ไฮ' (ถ้าโทนทับศัพท์ฝรั่ง)\n"
        "      hey → 'เฮ้' / 'ว่าไง'\n"
        "      bye → 'ลาก่อน' / 'บ๊ายบาย' (เด็ก/เพื่อน) / 'ไปก่อนนะ'\n"
        "      thanks → 'ขอบคุณ' (ห้าม 'ขอบใจ' ถ้าไม่มีบริบทอายุ/ความสนิท)\n"
        "      sorry → 'ขอโทษ'\n"
        "      ok → 'โอเค'\n"
        "    Formal (จดหมาย/news/บทสุภาพ):\n"
        "      good morning → 'อรุณสวัสดิ์' / 'สวัสดี'\n"
        "      good afternoon / good evening → 'สวัสดี' (NOT 'สวัสดีตอนบ่าย/เย็น')\n"
        "      good night → 'ราตรีสวัสดิ์' / 'ฝันดี'\n"
        "      thank you → 'ขอบคุณ'\n"
        "    FORBIDDEN: 'มอนิ่ง' เดี่ยวๆ (คนไทยไม่พูด — ใช้ 'อรุณสวัสดิ์' หรือ 'สวัสดี' แทน)\n"
        "  หลัก: รักษา register/โทนของต้นฉบับ — casual ใช้คำทับศัพท์ที่คนไทยใช้จริงได้, "
        "  formal ใช้คำไทยทางการ ห้ามแปลตรงตัวจน robotic.\n"
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
    "vi": (
        "Translate the user's text to natural Vietnamese.\n"
        "Output ONLY the Vietnamese translation. No explanation, no quotes, no preamble.\n"
        "Keep the meaning faithful. Do not add or omit information.\n"
        "RULES — STRICTLY FOLLOWED:\n"
        "- The output MUST be in Vietnamese script (Latin alphabet with diacritics) ONLY.\n"
        "  Allowed characters: Latin letters A-Z a-z, the Vietnamese-specific letters "
        "  Đ đ Ơ ơ Ư ư, all Vietnamese tone/diacritic combinations (à á ả ã ạ â ấ ầ ẩ "
        "  ẫ ậ ă ằ ắ ẳ ẵ ặ è é ẻ ẽ ẹ ê ề ế ể ễ ệ ì í ỉ ĩ ị ò ó ỏ õ ọ ô ồ ố ổ ỗ ộ ơ ờ "
        "  ớ ở ỡ ợ ù ú ủ ũ ụ ư ừ ứ ử ữ ự ỳ ý ỷ ỹ ỵ and their uppercase forms), "
        "  Arabic digits 0-9, and basic punctuation.\n"
        "  FORBIDDEN: ANY Chinese characters (汉字), Japanese hiragana/katakana/kanji, "
        "  Thai script (ก-๛), or Korean Hangul.\n"
        "- DIACRITICS — ABSOLUTE RULE: Vietnamese without diacritics is wrong. Every "
        "  word that needs a tone or vowel mark MUST carry it (write 'tiếng Việt', "
        "  NEVER 'tieng Viet'; write 'phở', NEVER 'pho' unless that bare spelling is "
        "  the established international form like the dish name in an English menu).\n"
        "- NUMBERS — ABSOLUTE RULE: NEVER translate, modify, convert, or normalize any number.\n"
        "  Every digit (0-9) in the input MUST appear EXACTLY THE SAME in the output, "
        "  in the SAME ORDER.\n"
        "  NEVER convert digits to Vietnamese words ('25' stays '25', NOT 'hai mươi lăm').\n"
        "  NEVER change thousand or decimal separators (keep '1,000' as '1,000'; keep "
        "  '3.14' as '3.14'). Do not switch between English-style and Vietnamese-style "
        "  separators.\n"
        "  NEVER convert calendars, units, or currency.\n"
        "  NEVER round or simplify.\n"
        "  Applies to: years, dates, times, prices, percentages, phone numbers, "
        "  measurements, list/version numbers — every numeric token.\n"
        "- PERSON NAMES & PROPER NOUNS: NEVER translate the meaning of a name.\n"
        "  Foreign names stay in their Latin form (Smith → Smith, Microsoft → Microsoft).\n"
        "  Katakana names → romanize by SOUND (ミノル → 'Minoru', NOT 'Trái cây').\n"
        "  Japanese kanji names → use the romanized reading; never keep kanji in the output.\n"
        "  Thai names → romanize by sound (สมชาย → 'Somchai').\n"
        "- Established Latin-script brand names (Microsoft, Google, iPhone) stay in Latin script.\n"
        "If the input is already Vietnamese, return it unchanged."
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
    ("en", "vi"): (
        "Translate the user's text from English to natural Vietnamese.\n"
        "Output ONLY the Vietnamese translation. No explanation, no quotes, no preamble.\n"
        "Keep the meaning faithful. Do not add or omit information.\n"
        "RULES — STRICTLY FOLLOWED:\n"
        "- The output MUST be in Vietnamese script (Latin alphabet with diacritics) ONLY.\n"
        "  Allowed: Latin letters A-Z a-z, Vietnamese-specific letters Đ đ Ơ ơ Ư ư, "
        "  all Vietnamese tone marks on vowels, Arabic digits 0-9, and basic punctuation.\n"
        "  FORBIDDEN: any non-Latin script in the output.\n"
        "- DIACRITICS — ABSOLUTE: write proper Vietnamese with FULL tone and vowel marks "
        "  ('tiếng Việt', NOT 'tieng Viet'; 'Sản phẩm', NOT 'San pham'). "
        "  Every word that requires a tone mark (sắc/huyền/hỏi/ngã/nặng) or a vowel mark "
        "  (â/ê/ô/ơ/ư) MUST carry it.\n"
        "- NUMBERS — ABSOLUTE: every digit (0-9) in the input MUST appear EXACTLY THE SAME "
        "  and in the SAME ORDER in the output.\n"
        "  NEVER spell digits as Vietnamese words ('25' stays '25', NOT 'hai mươi lăm').\n"
        "  NEVER change thousand or decimal separators (keep '1,000' as '1,000'; "
        "  keep '3.14' as '3.14').\n"
        "  NEVER convert calendars, units, or currency. NEVER round or simplify.\n"
        "  Applies to: years, dates, times, prices, percentages, phone numbers, "
        "  measurements, list/version numbers — every numeric token.\n"
        "- PROPER NOUNS / NAMES / BRANDS: keep foreign names and Latin-script brands as-is "
        "  (Smith → Smith; Microsoft → Microsoft; iPhone → iPhone; ISO 9001 → ISO 9001). "
        "  Never translate the meaning of a name.\n"
        "If the input is already Vietnamese, return it unchanged."
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
    ("ja", "th"): (
        "Translate the user's text from Japanese to natural Thai.\n"
        "Output ONLY the Thai translation. No explanation, no quotes, no preamble.\n"
        "Keep the meaning faithful. Do not add or omit information.\n"
        "RULES — STRICTLY FOLLOWED:\n"
        "- Output MUST be Thai script ONLY.\n"
        "  Allowed: Thai (ก-๛), Latin letters (A-Z, a-z) for brand names, "
        "  Arabic digits (0-9), basic punctuation.\n"
        "  FORBIDDEN in output: hiragana (あいう), katakana (アイウ), kanji (漢字), "
        "  Chinese characters. If found, rewrite in Thai before responding.\n"
        "- NUMBERS — ABSOLUTE RULE: every digit (0-9) in the input MUST appear EXACTLY "
        "  THE SAME and in the SAME ORDER in the output.\n"
        "  NEVER convert to Thai numerals (no ๐๑๒๓๔๕๖๗๘๙).\n"
        "  NEVER convert calendars (令和7年 stays as-is or use Western form if input has it).\n"
        "  NEVER convert digits to words ('25' stays '25', NOT 'ยี่สิบห้า').\n"
        "- KATAKANA — แยกตามประเภท ก่อนเลือก:\n"
        "  (A) NAMES (คน/สถานที่/แบรนด์ไม่มีรูปไทย) → transliterate by SOUND.\n"
        "    ミノル → 'มิโนรุ', シロタ → 'ชิโรตะ', ヤマダ タロウ → 'ยามาดะ ทาโร่'\n"
        "  (B) COMMON LOANWORDS มีคำไทยใช้แพร่หลาย → ใช้คำไทย.\n"
        "    カメラ → 'กล้อง', スカート → 'กระโปรง', コーヒー → 'กาแฟ',\n"
        "    テーブル → 'โต๊ะ', ベッド → 'เตียง', ホテル → 'โรงแรม'\n"
        "  (C) LOANWORDS ไม่มีคำไทยมาตรฐาน → SOUND.\n"
        "    ブレザー → 'เบลเซอร์', タータンチェック → 'ทาร์ทันเช็ค'\n"
        "  (D) ESTABLISHED THAI BRAND → ใช้รูปที่คนไทยใช้.\n"
        "    ヤクルト → 'ยาคูลท์'\n"
        "  DECISION: นึกคำไทยมาตรฐานออก → ใช้คำไทย; ไม่งั้น → sound.\n"
        "- KANJI NAMES → transliterate the reading INTO THAI script. "
        "  NEVER keep kanji in output. NEVER translate the meaning of a name.\n"
        "    山田太郎 (Yamada Tarō) → 'ยามาดะ ทาโร่' (NOT 'ภูเขาข้าวลูกชายโต')\n"
        "- ABBREVIATED COMPOUND NOUNS (kanji + katakana ผสม, slang ย่อ) →\n"
        "  EXPAND กลับเป็นรูปเต็ม แล้วแปล MEANING (ไม่ใช่ sound)\n"
        "  เพราะคำย่อพวกนี้คือ common noun ไม่ใช่ชื่อ — ผู้อ่านไทยควรเข้าใจความหมาย\n"
        "    電マ (= 電動マッサージ機)      → 'เครื่องนวดไฟฟ้า' / 'เครื่องสั่นไฟฟ้า'  (NOT 'เด็นมะ')\n"
        "    ガラケー (= ガラパゴス携帯)    → 'มือถือฟีเจอร์โฟน' / 'มือถือธรรมดา'    (NOT 'การาเค')\n"
        "    パワハラ (= パワーハラスメント) → 'การกดขี่ด้วยอำนาจ'                    (NOT 'ปาวาฮาระ')\n"
        "    セクハラ (= セクシャルハラスメント) → 'การล่วงละเมิดทางเพศ'             (NOT 'เซกุฮาระ')\n"
        "    リスケ (= リスケジュール)      → 'เลื่อนนัด' / 'reschedule'             (NOT 'ริซุเกะ')\n"
        "    リモコン (= リモートコントロール) → 'รีโมท'                              (NOT 'ริโมะคน')\n"
        "    エアコン (= エアーコンディショナー) → 'แอร์'                            (NOT 'เอะอะคน')\n"
        "    パソコン (= パーソナルコンピュータ) → 'คอมพิวเตอร์' / 'คอม'             (NOT 'ปะโซคน')\n"
        "    JK (= 女子高生)              → 'นักเรียนหญิงม.ปลาย'                   (NOT 'JK' / 'เจเค')\n"
        "  DECISION: ถ้าคำย่อมี Thai equivalent ชัดเจน → ใช้ Thai meaning\n"
        "    ถ้าเป็น proper noun (เช่น ชื่อแบรนด์ย่อ ในบทพูดเฉพาะกลุ่ม) → คงต้นฉบับหรือ sound\n"
        "- ⚠ PARTICLE PARITY (HIGHEST PRIORITY — เหนือกฎ politeness/character อื่น):\n"
        "  ห้ามใส่คำลงท้าย (ค่ะ/ครับ/นะ/นะคะ/นะครับ/จ้ะ/จ๊ะ/ล่ะ/น่ะ) ถ้าต้นฉบับไม่มี\n"
        "  polite/sentence-final particle (です/ます/ね/よ/わ/さ/の) ใน clause นั้น\n"
        "  เกณฑ์ตัดสินเรียงตามนี้:\n"
        "    source มี ですね/ますね/だね/わね → output ใส่ 'นะ' / 'นะคะ' / 'นะครับ' ได้\n"
        "    source มี です/ます ล้วน (ไม่มี ね/よ) → ใส่ 'ครับ/ค่ะ' ได้ แต่ห้ามเติม 'นะ'\n"
        "    source ลงท้ายแบบ plain (だ/る/た/ない/dictionary form/ตัดเปล่า) → output ห้ามมี particle\n"
        "    source เป็น คำสั่ง/อุทาน/internal thought/fragment → output ห้ามมี particle\n"
        "  ตัวอย่าง strict:\n"
        "    行く → 'ไป' (ไม่ใช่ 'ไปนะ' / 'ไปครับ')\n"
        "    知らない → 'ไม่รู้' (ไม่ใช่ 'ไม่รู้นะ' / 'ไม่รู้ค่ะ')\n"
        "    腹減った → 'หิวจัง' (ไม่ใช่ 'หิวจังเลยค่ะ')\n"
        "    あ、危ない! → 'อ๊ะ อันตราย!' (ไม่ใช่ 'อันตรายนะคะ')\n"
        "    行きます → 'ไปครับ' / 'ไปค่ะ' (ใส่ได้ — มี ます)\n"
        "    行きますね → 'ไปนะครับ' / 'ไปนะคะ' (ใส่ ね ได้ — มี ね ใน source)\n"
        "  RULE: ถ้าต้นฉบับสั้น/ห้วน Thai ก็ต้องสั้น/ห้วน — ห้าม 'ทำให้สุภาพขึ้น' โดยการเติม particle\n"
        "- POLITENESS LEVEL DETECTION (signal หลัก — Japanese ระบุ register ผ่านท้ายประโยค/สรรพนาม):\n"
        "  ลำดับการตัดสิน voice ของแต่ละประโยค:\n"
        "  (1) อ่าน SENTENCE ENDING ในต้นฉบับก่อน — เป็น signal ที่ชัดที่สุด:\n"
        "      でございます / いたします / 申し上げます → 形式 (very formal) → 'ครับ/ค่ะ' + คำสุภาพ ทางการ\n"
        "      です / ます / ですか / ますね → polite → 'ครับ/ค่ะ' / 'นะคะ/นะครับ'\n"
        "      だ / だよ / だね / だな → casual neutral → ลงท้าย 'นะ' / ไม่มีท้าย\n"
        "      ぞ / ぜ / だぜ / だぞ → rough masculine → 'ว่ะ' / ห้วน / ไม่มีท้าย (drop 'ครับ')\n"
        "      わ / わよ / かしら / だわ → feminine elegant → 'ค่ะ' + ละมุน / 'นะคะ' / 'น่ะ'\n"
        "      じゃねえ / じゃん / だろ / だろうが → very casual/rough → 'ว่ะ' / 'อะ' / ไม่มีท้าย\n"
        "      ですわ / ですの (お嬢様 speech) → high-class feminine → 'เพคะ' / 'นะเพคะ'\n"
        "      でござる / なり (samurai/archaic) → archaic → 'ขอรับ' / 'หรอก'\n"
        "  (2) อ่าน PRONOUN ในต้นฉบับ — บ่งบอกระดับและ gender:\n"
        "      わたくし > わたし / 私 → formal → 'ดิฉัน / ผม / ฉัน' (formal)\n"
        "      あたし → casual feminine → 'ฉัน' (default; 'หนู' เฉพาะถ้า age=child/teen)\n"
        "      僕 → polite masculine → 'ผม'\n"
        "      俺 → casual/rough masculine → 'กู' (รุนแรง) / 'ฉัน' (กลาง)\n"
        "      おまえ / てめえ / きさま → rough 'you' → 'แก' / 'มึง'\n"
        "      あなた → polite 'you' → 'คุณ'\n"
        "  (3) อ่าน HONORIFIC PREFIXES (お~ / ご~) — บ่งบอกความ respectful\n"
        "      お母さん vs 母さん → 'คุณแม่' vs 'แม่'\n"
        "      ご飯 vs 飯 → 'อาหาร' vs 'ข้าว'\n"
        "  (4) CHARACTER PROFILE — เสริม/ทับซ้อนถ้าระบุชัด (ดูข้างล่าง)\n"
        "  (5) FINAL CHECK: อ่านประโยคที่แปลแล้วทั้งประโยค — เป็นไทยที่อ่านเข้าใจ ไม่ฝืน ไม่แปลก?\n"
        "      ถ้าแปลก/robotic/mix register → แก้ใหม่ก่อนตอบ\n"
        "- GREETINGS / FIXED EXPRESSIONS (DEFAULT — character voice overrides this entire section)\n"
        "  ถ้ามี CHARACTER PROFILE ระบุ persona/voice → ตามตัวละครเสมอ (รวมถึง 'ขอบใจ' / 'บาย' / 'ไฮ')\n"
        "  ถ้าไม่มี persona หรือเป็น neutral → ใช้ default ด้านล่าง\n"
        "  IMPORTANT: คนไทย**ไม่**พูด 'สวัสดีตอนเช้า/บ่าย/เย็น/ค่ำ' (แปลตรงตัว ไม่ใช้จริง)\n"
        "  ทุกช่วงเวลาใช้ 'สวัสดี' คำเดียว; 'อรุณสวัสดิ์' / 'ราตรีสวัสดิ์' = formal เท่านั้น\n"
        "    おはよう / おはよ → 'อรุณสวัสดิ์' (formal) / 'ตื่นแล้วเหรอ' (casual) / 'สวัสดี'\n"
        "    こんにちは → 'สวัสดี'\n"
        "    こんばんは → 'สวัสดี' (หรือ 'ราตรีสวัสดิ์' ถ้ากำลังจะนอน)\n"
        "    おやすみ / おやすみなさい → 'ราตรีสวัสดิ์' / 'ฝันดี' / 'นอนแล้วนะ'\n"
        "    ありがとう / ありがと / ありがとうございます → 'ขอบคุณ'\n"
        "    ごめん / ごめんなさい / すみません → 'ขอโทษ' (หรือ 'ขอตัวก่อน' ถ้า すみません ใช้เรียกร้องความสนใจ)\n"
        "    さようなら → 'ลาก่อน' (formal); じゃあね / またね → 'แล้วเจอกัน' / 'ไว้เจอกัน'\n"
        "    バイバイ → 'บ๊ายบาย' / 'ไปก่อนนะ' (casual เด็ก/เพื่อน)\n"
        "    いただきます → 'จะกินแล้วนะ' / ตัดออก (ไม่มีสำนวนไทยตรง)\n"
        "    ごちそうさま → 'อิ่มแล้ว ขอบคุณ' / 'อร่อยมาก'\n"
        "    はじめまして → 'ยินดีที่ได้รู้จัก'\n"
        "    お疲れさま → 'เหนื่อยหน่อยนะ' / 'ขอบคุณที่ทำงาน' (ตามบริบท)\n"
        "    がんばって → 'สู้ๆ' / 'พยายามนะ'\n"
        "    やあ (casual hey) → 'ว่าไง' / 'เฮ้'\n"
        "- PARTICLES / FILLERS (え, あの, えーと, まあ, へえ) — แปลเป็นเสียงไทยที่เทียบเคียง\n"
        "  ('เอ้อ', 'อืม', 'อ้อ', 'หา?') ห้ามทิ้งฮิรากานะดิบใน output.\n"
        "If the input is already Thai, return it unchanged."
    ),
}


def _resolve_prompt(source: str | None, target: str) -> str:
    """Pick source-tailored prompt if available, else fall back to the universal one."""
    if source:
        pair_prompt = TRANSLATE_PROMPTS_BY_PAIR.get((source, target))
        if pair_prompt:
            return pair_prompt
    return TRANSLATE_PROMPTS.get(target, TRANSLATE_PROMPTS["th"])


# content-type style overlays — layer บน pair prompt, เลือกผ่าน content_type payload
TRANSLATE_STYLE_PROMPTS = {
    "manga_novel": (
        "\n\n═══ CONTENT TYPE: MANGA / NOVEL (dialogue + narration mixed) ═══\n"
        "- Conversational register — character voice ตาม profile (gender/age/persona)\n"
        "- Sentence-ending particles (ค่ะ/ครับ/นะ/จ้ะ) ใช้ตามเงื่อนไข PARTICLE PARITY ด้านบน\n"
        "- คงสำนวน manga (อุทาน, fragment, expression) — ไม่ทำให้เป็นทางการเกินไป\n"
    ),
    "tutorial": (
        "\n\n═══ CONTENT TYPE: TUTORIAL (instructional/how-to / web manual) ═══\n"
        "- Imperative voice — direct command\n"
        "- ใช้ verb stem: 'คลิก', 'เลือก', 'กด', 'พิมพ์', 'บันทึก'\n"
        "- ⚠ NO casual particles (ค่ะ/ครับ/นะ) — ถ้า formal user manual ใช้ 'ให้...', 'ควร...'\n"
        "- คงคำศัพท์เทคนิคเป็น English/Thai loanword ตาม convention (ดูใน glossary)\n"
        "    'ボタンをクリック' → 'คลิกปุ่ม' (ไม่ใช่ 'คลิกปุ่มนะคะ')\n"
        "    'ファイルを保存' → 'บันทึกไฟล์'\n"
    ),
    "product_catalog": (
        "\n\n═══ CONTENT TYPE: PRODUCT CATALOG (e-commerce / spec sheet / factory manual) ═══\n"
        "Target: Vietnamese. Register: professional, formal, technical — like a product\n"
        "catalog, factory manual, or datasheet. Never default to manga / chat / dialogue style.\n"
        "- NO conversational sentence-final particles in declarative catalog/spec text.\n"
        "  FORBIDDEN: ạ / nhé / nha / đấy / đó / nhỉ / hả / vậy / luôn.\n"
        "- PRONOUNS — use neutral catalog forms:\n"
        "    'we'        → 'Chúng tôi'\n"
        "    'you'       → 'Quý khách' (sales/customer copy) / 'Quý vị' (broad audience) /\n"
        "                  'người dùng' (technical manual) / 'người tiêu dùng' (legal/policy)\n"
        "    'please'    → 'Vui lòng'\n"
        "    'thank you' → 'Cảm ơn' / 'Xin cảm ơn'\n"
        "- FORBIDDEN as 'you' in catalog body: anh / chị / em / cô / chú / bác / ông / bà /\n"
        "  cháu / con / mày / cậu / tớ. They force a guess about the reader's gender, age,\n"
        "  or relationship — guessing wrong is immediately impolite.\n"
        "- FORBIDDEN: title prefix before a name (Mr./Mrs./Ms./Dear → Ông/Bà/Cô) — same\n"
        "  reason; guessing the wrong gender is impolite. Address the reader with a neutral\n"
        "  form, or drop the salutation entirely.\n"
        "- Declarative product copy stays declarative (no chat particles):\n"
        "    'Made of stainless steel' → 'Được làm bằng thép không gỉ'\n"
        "    NOT 'Được làm bằng thép không gỉ ạ'.\n"
        "- Buttons / UI labels → short imperative or noun phrase, no particles:\n"
        "    'Add to cart' → 'Thêm vào giỏ hàng'.   'Buy now' → 'Mua ngay'.\n"
        "- Numbers + units + brand names stay verbatim: 100 mm stays '100 mm';\n"
        "  Microsoft stays 'Microsoft'; ISO 9001 stays 'ISO 9001'.\n"
        "- Use the conventional Vietnamese industry term from the glossary TM\n"
        "  (Material / Specifications / Warranty / MOQ etc.).\n"
        "- Sales phrasing must stay formal:\n"
        "    'Contact us for a quote' → 'Vui lòng liên hệ chúng tôi để được báo giá'\n"
        "      (NOT 'Liên hệ nhé').\n"
        "    'We offer free samples'  → 'Chúng tôi cung cấp mẫu miễn phí'\n"
        "      (NOT 'Tụi tôi tặng mẫu').\n"
    ),
}


def _resolve_style_block(content_type: str | None) -> str:
    """Map content_type → style overlay block. None/unknown → empty (default = pair prompt)."""
    if not content_type:
        return ""
    return TRANSLATE_STYLE_PROMPTS.get(content_type, "")


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
    # PROTECTED TOKENS — บังคับ LLM รักษา X9990X placeholder (URL/HTML/email mask)
    # ใส่เฉพาะตอนมี placeholder จริง (กัน prompt บวมเมื่อไม่จำเป็น)
    protected_hint = ""
    if mapping:
        protected_hint = (
            "\n\nPROTECTED TOKENS: tokens like X9990X / X9991X (uppercase X + 4 digits + uppercase X) "
            "are placeholders for URL/HTML/email/code. Copy them VERBATIM in the output — "
            "do not translate, drop, or add spaces inside them. All input tokens must appear in output."
        )
    # factual hint — ลด safety refusal กับ medical/anatomical text
    prompt_factual = prompt + protected_hint + (
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
            target_name = {"th": "Thai", "ja": "Japanese", "vi": "Vietnamese"}.get(target, "English")
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
            elif target == "vi":
                strict_extra = "DO NOT output any Chinese (汉字), Japanese (kana/kanji), Thai (ก-๛), or Hangul — use only Vietnamese script (Latin letters with diacritics, Đ đ Ơ ơ Ư ư), digits, and basic punctuation."
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
                elif target == "vi":
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


def _unescape_json_string(s: str) -> str:
    """Apply the standard JSON string escape rules to a captured value."""
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            nxt = s[i + 1]
            if nxt == '"':
                out.append('"')
            elif nxt == "\\":
                out.append("\\")
            elif nxt == "/":
                out.append("/")
            elif nxt == "n":
                out.append("\n")
            elif nxt == "r":
                out.append("\r")
            elif nxt == "t":
                out.append("\t")
            elif nxt == "b":
                out.append("\b")
            elif nxt == "f":
                out.append("\f")
            elif nxt == "u" and i + 5 < n:
                try:
                    out.append(chr(int(s[i + 2:i + 6], 16)))
                    i += 6
                    continue
                except ValueError:
                    out.append(c)
                    i += 1
                    continue
            else:
                # unknown escape — keep both chars
                out.append(c)
                out.append(nxt)
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _extract_items_lenient(raw: str) -> list[dict]:
    """Char-level state-machine parser for {"items": [{"id": N, "text": "..."}, ...]}.
    Tolerates unescaped `"` inside text values — the closing `"` of a text field is
    only accepted when the next non-whitespace character is `,` or `}` (the JSON-legal
    delimiters that follow a property value). Numbers and standard escapes are handled.
    Returns []  if structure can't be located."""
    items: list[dict] = []
    n = len(raw)
    # locate the "items" array
    items_kw = raw.find('"items"')
    if items_kw < 0:
        return items
    i = raw.find("[", items_kw)
    if i < 0:
        return items
    i += 1  # past `[`

    def skip_ws(p: int) -> int:
        while p < n and raw[p] in " \t\r\n":
            p += 1
        return p

    while True:
        i = skip_ws(i)
        if i >= n or raw[i] == "]":
            break
        if raw[i] == ",":
            i += 1
            continue
        if raw[i] != "{":
            i += 1
            continue
        i += 1  # past `{`
        id_val: int | None = None
        text_val: str | None = None
        while True:
            i = skip_ws(i)
            if i >= n:
                break
            if raw[i] == "}":
                i += 1
                break
            if raw[i] == ",":
                i += 1
                continue
            if raw[i] != '"':
                i += 1
                continue
            # parse key (strict — keys don't have unescaped quote issues)
            i += 1
            key_start = i
            while i < n:
                if raw[i] == "\\" and i + 1 < n:
                    i += 2
                    continue
                if raw[i] == '"':
                    break
                i += 1
            key = raw[key_start:i]
            i += 1  # past closing key quote
            i = skip_ws(i)
            if i < n and raw[i] == ":":
                i += 1
            i = skip_ws(i)
            if i >= n:
                break
            # parse value
            if raw[i] == '"':
                i += 1
                val_start = i
                while i < n:
                    if raw[i] == "\\" and i + 1 < n:
                        i += 2
                        continue
                    if raw[i] == '"':
                        # peek: real closing if next non-ws is ',' or '}'
                        j = i + 1
                        while j < n and raw[j] in " \t\r\n":
                            j += 1
                        if j < n and raw[j] in ",}":
                            val_raw = raw[val_start:i]
                            i += 1
                            break
                        # not a real terminator — treat as literal " inside text
                        i += 1
                        continue
                    i += 1
                else:
                    val_raw = raw[val_start:i]
                val = _unescape_json_string(val_raw)
                if key == "id":
                    try:
                        id_val = int(val)
                    except (ValueError, TypeError):
                        pass
                elif key == "text":
                    text_val = val
            elif raw[i].isdigit() or raw[i] == "-":
                val_start = i
                while i < n and (raw[i].isdigit() or raw[i] in "-+.eE"):
                    i += 1
                num_str = raw[val_start:i]
                if key == "id":
                    try:
                        id_val = int(num_str)
                    except ValueError:
                        pass
            else:
                # unrecognized value — skip until delimiter
                while i < n and raw[i] not in ",}":
                    i += 1
        if id_val is not None and text_val is not None:
            items.append({"id": id_val, "text": text_val})
    return items


def _strip_markdown_fence_only(raw: str) -> str:
    s = (raw or "").strip()
    if not s.startswith("```"):
        return s
    nl = s.find("\n")
    if nl > 0:
        s = s[nl + 1:]
    if s.rstrip().endswith("```"):
        s = s.rstrip()[:-3].rstrip()
    return s


def _parse_batch_json(raw: str, n: int, id_start: int = 1,
                      ids: list[int] | None = None) -> list[str | None]:
    """ids: optional explicit list — รับเฉพาะ id ที่อยู่ใน list. ถ้าไม่ใส่ → ช่วง [id_start, id_start+n-1].
    Falls back to lenient char-level parser when strict json.loads fails."""
    result: list[str | None] = [None] * n
    s = _strip_markdown_fence_only(raw)
    items = None
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            items = obj.get("items")
    except Exception:
        items = None
    if not isinstance(items, list) or not items:
        items = _extract_items_lenient(s)
        if items:
            print(f"[translate] strict json.loads failed; lenient parser recovered {len(items)} items", flush=True)
    if not isinstance(items, list) or not items:
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
    lines.append("\n\nCHARACTER PROFILES (HIGHEST PRIORITY)")
    lines.append("Each input line tagged [N|speaker=X] MUST be translated using speaker X's profile.")
    lines.append("Two different speakers MUST produce visibly different translation styles.")
    lines.append("A line without a speaker tag → neutral voice (use default style rules).")
    lines.append("")
    lines.append("PRECEDENCE: character voice OVERRIDES default greeting/expression patterns above.")
    lines.append("If a character's persona indicates rough/casual/dialect speech, use their voice")
    lines.append("(e.g., a rough character may say 'ขอบใจ' / 'บาย' / 'ว่าไง' even when default rules")
    lines.append("suggest 'ขอบคุณ' / 'ลาก่อน' / 'สวัสดี' — follow the persona, not the default).")
    lines.append("")
    lines.append("VOICE INFERENCE — ถ้าไม่มี personality ระบุ ให้อนุมานจาก gender + age + name:")
    lines.append("")
    lines.append("⚠ CRITICAL: คนไทยจริงไม่ลงท้ายทุกประโยค — particle ใส่เฉพาะตอนเหมาะสมเท่านั้น")
    lines.append("  ตัวอย่างประโยคที่ไม่ต้องมี particle (natural Thai):")
    lines.append("    'ทำอะไรอยู่' / 'ไปไหนมา' / 'อิ่มแล้ว' / 'หิวจัง' / 'ไม่รู้' / 'ไปก่อน'")
    lines.append("    คำสั่ง/อุทาน/internal thought ไม่ต้องลงท้าย")
    lines.append("  ใส่ particle เฉพาะ:")
    lines.append("    - จบประโยคแบบสุภาพ (ตอบ/ถาม คนที่เพิ่งพบ/ผู้ใหญ่/ลูกค้า) → ค่ะ/ครับ")
    lines.append("    - ขอความเห็นใจ/ทำให้นุ่ม → นะ/นะคะ/นะครับ")
    lines.append("    - ยืนยัน/เน้นความรู้สึก → จ้ะ/จ๊ะ/ล่ะ")
    lines.append("  คงไว้ตามต้นฉบับ: ถ้า JP source ไม่มีท้าย (だ/ตัดเปล่า) → TH ก็ไม่ต้องเติม")
    lines.append("                ถ้า JP มี ですね/ますね → TH ค่อยใส่ นะคะ/นะครับ")
    lines.append("")
    lines.append("GENDER → particle ลงท้ายประโยค (เมื่อเหมาะสมเท่านั้น ไม่ใช่ทุก line):")
    lines.append("  female → 'ค่ะ' (polite) / 'นะคะ' / 'จ้ะ' (casual)")
    lines.append("  male   → 'ครับ' (polite) / 'นะ' (casual) / ไม่มีท้าย")
    lines.append("  other/unspecified → neutral ตาม context")
    lines.append("")
    lines.append("AGE RANGE → สรรพนามแทนตัวเอง + เรียกคนอื่น (อ้างอิงระบบไทย 5 ช่วง):")
    lines.append("  age=child (0-12): self = 'หนู' / 'ผม' / ชื่อเล่น; เรียกคนอื่น = 'พี่' / 'ลุง/ป้า/น้า/อา'")
    lines.append("  age=teen (13-22): self = 'เรา' / 'เค้า' / 'ผม' / ชื่อเล่น; 'หนู' เฉพาะคนสนิท/ผู้ใหญ่บ้าน")
    lines.append("    เรียกคนอื่น = 'พี่' / 'เพื่อน' / 'แก' / 'ตัวเอง'")
    lines.append("  age=adult (23-39): self = 'ผม' (M) / 'ดิฉัน' (formal F) / 'ฉัน' / 'เรา' / 'พี่' (กับคนเด็กกว่า)")
    lines.append("    เรียกคนอื่น = 'คุณ' / 'พี่' / 'น้อง'")
    lines.append("  age=middle (40-59): self = 'น้า' / 'อา' / 'ลุง' (M) / 'ป้า' (F) / 'พี่' (เป็นกันเอง)")
    lines.append("    เรียกคนอื่น = 'ลูก' / 'หลาน' / 'น้อง' / 'คุณ'")
    lines.append("  age=senior (60+): self = 'ตา' / 'ปู่' (M) / 'ยาย' / 'ย่า' (F) / 'ลุง' / 'ป้า'")
    lines.append("    เรียกคนอื่น = 'ลูก' / 'หลาน' / 'หนู'")
    lines.append("  age=unspecified: default safe = 'ฉัน' (F) / 'ผม' (M)")
    lines.append("")
    lines.append("WARNINGS — สรรพนามที่เลือกผิดบ่อย:")
    lines.append("  'หนู' = เด็ก/วัยรุ่นเท่านั้น — ห้ามใช้กับ adult/middle/senior")
    lines.append("  'ป้า/ยาย/ลุง/ตา' = middle/senior เท่านั้น — ห้ามใช้กับ child/teen/adult")
    lines.append("  Persona override: ถ้า persona ระบุ 'พระสงฆ์' → 'อาตมา'; 'ราชา/ขุนนาง' → 'ข้า/เรา'; 'ยากุซ่า' → 'กู'")
    lines.append("")
    lines.append("NAME hint เสริม: 'พระ' = พระสงฆ์ + 'อาตมา'; 'ป้า/ยาย/ลุง/ปู่' prefix = senior;")
    lines.append("  'น้อง' prefix = teen; ชื่อโบราณ/ขุนนาง = formal + 'ข้า/เรา'")
    lines.append("")
    lines.append("CONSISTENCY: ห้ามใช้ 'ค่ะ/ครับ' ปนกันในตัวละครเดียว เลือกตาม gender ตลอด.")
    lines.append("Two characters with different gender MUST sound different.")
    lines.append("")
    for c in characters:
        cid = c.get("id", "")
        if not cid:
            continue
        name = (c.get("name") or "").strip()
        gender = (c.get("gender") or "").strip()
        age = (c.get("age") or "").strip()
        persona = (c.get("persona") or "").strip()
        lines.append(f"speaker={cid}:")
        if name:
            lines.append(f"   name: {name}")
        if gender:
            lines.append(f"   gender: {gender}")
        if age:
            lines.append(f"   age: {age}")
        if persona:
            lines.append(f"   personality: {persona}")
        else:
            hint = f"gender '{gender or 'unspecified'}', age '{age or 'unspecified'}', name '{name or '(no name)'}'"
            lines.append(f"   personality: (not specified — infer from {hint})")
        lines.append("")
    return "\n".join(lines)


def _build_batch_system_prompt(target: str, n: int, custom_rules: str | None,
                               characters: list[dict] | None = None,
                               id_start: int = 1,
                               ids: list[int] | None = None,
                               texts: list[str] | None = None,
                               source: str | None = None,
                               content_type: str | None = None) -> str:
    if source is None and texts is not None:
        source = _detect_source_language(texts)
    base_prompt = _resolve_prompt(source, target)
    chars_section = _build_characters_section(characters)
    style_block = _resolve_style_block(content_type)
    # narration_rule = per-line auto-rule (speaker tag present → dialogue, absent → narration)
    # ใส่เฉพาะ manga_novel ที่มี dialogue+narration ปนกัน
    narration_rule = ""
    if content_type in (None, "", "manga_novel"):
        narration_rule = (
            "\n\n═══ NARRATION DETECTION (per-line auto-rule) ═══\n"
            "- Input lines tagged [N|speaker=X] = SPOKEN by character X → use character voice + particles ตามเงื่อนไข\n"
            "- Input lines tagged [N] only (no |speaker=) = NARRATION/EXPOSITORY/CAPTION\n"
            "  → ⚠ NO sentence-ending particles (ห้าม ค่ะ/ครับ/นะ/จ้ะ)\n"
            "  → ใช้ literary register (verb stem, no polite suffix)\n"
            "  → reference characters as 'เขา/เธอ/พวกเขา' (3rd person), ไม่ใช้ 'ผม/ฉัน' ถ้าไม่ใช่ direct speech\n"
            "    [5] 部屋は静かだった         → 'ห้องเงียบสงบ'              (NOT 'ห้องเงียบสงบนะคะ')\n"
            "    [6] 彼は窓の外を見た         → 'เขามองออกไปนอกหน้าต่าง'    (NOT 'เขามองออกไปนอกหน้าต่างค่ะ')\n"
            "    [7|speaker=2] 寒いね        → 'หนาวจังเลยนะ'             (มี particle ได้ — speaker tag present)\n"
        )
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
            "\n\n═══ PROJECT-SPECIFIC RULES (ABSOLUTE OVERRIDE — HIGHEST PRIORITY) ═══\n"
            "These user-defined rules win over ALL defaults above (script rules, greeting\n"
            "patterns, character voice inference). If anything conflicts, follow THESE rules.\n"
            "This is the project's atmosphere/style — keep it intact.\n"
            "\n"
            "⚠ GLOSSARY ENTRIES (lines like 'X => Y' / 'X = Y' / 'X → Y'):\n"
            "  Y is the EXACT Thai spelling. Copy it character-for-character whenever X appears.\n"
            "  IGNORE all Japanese phonological rules when applying glossary:\n"
            "    - ん-assimilation (んだ→ง, んば→ม, んが→ง) — DO NOT apply if glossary fixed the spelling\n"
            "    - rendaku (連濁) — DO NOT apply\n"
            "    - vowel devoicing / 'natural' Thai adjustments — DO NOT apply\n"
            "  ตัวอย่าง: glossary 'ぴぴたん => ปิปิตัน'\n"
            "    source 'ぴぴたんだけ' → 'ปิปิตันเท่านั้น' (ไม่ใช่ 'ปิปิตังเท่านั้น')\n"
            "    source 'ぴぴたんは' → 'ปิปิตันก็' (ไม่ใช่ 'ปิปิตัง')\n"
            "    ตัว ん ท้ายชื่อต้องเป็น 'น' เสมอ ตามที่ user กำหนด — ห้ามเปลี่ยน\n"
            "─────────────────────────────────────────────────────────\n"
            + custom_rules.strip() + "\n"
            "─────────────────────────────────────────────────────────\n"
        )
    # ป้องกัน LLM แตะ placeholder ที่ _protect_segments สร้าง (X9990X, X9991X, ...)
    protected_tokens_rule = (
        "\n\n═══ PROTECTED TOKENS (CRITICAL — preserve verbatim) ═══\n"
        "Tokens ในรูป X9990X / X9991X / X9992X ... (ตัว X ใหญ่ + 4 หลักเลข + X ใหญ่)\n"
        "เป็น PLACEHOLDER ที่ระบบใส่ไว้แทน URL / HTML tag / email / code / domain.\n"
        "RULES:\n"
        "- ห้าม translate, ห้าม drop, ห้ามใส่ space ระหว่างตัวอักษร\n"
        "- copy verbatim ใน output ตามตำแหน่งเดิม (อาจสลับตำแหน่งตามไวยากรณ์ภาษาเป้าหมายได้ แต่ห้ามเปลี่ยน spelling)\n"
        "- จำนวน + ลำดับ token ใน output ต้องตรงกับ input (ถ้า input มี X9990X, X9991X → output ต้องมีครบทั้งคู่)\n"
        "ตัวอย่าง:\n"
        "  input:  「詳細は X9990X を見て」\n"
        "  output: 'ดูรายละเอียดที่ X9990X'  (ไม่ใช่ 'ดูรายละเอียดที่ X 9990 X' / 'ดูรายละเอียดที่ X9990' / 'ดูรายละเอียด')\n"
    )
    # ลำดับ: base → style → chars → narration → rules → schema → protected → factual
    return (base_prompt + style_block + chars_section + narration_rule
            + rules_section + schema_instruction + protected_tokens_rule + factual)


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
                          content_type: str | None = None,
                          ) -> tuple[list[str], list[str | None]]:
    n = len(texts)
    user_msg, per_item = _build_batch_user_msg(texts, speakers, id_start=id_start, ids=ids)
    system_prompt = _build_batch_system_prompt(target, n, custom_rules, characters,
                                               id_start=id_start, ids=ids, texts=texts,
                                               content_type=content_type)

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
                            content_type: str | None = None,
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
                                               id_start=id_start, ids=ids, texts=texts,
                                               content_type=content_type)

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

    parsed = _parse_batch_json(raw_response, n, id_start=id_start, ids=ids)
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
                    content_type: str | None = None,
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
            content_type=content_type,
        )
    else:
        eff_timeout = timeout if timeout is not None else TRANSLATE_BATCH_TIMEOUT
        sub_t, sub_e = _translate_batch_qwen(
            texts, target, custom_rules, eff_timeout, attempt,
            speakers=eff_speakers, characters=eff_chars, ids=ids,
            content_type=content_type,
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
        "vi": APPLE_SHORTCUT_VI,
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


# ── NLLB-200 (local HF model — PC fallback แทน Apple Translate) ──

_NLLB_LANG = {
    "th": "tha_Thai",
    "en": "eng_Latn",
    "ja": "jpn_Jpan",
    "vi": "vie_Latn",
}
_NLLB_STATE: dict = {"loaded": False, "model": None, "tokenizer": None, "device": None}


def _ensure_nllb() -> str | None:
    if _NLLB_STATE["loaded"]:
        return None
    try:
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    except ImportError as e:
        return f"transformers/torch not installed: {e}"
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[nllb] loading {NLLB_MODEL} on {device} (first call — may take a moment)...", flush=True)
        tokenizer = AutoTokenizer.from_pretrained(NLLB_MODEL)
        model = AutoModelForSeq2SeqLM.from_pretrained(NLLB_MODEL).to(device)
        model.eval()
        _NLLB_STATE["tokenizer"] = tokenizer
        _NLLB_STATE["model"] = model
        _NLLB_STATE["device"] = device
        _NLLB_STATE["loaded"] = True
        print(f"[nllb] ready on {device}", flush=True)
        return None
    except Exception as e:
        return f"nllb load failed: {e}"


def nllb_translate_text(text: str, target: str = "th") -> tuple[str, str | None]:
    text = _join_lines(text or "")
    if not text.strip():
        return "", None
    tgt_code = _NLLB_LANG.get(target)
    if not tgt_code:
        return text, f"nllb: unsupported target '{target}'"
    err = _ensure_nllb()
    if err:
        return text, err
    text_protected, mapping = _protect_segments(text)
    src = _detect_source_language(text)
    src_code = _NLLB_LANG.get(src or "", "eng_Latn")
    try:
        import torch
        tokenizer = _NLLB_STATE["tokenizer"]
        model = _NLLB_STATE["model"]
        device = _NLLB_STATE["device"]
        tokenizer.src_lang = src_code
        inputs = tokenizer(
            text_protected, return_tensors="pt", truncation=True, max_length=512,
        ).to(device)
        forced_bos = tokenizer.convert_tokens_to_ids(tgt_code)
        with torch.inference_mode():
            output_ids = model.generate(
                **inputs,
                forced_bos_token_id=forced_bos,
                max_new_tokens=512,
                num_beams=4,
            )
        out = tokenizer.batch_decode(output_ids, skip_special_tokens=True)[0]
        out = _join_lines(out)
        out = _normalize_numerals(out)
        out = _restore_segments(out, mapping)
        return out or text, None
    except Exception as e:
        return text, f"nllb: {e}"
