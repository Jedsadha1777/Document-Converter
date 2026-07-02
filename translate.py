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

from prompts.jp_th import (
    base as _jp_th_base,
    manga_novel as _jp_th_manga_novel,
    tutorial as _jp_th_tutorial,
)
from prompts.en_vn import (
    base as _en_vn_base,
    product_catalog as _en_vn_product_catalog,
)
from prompts.en_th import base as _en_th_base
from prompts.th_en import base as _th_en_base
from prompts import universal as _universal
from prompts import generic_styles as _generic_styles
from prompts import characters as _characters
from prompts import sections as _sections
from prompts.jp_th import qa_check as _jp_th_qa
from prompts.en_th import qa_check as _en_th_qa
from prompts.en_vn import qa_check as _en_vn_qa

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
    EMOTION_AUTO,
    SPEAKER_AUTO,
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


_LINE_PREFIX_RE = re.compile(r"^\s*\[?\s*line\s+\d+\s*\]?\s*[:：]\s*", re.IGNORECASE)


def _strip_line_prefix(s: str) -> str:
    return _LINE_PREFIX_RE.sub("", s) if s else s


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


TRANSLATE_PROMPTS = _universal.TRANSLATE_PROMPTS


# Source-tailored prompts — picked when the input batch is clearly mono-script
# (e.g., pure English → Thai). Trims the JP-source-specific rules (katakana
# transliteration, kanji-name handling, Chinese-leak guards) that bloat the JSON.
# Fallback for unknown / mixed / Japanese source is TRANSLATE_PROMPTS above.
TRANSLATE_PROMPTS_BY_PAIR = {
    ("en", "th"): _en_th_base.PROMPT,
    ("en", "vi"): _en_vn_base.PROMPT,
    ("th", "en"): _th_en_base.PROMPT,
    ("ja", "th"): _jp_th_base.PROMPT,
}


def _resolve_prompt(source: str | None, target: str) -> str:
    """Pick source-tailored prompt if available, else fall back to the universal one."""
    if source:
        pair_prompt = TRANSLATE_PROMPTS_BY_PAIR.get((source, target))
        if pair_prompt:
            return pair_prompt
    return TRANSLATE_PROMPTS.get(target, TRANSLATE_PROMPTS["th"])


def _fill_prompt_slots(prompt: str, has_characters: bool = False,
                       has_glossary: bool = False) -> str:
    """เติม slot {{CHARACTER_PROFILES}}/{{GLOSSARY}} ของ pair prompt (v2).
    str.replace ตามที่ไฟล์ prompt กำหนด — .format ชนวงเล็บปีกกาใน JSON examples.
    ข้อมูลจริงถูก append เป็น section ท้าย prompt (positional override)
    จึงเติมเป็น pointer/'(none)' แทนการซ้ำเนื้อหา"""
    chars_fill = ("(see the CHARACTER PROFILES section near the end of this prompt)"
                  if has_characters else "(none — use default style rules)")
    gloss_fill = ("(see the PROJECT-SPECIFIC RULES section below)"
                  if has_glossary else "(none)")
    return (prompt.replace("{{CHARACTER_PROFILES}}", chars_fill)
                  .replace("{{GLOSSARY}}", gloss_fill))


_PAIR_QA_MODULES = {
    ("ja", "th"): _jp_th_qa,
    ("en", "th"): _en_th_qa,
    ("en", "vi"): _en_vn_qa,
}


def _run_pair_qa(source: str | None, target: str, src_text: str, out_text: str,
                 forbid_final_particles: bool = False) -> dict | None:
    """deterministic validator ต่อคู่ภาษา — {'errors','warnings'} หรือ None ถ้าไม่มี validator
    validator พังห้ามทำการแปลพัง → exception กลืนเป็น None"""
    mod = _PAIR_QA_MODULES.get((source, target))
    if mod is None:
        return None
    try:
        if mod is _en_th_qa:
            return mod.check(src_text, out_text, source_lang="en")
        if mod is _en_vn_qa:
            return mod.check(src_text, out_text, source_lang="en", target_lang="vi",
                             forbid_final_particles=forbid_final_particles)
        return mod.check(src_text, out_text)
    except Exception as e:
        print(f"[qa_check] validator error ({source}->{target}): {e}", flush=True)
        return None


# content-type style overlays — layer บน pair prompt, เลือกผ่าน content_type payload
# manga_novel: target-aware (Thai version mentions ค่ะ/ครับ; non-Thai version stays language-neutral)
# ดู _resolve_style_block สำหรับ dispatch ที่แท้จริง
TRANSLATE_STYLE_PROMPTS = {
    "manga_novel_th": _jp_th_manga_novel.PROMPT,
    "manga_novel_generic":  _generic_styles.MANGA_NOVEL,
    "tutorial_jp_th": _jp_th_tutorial.PROMPT,
    "tutorial_generic":  _generic_styles.TUTORIAL,
    "product_catalog_en_vn": _en_vn_product_catalog.PROMPT,
    "product_catalog_generic":  _generic_styles.PRODUCT_CATALOG,
}


def _resolve_style_block(content_type: str | None, target: str = "th",
                         source: str | None = None) -> str:
    """Map content_type → style overlay block. None/unknown → empty.
    dispatch ตามคู่ภาษา: ไฟล์เฉพาะคู่ใช้เมื่อ source/target ตรงเท่านั้น มิฉะนั้น generic
    (กันกติกาญี่ปุ่นหลุดเข้า prompt คู่ en และ starter glossary เวียดนามหลุดเข้าคู่อื่น)"""
    if not content_type:
        return ""
    if content_type == "manga_novel":
        key = "manga_novel_th" if target == "th" else "manga_novel_generic"
        return TRANSLATE_STYLE_PROMPTS.get(key, "")
    if content_type == "tutorial":
        key = "tutorial_jp_th" if (source, target) == ("ja", "th") else "tutorial_generic"
        return TRANSLATE_STYLE_PROMPTS.get(key, "")
    if content_type == "product_catalog":
        key = "product_catalog_en_vn" if (source, target) == ("en", "vi") else "product_catalog_generic"
        return TRANSLATE_STYLE_PROMPTS.get(key, "")
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
    prompt = _fill_prompt_slots(_resolve_prompt(source, target))
    # PROTECTED TOKENS — บังคับ LLM รักษา X9990X placeholder (URL/HTML/email mask)
    # ใส่เฉพาะตอนมี placeholder จริง (กัน prompt บวมเมื่อไม่จำเป็น)
    protected_hint = _sections.PROTECTED_HINT_SINGLE if mapping else ""
    # factual hint — ลด safety refusal กับ medical/anatomical text
    prompt_factual = prompt + protected_hint + _sections.FACTUAL_SINGLE
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
        # ตรวจก่อน restore — เทียบกับ text_protected ฝั่งเดียวกัน กัน false positive
        # จาก URL/email ที่ถูก restore กลับ
        qa = _run_pair_qa(source, target, text_protected, out)
        if qa and qa["errors"]:
            print(f"[translate] qa_check failed: {qa['errors']} — retry", flush=True)
            qa_mod = _PAIR_QA_MODULES[(source, target)]
            retry_out = _call_ollama_translate(
                text_protected,
                prompt_factual + "\n\n" + qa_mod.retry_message(qa["errors"]),
                timeout,
            )
            retry_out = _normalize_numerals(_join_lines(retry_out or ""))
            qa2 = _run_pair_qa(source, target, text_protected, retry_out)
            if retry_out and qa2 is not None and len(qa2["errors"]) < len(qa["errors"]):
                out = retry_out
            else:
                print("[translate] qa retry not better, keeping first output", flush=True)
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
                          emotions: list[str | None] | None = None,
                          ) -> tuple[str, list[dict]]:
    """[N]-prefixed lines (text format ประหยัด token กว่า JSON).
    speakers (optional): tag {speaker=X} หลัง [N] เพื่อ persona voice.
    emotions (optional): tag {emotion=Y} หรือ {emotion=?} (auto) หลัง speaker
    id_start: chunk-aware numbering สำหรับเคส ids ติดกัน
    ids (optional): explicit per-text id list — รองรับ sparse / row id ตามจริง.
    text ที่ไม่มีตัวอักษร/ตัวเลข (dots-only) ส่งเป็น empty `[N] ` กัน LLM แปล junk"""
    lines = []
    per_item = []
    for i, t in enumerate(texts):
        sp = (speakers[i] if speakers and i < len(speakers) else None)
        emo = (emotions[i] if emotions and i < len(emotions) else None)
        # SKIP / dots-only / empty → ส่ง content ว่าง (ประหยัด token, LLM ไม่แปล junk)
        if sp == SPEAKER_SKIP or not _is_translatable(t):
            protected = ""
            mapping = {}
        else:
            clean = _join_lines(t or "")
            protected, mapping = _protect_segments(clean)
            protected = re.sub(r"\s*\n+\s*", " ", protected).strip()
        gid = ids[i] if ids else (id_start + i)
        # build prefix components
        parts = [str(gid)]
        if sp == SPEAKER_AUTO:
            # ? marker → LLM เลือก character จาก profiles เอง (ไม่ใช่ narration)
            parts.append("speaker=?")
        elif sp and sp != SPEAKER_SKIP:
            parts.append(f"speaker={sp}")
        # emotion: append เฉพาะเมื่อ row ไม่ skip — auto = ? marker, ค่า explicit = ใส่ string ตรงๆ
        if sp != SPEAKER_SKIP and emo:
            if emo == EMOTION_AUTO:
                parts.append("emotion=?")
            else:
                parts.append(f"emotion={emo}")
        prefix = f"[{'|'.join(parts)}]"
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


_build_characters_section = _characters._build_characters_section
_infer_persona_text = _characters._infer_persona_text


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
    # target ส่งให้ characters section เพื่อ gate Thai-specific particle/pronoun rules
    # (ห้าม leak เข้า en/vi output)
    chars_section = _build_characters_section(characters, target)
    style_block = _resolve_style_block(content_type, target, source)
    # narration_rule = per-line auto-rule (speaker tag present → dialogue, absent → narration)
    # ใส่เฉพาะ manga_novel ที่มี dialogue+narration ปนกัน. target-dispatch กัน Thai examples
    # leak เข้า output ภาษาอื่น (en/vi) ตอน user เลือก manga_novel นอก target=th
    narration_rule = ""
    if content_type in (None, "", "manga_novel"):
        narration_rule = (_sections.NARRATION_RULE_TH if target == "th"
                          else _sections.NARRATION_RULE_GENERIC)
    ids_to_use = ids if ids else list(range(id_start, id_start + n))
    schema_instruction = _sections.build_batch_schema(n, ids_to_use)
    factual = _sections.FACTUAL_BATCH
    rules_section = _sections.build_rules_section(custom_rules)
    protected_tokens_rule = _sections.PROTECTED_TOKENS_RULE
    base_prompt = _fill_prompt_slots(base_prompt, bool(chars_section), bool(rules_section))
    # Order: base → style → narration → rules → chars → schema → protected → factual
    # — chars หลัง rules: positional override (LLM ตีความ section ล่างชนะเมื่อ conflict กับ section บน)
    #   เลย apply character voice ทับ TM rules ได้ตรงตาม PRECEDENCE ที่เขียนไว้
    # — schema/protected/factual ต่อหลัง chars: เป็น mechanical formatting (JSON shape,
    #   placeholder preservation, "translate factually") ไม่ touched register → ไม่กระทบ chars
    return (base_prompt + style_block + narration_rule + rules_section
            + chars_section + schema_instruction + protected_tokens_rule + factual)


def _post_process_batch(texts: list[str], parsed: list[str | None],
                        per_item: list[dict], target: str,
                        source: str | None = None,
                        content_type: str | None = None
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
            t = _strip_line_prefix(t)
            t = _normalize_numerals(t)
            t = _restore_segments(t, mapping)

            warnings: list[str] = []
            if _is_refusal(t):
                warnings.append("refusal")
            if _output_has_unwanted_script(target, t):
                warnings.append("foreign_script")
            if _digits_changed(original, t):
                warnings.append("digit_mismatch")
            if original.strip():
                # qa marker ต้องเป็นตัวท้ายสุดของ warnings — build_qa_retry_message
                # ตัด string จากตำแหน่ง "qa: " ถึงจบ
                qa = _run_pair_qa(source, target, _join_lines(original), t,
                                  forbid_final_particles=(content_type == "product_catalog"))
                if qa and qa["errors"]:
                    warnings.append("qa: " + " | ".join(qa["errors"]))

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
                          emotions: list[str | None] | None = None,
                          ) -> tuple[list[str], list[str | None]]:
    n = len(texts)
    user_msg, per_item = _build_batch_user_msg(texts, speakers, id_start=id_start, ids=ids, emotions=emotions)
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
        # ห้าม return list(texts) — frontend จะมอง tr+er เป็น success(warning) ไม่ retry
        # → ต้นฉบับญี่ปุ่นหลุดเข้า translations[ref] ปลอมเป็นคำแปล
        return [""] * n, [str(e)] * n

    return _post_process_batch(texts, parsed, per_item, target,
                               source=_detect_source_language(texts),
                               content_type=content_type)


_GEMINI_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "text": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Complete translation of the entire input item — every sentence, full length. Never empty, never shortened.",
                    },
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
                            emotions: list[str | None] | None = None,
                            ) -> tuple[list[str], list[str | None]]:
    n = len(texts)

    if not GEMINI_API_KEY:
        return [""] * n, ["GEMINI_API_KEY is not set in .env"] * n

    try:
        from google import genai
        from google.genai import types as gtypes
    except ImportError as e:
        return [""] * n, [f"google-genai is not installed: {e}"] * n

    user_msg, per_item = _build_batch_user_msg(texts, speakers, id_start=id_start, ids=ids, emotions=emotions)
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
        # empty (ไม่ใช่ original) → frontend retry ได้ ไม่หลุดเป็น success(warning)
        return [""] * n, [f"gemini: {e}"] * n

    return _post_process_batch(texts, parsed, per_item, target,
                               source=_detect_source_language(texts),
                               content_type=content_type)


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
                       emotions: list[str | None] | None = None,
                       content_type: str | None = None,
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
    emo_list: list[str | None] = list(emotions) if emotions else [None] * n
    if len(emo_list) < n:
        emo_list += [None] * (n - len(emo_list))
    _, per_item = _build_batch_user_msg(texts, eff_speakers, id_start=id_start, ids=ids, emotions=emo_list)

    parsed = _parse_batch_json(raw_response, n, id_start=id_start, ids=ids)
    sub_t, sub_e = _post_process_batch(list(texts), parsed, per_item, target,
                                       source=_detect_source_language(texts),
                                       content_type=content_type)

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


def build_qa_retry_message(ids: list[int], errors: list[str | None],
                           total: int) -> str | None:
    """รวม qa error รายบรรทัดเป็นข้อความ follow-up ให้ user วางต่อในแชท LLM เดิม
    (manual flow retry ในตัวไม่ได้) — อาศัยว่า qa marker เป็น warning ตัวท้ายสุดเสมอ"""
    items = []
    for i, err in enumerate(errors):
        if not err:
            continue
        pos = err.find("qa: ")
        if pos == -1:
            continue
        item_id = ids[i] if i < len(ids) else i + 1
        items.append(f"- id {item_id}: {err[pos + 4:]}")
    if not items:
        return None
    return (
        "Some translated items violated ABSOLUTE rules from my first message:\n"
        + "\n".join(items)
        + f"\n\nRe-output the COMPLETE JSON with ALL {total} items — same ids, same schema, "
        "same order — correcting the flagged items and keeping the rest unchanged.\n"
        "All rules from my first message (CHARACTER PROFILES, PROJECT-SPECIFIC RULES, "
        "GLOSSARY, LINE PARITY, NUMBERS) still apply."
    )


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
                    emotions: list[str | None] | None = None,
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
        # __auto__ = LLM ต้องเห็น character profiles ทั้งหมดเพื่อเลือก → include all
        if SPEAKER_AUTO in used_ids:
            eff_chars = list(characters)
        else:
            eff_chars = [c for c in characters if c.get("id") in used_ids]
    else:
        eff_chars = None
    has_speaker = has_real_speaker

    emo_list: list[str | None] = list(emotions) if emotions else [None] * n
    if len(emo_list) < n:
        emo_list += [None] * (n - len(emo_list))

    if engine == "gemini":
        eff_timeout = timeout if timeout is not None else GEMINI_TIMEOUT
        sub_t, sub_e = _translate_batch_gemini(
            texts, target, custom_rules, eff_timeout, attempt,
            speakers=eff_speakers, characters=eff_chars, ids=ids,
            content_type=content_type, emotions=emo_list,
        )
    else:
        eff_timeout = timeout if timeout is not None else TRANSLATE_BATCH_TIMEOUT
        sub_t, sub_e = _translate_batch_qwen(
            texts, target, custom_rules, eff_timeout, attempt,
            speakers=eff_speakers, characters=eff_chars, ids=ids,
            content_type=content_type, emotions=emo_list,
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
