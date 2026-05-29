"""LLM correction (Ollama Qwen / Gemini): single + batch + guards"""
import difflib

import httpx

from config import (
    GEMINI_API_KEY,
    GEMINI_MODEL,
    OLLAMA_MODEL_CORRECT,
    OLLAMA_URL,
    TRANSLATE_BATCH_NUM_CTX,
    TRANSLATE_BATCH_TIMEOUT,
    GEMINI_TIMEOUT,
)
from translate import (
    _GEMINI_RESPONSE_SCHEMA,
    _build_batch_user_msg,
    _parse_batch_json,
    _restore_segments,
)


OCR_CONTEXT_INTRO = (
    "CONTEXT: The input is raw output from an OCR system, so it may contain unnatural-sounding "
    "text caused by recognition errors — spurious spaces inserted inside or between words, "
    "visually-similar character confusions, missing or extra small marks (vowel marks, small "
    "ょ/ュ, dakuten). The ORIGINAL source was natural human-written language. If a passage reads "
    "awkwardly, grammatically broken, or unnatural for a native speaker, it is most likely an "
    "OCR error that you SHOULD fix (within the strict limits below).\n\n"
)


PROMPT_JA = (
    OCR_CONTEXT_INTRO +
    "You are a Japanese OCR validator. Your DEFAULT is to return the input UNCHANGED.\n"
    "Only modify the text if you can point to a SPECIFIC SINGLE wrong kanji "
    "(common confusions: 人/入, 末/未, 戸/戶, 日/曰, 千/干).\n\n"
    "HARD LIMITS (violating ANY of these = wrong, return input unchanged):\n"
    "- Replace AT MOST 1 character (a single wrong kanji → its single correct kanji).\n"
    "- NEVER add new characters — only REPLACE existing ones or DELETE extra ones.\n"
    "  WRONG: ブレザーと → ブレザーツと (added ツ — forbidden insertion).\n"
    "  WRONG: 飲む → 飲みます (added み, ま, す — forbidden insertion).\n"
    "- NEVER conjugate verbs (する → します is WRONG — both are valid, leave as-is).\n"
    "- NEVER change polite/casual form (です/だ, ます/る, ください/くれ — leave whatever the input has).\n"
    "- NEVER change verb tense, particles, or sentence endings.\n"
    "- NEVER translate. Katakana stays katakana (ヤクルト → ヤクルト, NOT 'Yakult').\n"
    "- Output length must equal input length ± 1.\n"
    "- If the input is short (e.g., 1–2 characters + punctuation), the output MUST NOT be longer.\n"
    "- NEVER add characters immediately before 。 、 ！ ？ — that is verb conjugation, not OCR fix.\n"
    "  Examples of FORBIDDEN endings: ど。 → です。 / する。 → します。 / た。 → でした。\n"
    "- If more than ONE character would change, you are wrong → return input unchanged.\n\n"
    "Examples:\n"
    "Input: する。\n"
    "Output: する。  (do NOT change to します。)\n\n"
    "Input: ど。\n"
    "Output: ど。  (do NOT change to です。 — short input must not grow)\n\n"
    "Input: 入り口はここです\n"
    "Output: 入り口はここです\n\n"
    "Input: 人り口はここです\n"
    "Output: 入り口はここです  (single kanji: 人 → 入)\n\n"
    "Input: ヤクルトを飲みます\n"
    "Output: ヤクルトを飲みます\n\n"
    "Output the (possibly unchanged) text ONLY. No explanation. No quotes. No preamble."
)

PROMPT_TH = (
    OCR_CONTEXT_INTRO +
    "You are a Thai OCR validator. Your DEFAULT is to return the input UNCHANGED.\n"
    "Only modify the text if you can point to a SPECIFIC error.\n\n"
    "What counts as an OCR error (you may fix these):\n"
    "- A space inserted inside a single Thai word "
    "(e.g., 'เพาะ เชื้อ' should be 'เพาะเชื้อ').\n"
    "- A clear character confusion (ๆ vs ฯ, ิ vs ี).\n\n"
    "DO NOT modify:\n"
    "- Spelling, word choice, grammar, style.\n"
    "- Punctuation, capitalization, sentence structure.\n"
    "- Spacing around English words, numbers, dates.\n"
    "- Anything you are not 100% sure is wrong.\n\n"
    "ABSOLUTE RULES:\n"
    "- NEVER translate, paraphrase, or rewrite.\n"
    "- NEVER add new characters — only REPLACE existing ones or DELETE extra spaces.\n"
    "- NEVER add, remove, or reorder words.\n"
    "- The output MUST NOT be longer than the input. Output length ≤ input length.\n"
    "- NEVER delete more than 5 characters in a row.\n"
    "- If in doubt → return input unchanged.\n\n"
    "Examples:\n"
    "Input: ปี ค.ศ. 1930 มีการเพาะเชื้อจุลินทรีย์\n"
    "Output: ปี ค.ศ. 1930 มีการเพาะเชื้อจุลินทรีย์\n\n"
    "Input: ปี ค.ศ. 1930 มีการเพาะ เชื้อจุลินทรีย์\n"
    "Output: ปี ค.ศ. 1930 มีการเพาะเชื้อจุลินทรีย์\n\n"
    "Output the (possibly unchanged) text ONLY. No explanation. No quotes. No preamble."
)

PROMPT_MIXED = (
    OCR_CONTEXT_INTRO +
    "You are an OCR validator (Thai / Japanese). Your DEFAULT is to return the input UNCHANGED.\n"
    "Only modify if you can point to a SPECIFIC error:\n"
    "- Thai: a space inserted inside a single word.\n"
    "- Japanese: a kanji that is clearly wrong in context (人/入, 末/未).\n\n"
    "DO NOT modify:\n"
    "- Anything else. Style, grammar, spelling, word choice are NOT errors.\n"
    "- Anything you are not 100% sure is wrong.\n\n"
    "ABSOLUTE RULES:\n"
    "- NEVER translate. Katakana stays katakana.\n"
    "- NEVER add new characters — only REPLACE or DELETE.\n"
    "- NEVER add, remove, or reorder words.\n"
    "- The output MUST NOT be longer than the input.\n"
    "- NEVER delete more than 5 characters in a row.\n"
    "- A real OCR fix changes 1–2 characters. If you find yourself changing more, you are wrong.\n"
    "- If in doubt → return input unchanged.\n\n"
    "Output the (possibly unchanged) text ONLY. No explanation. No quotes. No preamble."
)


def _has(text: str, lo: int, hi: int) -> bool:
    return any(lo <= ord(c) <= hi for c in text)


def pick_prompt(text: str) -> str:
    has_thai = _has(text, 0x0E00, 0x0E7F)
    has_jp = (_has(text, 0x3040, 0x309F)
              or _has(text, 0x30A0, 0x30FF)
              or _has(text, 0x4E00, 0x9FAF))
    if has_thai and not has_jp:
        return PROMPT_TH
    if has_jp and not has_thai:
        return PROMPT_JA
    return PROMPT_MIXED


# Guard thresholds — OCR fix ที่ valid ไม่ควรเพิ่มอักขระ
# replace = แก้ตัวผิด, delete = ลบ space/อักขระเกิน เท่านั้น
MAX_LEN_GROWTH = 2
MAX_DELETE_RUN = 2
MAX_REPLACE_RUN = 1
MAX_INSERT_RUN = 0
MIN_CHAR_OVERLAP = 0.6
SENTENCE_ENDERS = "。、!?！？.,"  # insert ติดกันก่อนตัวเหล่านี้ = verb conjugation


def _global_guard(orig: str, corrected: str) -> str | None:
    """ระดับทั้ง string. return reason ถ้าควร full reject, else None"""
    if not orig or not corrected:
        return None
    if len(corrected) > len(orig) + MAX_LEN_GROWTH:
        return f"corrected longer by {len(corrected) - len(orig)} chars"
    # ป้องกัน "ど。" → "です。"
    if len(orig) <= 6 and len(corrected) > len(orig):
        return f"short input grew from {len(orig)}→{len(corrected)} chars"
    if len(corrected) < len(orig) * 0.7:
        return "corrected significantly shorter"
    has_latin_orig = any('a' <= c.lower() <= 'z' for c in orig)
    has_latin_new = any('a' <= c.lower() <= 'z' for c in corrected)
    if has_latin_new and not has_latin_orig:
        return "added latin characters (translation?)"
    common = 0
    orig_chars = list(orig)
    for c in corrected:
        if c in orig_chars:
            orig_chars.remove(c)
            common += 1
    if common / max(len(orig), 1) < MIN_CHAR_OVERLAP:
        return "character overlap below threshold"
    return None


def _check_op(tag: str, i1: int, i2: int, j1: int, j2: int,
              orig: str, corrected: str) -> str | None:
    if tag == "equal":
        return None
    if tag == "delete" and (i2 - i1) > MAX_DELETE_RUN:
        return f"delete run {i2 - i1}"
    if tag == "insert":
        if (j2 - j1) > MAX_INSERT_RUN:
            return f"insert run {j2 - j1}"
        if j2 < len(corrected) and corrected[j2] in SENTENCE_ENDERS:
            return f"insert {corrected[j1:j2]!r} before '{corrected[j2]}' (verb conjugation?)"
    if tag == "replace":
        if (i2 - i1) > MAX_REPLACE_RUN or (j2 - j1) > MAX_REPLACE_RUN:
            return f"replace run {i2 - i1}→{j2 - j1}"
        if (j2 < len(corrected) and corrected[j2] in SENTENCE_ENDERS
                and (j2 - j1) > (i2 - i1)):
            return f"replace expand before '{corrected[j2]}'"
        # spurious space ใน Thai word ต้อง DELETE ไม่ใช่ REPLACE
        orig_seg = orig[i1:i2]
        new_seg = corrected[j1:j2]
        if orig_seg.isspace() and not new_seg.isspace():
            return f"replace whitespace with non-space {orig_seg!r} → {new_seg!r}"
        if not orig_seg.isspace() and new_seg.isspace():
            return f"replace non-space with whitespace {orig_seg!r} → {new_seg!r}"
    return None


def apply_partial_corrections(orig: str, corrected: str) -> tuple[str, int, list[str]]:
    """รวบ ops ที่ผ่าน guard, ทิ้ง ops ที่ไม่ผ่าน"""
    sm = difflib.SequenceMatcher(None, orig, corrected, autojunk=False)
    out: list[str] = []
    accepted = 0
    rejected: list[str] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.append(orig[i1:i2])
            continue
        reason = _check_op(tag, i1, i2, j1, j2, orig, corrected)
        if reason:
            out.append(orig[i1:i2])
            rejected.append(f"{tag}: {reason}")
        else:
            out.append(corrected[j1:j2])
            accepted += 1
    return "".join(out), accepted, rejected


PROMPT_CONTEXT_BASE = (
    OCR_CONTEXT_INTRO +
    "You correct OCR errors in the line marked >>...<<. The other lines are CONTEXT — use them "
    "to disambiguate but do NOT replace the marked line wholesale.\n\n"
    "Output ONLY the marked line's corrected value. No >> << markers, no labels, no explanation.\n"
    "NEVER translate.\n"
    "Numbers stay as Arabic digits (0-9).\n"
    "NEVER add new characters (no insertions).\n"
    "NEVER conjugate verbs, change politeness form, change particles, or rewrite.\n"
    "Most of the input characters must remain in the output.\n"
    "If unsure → output the marked line unchanged."
)

PROMPT_CONTEXT_TH = PROMPT_CONTEXT_BASE + (
    "\n\nTHAI-SPECIFIC PRIORITY:\n"
    "- Thai does NOT use spaces between words in the same sentence/clause.\n"
    "- AGGRESSIVELY remove spurious spaces that appear INSIDE a Thai word or between "
    "Thai characters that should be joined. DELETE the space — do NOT replace it with any character.\n"
    "  Example: 'การเพาะ เชื้อ' → 'การเพาะเชื้อ' (delete the space, NOT replace with letter)\n"
    "  Example: 'เธอ พบกับ' → 'เธอพบกับ' (delete the space)\n"
    "  Example: 'ทำให้สุขภาพ ของคน' → 'ทำให้สุขภาพของคน' (delete the space at line break)\n"
    "- WRONG examples (do NOT do this):\n"
    "    'เธอ พบกับ' → 'เธอดพบกับ' (replaced space with ด — FORBIDDEN, use deletion)\n"
    "- KEEP normal spacing around English words, numbers, and dates.\n"
    "- It is OK if the output is shorter than the input due to space removal — that is the desired correction.\n"
    "- For non-space changes: replace at most 1 character, never delete more than 2 chars in a row."
)

PROMPT_CONTEXT_JA = PROMPT_CONTEXT_BASE + (
    "\n\nJAPANESE-SPECIFIC RULES:\n"
    "- A real OCR fix is replacing exactly 1 wrong kanji with 1 correct kanji.\n"
    "- Output length must equal input length ± 1.\n"
    "- NEVER delete more than 2 characters in a row.\n"
    "- DO NOT translate katakana — leave katakana as-is."
)


def pick_context_prompt(text: str) -> str:
    has_thai = _has(text, 0x0E00, 0x0E7F)
    has_jp = (_has(text, 0x3040, 0x309F)
              or _has(text, 0x30A0, 0x30FF)
              or _has(text, 0x4E00, 0x9FAF))
    if has_thai and not has_jp:
        return PROMPT_CONTEXT_TH
    if has_jp and not has_thai:
        return PROMPT_CONTEXT_JA
    return PROMPT_CONTEXT_BASE


def _build_context_user_msg(target: str, before: list[str], after: list[str]) -> str:
    parts: list[str] = []
    parts.extend(s.strip() for s in (before or []) if (s or "").strip())
    parts.append(f">> {target} <<")
    parts.extend(s.strip() for s in (after or []) if (s or "").strip())
    return "\n".join(parts)


def _augment_correct_prompt(system_prompt: str, custom_rules: str | None) -> str:
    if custom_rules and custom_rules.strip():
        return (
            "ADDITIONAL CORRECTION RULES (project-specific — follow these):\n"
            + custom_rules.strip() + "\n\n"
            + system_prompt
        )
    return system_prompt


def _call_ollama_correct(text: str, system_prompt: str,
                         timeout: float = 30.0,
                         custom_rules: str | None = None) -> str:
    sp = _augment_correct_prompt(system_prompt, custom_rules)
    resp = httpx.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": OLLAMA_MODEL_CORRECT,
            "stream": False,
            "messages": [
                {"role": "system", "content": sp},
                {"role": "user", "content": text},
            ],
            "options": {"temperature": 0.0, "num_ctx": 2048, "seed": 42},
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    out = (data.get("message", {}).get("content") or "").strip()
    if out.startswith(("\"", "'", "「", "『")) and out.endswith(("\"", "'", "」", "』")):
        out = out[1:-1]
    return out


def _call_gemini_correct(text: str, system_prompt: str,
                         timeout: float = 30.0,
                         custom_rules: str | None = None) -> str:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set in .env")
    try:
        from google import genai
        from google.genai import types as gtypes
    except ImportError as e:
        raise RuntimeError(f"google-genai is not installed: {e}")

    sp = _augment_correct_prompt(system_prompt, custom_rules)
    client = genai.Client(api_key=GEMINI_API_KEY)
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=[text],
        config=gtypes.GenerateContentConfig(
            system_instruction=sp,
            temperature=0.0,
        ),
    )
    out = (response.text or "").strip()
    if out.startswith(("\"", "'", "「", "『")) and out.endswith(("\"", "'", "」", "』")):
        out = out[1:-1]
    return out


def _call_correct(text: str, system_prompt: str,
                  engine: str, timeout: float,
                  custom_rules: str | None) -> str:
    if engine == "gemini":
        return _call_gemini_correct(text, system_prompt, timeout, custom_rules)
    return _call_ollama_correct(text, system_prompt, timeout, custom_rules)


def correct_text_with_llm(
    text: str,
    timeout: float = 30.0,
    context_before: list[str] | None = None,
    context_after: list[str] | None = None,
    engine: str = "qwen",
    custom_rules: str | None = None,
) -> tuple[str, str | None]:
    """Apple ตกไป Qwen เพราะไม่มี correction. context-mode ที่ทุก op reject → fallback ไป no-context"""
    text = (text or "").strip()
    if not text:
        return text, None

    if engine not in ("qwen", "gemini"):
        engine = "qwen"

    has_context = bool(context_before) or bool(context_after)
    try:
        if has_context:
            user_msg = _build_context_user_msg(text, context_before or [], context_after or [])
            out = _call_correct(user_msg, pick_context_prompt(text), engine, timeout, custom_rules)
            out = out.strip()
            if out.startswith(">>"): out = out[2:].strip()
            if out.endswith("<<"): out = out[:-2].strip()
            if out and out != text:
                gerr_test = _global_guard(text, out)
                if gerr_test:
                    print(f"[correct/ctx→fb] context output failed global guard: {gerr_test}", flush=True)
                    out = _call_correct(text, pick_prompt(text), engine, timeout, custom_rules)
                else:
                    _, accepted_test, rejected_test = apply_partial_corrections(text, out)
                    if accepted_test == 0 and rejected_test:
                        print(f"[correct/ctx→fb] all ops rejected, retry no-context", flush=True)
                        out = _call_correct(text, pick_prompt(text), engine, timeout, custom_rules)
        else:
            out = _call_correct(text, pick_prompt(text), engine, timeout, custom_rules)

        out = out or text
        if out == text:
            return out, None

        gerr = _global_guard(text, out)

        if not has_context:
            if gerr:
                print(f"[correct] full reject: {gerr} | orig={text!r} | new={out!r}", flush=True)
                return text, None
            partial, accepted, rejected = apply_partial_corrections(text, out)
            if rejected:
                print(f"[correct] partial: accepted={accepted}, rejected={len(rejected)} ops: {rejected}", flush=True)
            return partial, None

        # context mode — guard เข้มเหมือน no-context (context เป็นแค่ข้อมูลช่วย)
        if gerr:
            print(f"[correct/ctx] reject: {gerr} | orig={text!r} | new={out!r}", flush=True)
            return text, None
        partial, accepted, rejected = apply_partial_corrections(text, out)
        if rejected:
            print(f"[correct/ctx] partial: accepted={accepted}, rejected={len(rejected)} ops: {rejected}", flush=True)
        return partial, None
    except Exception as exc:
        return text, str(exc)


def apply_correction_to_doc(doc_dict: dict, preview: dict):
    """แก้ทุก text ใน doc + preview items (in-place)"""
    errors = []
    n = 0
    for t in doc_dict.get("texts", []) or []:
        original = t.get("text") or ""
        if not original.strip():
            continue
        corrected, err = correct_text_with_llm(original)
        if err:
            errors.append(err)
            continue
        t["text"] = corrected
        t["original_text"] = original
        n += 1
    by_ref = {t.get("self_ref"): t.get("text") for t in (doc_dict.get("texts") or [])}
    for item in preview.get("items", []) or []:
        if item.get("category") == "texts":
            new_text = by_ref.get(item.get("self_ref"))
            if new_text is not None:
                item["text"] = new_text
    return n, errors


def _build_correct_batch_system_prompt(combined_text: str, n: int,
                                        custom_rules: str | None) -> str:
    base = pick_prompt(combined_text)
    schema_instruction = (
        f"\n\nBATCH MODE: You will correct exactly {n} numbered items.\n"
        f"OUTPUT (JSON ONLY — no prose, no markdown):\n"
        f'{{"items": [\n'
        f'  {{"id": 1, "text": "<corrected version of input [1]>"}},\n'
        f'  {{"id": 2, "text": "<corrected version of input [2]>"}},\n'
        f"  ...\n"
        f'  {{"id": {n}, "text": "<corrected version of input [{n}]>"}}\n'
        f"]}}\n"
        f"RULES:\n"
        f'- "items" array must contain EXACTLY {n} elements.\n'
        f'- IDs 1..{n} in ascending order, no skips, no duplicates.\n'
        f"- For each item, apply the correction rules to the text after [N].\n"
        f"- If no correction is needed, output the text unchanged.\n"
        f"- NEVER translate. NEVER paraphrase. Only fix character-level OCR errors.\n"
    )
    rules_section = ""
    if custom_rules and custom_rules.strip():
        rules_section = (
            "\n\nADDITIONAL CORRECTION RULES (project-specific — follow these):\n"
            + custom_rules.strip() + "\n"
        )
    return base + rules_section + schema_instruction


def _post_process_correct_batch(texts: list[str], parsed: list[str | None],
                                 per_item: list[dict]
                                 ) -> tuple[list[str], list[str | None]]:
    corrections: list[str] = []
    errors: list[str | None] = []
    for i, raw in enumerate(parsed):
        original = texts[i]
        mapping = per_item[i]["mapping"]

        if raw is None or not raw.strip():
            corrections.append(original)
            errors.append("missing in batch output")
            continue

        try:
            corrected = _restore_segments(raw, mapping)
            if corrected == original:
                corrections.append(corrected)
                errors.append(None)
                continue

            gerr = _global_guard(original, corrected)
            if gerr:
                corrections.append(original)
                errors.append(f"global guard: {gerr}")
                continue

            partial, accepted, rejected = apply_partial_corrections(original, corrected)
            if rejected:
                print(f"[correct-batch] partial: accepted={accepted}, rejected={len(rejected)}", flush=True)
            corrections.append(partial)
            errors.append(None)
        except Exception as e:
            corrections.append(original)
            errors.append(str(e))
    return corrections, errors


def _correct_temp_for_attempt(attempt: int) -> float:
    """attempt 0 → 0.0 (deterministic), retry → 0.3, 0.5, 0.7 (cap)"""
    return min(0.7, 0.0 + 0.3 * max(0, attempt))


def _correct_batch_qwen(texts: list[str], custom_rules: str | None,
                         timeout: float, attempt: int = 0
                         ) -> tuple[list[str], list[str | None]]:
    n = len(texts)
    user_msg, per_item = _build_batch_user_msg(texts)
    combined = "\n".join(texts)
    system_prompt = _build_correct_batch_system_prompt(combined, n, custom_rules)

    options: dict = {
        "temperature": _correct_temp_for_attempt(attempt),
        "num_ctx": TRANSLATE_BATCH_NUM_CTX,
    }
    # retry ปล่อยให้ random เพื่อได้ผลใหม่
    if attempt == 0:
        options["seed"] = 42

    try:
        resp = httpx.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL_CORRECT,
                "stream": False,
                "format": "json",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_msg},
                ],
                "options": options,
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        raw_out = (resp.json().get("message", {}).get("content") or "").strip()
        parsed = _parse_batch_json(raw_out, n)
    except Exception as e:
        return list(texts), [str(e)] * n

    return _post_process_correct_batch(texts, parsed, per_item)


def _correct_batch_gemini(texts: list[str], custom_rules: str | None,
                           timeout: float, attempt: int = 0
                           ) -> tuple[list[str], list[str | None]]:
    n = len(texts)

    if not GEMINI_API_KEY:
        return list(texts), ["GEMINI_API_KEY is not set in .env"] * n
    try:
        from google import genai
        from google.genai import types as gtypes
    except ImportError as e:
        return list(texts), [f"google-genai is not installed: {e}"] * n

    user_msg, per_item = _build_batch_user_msg(texts)
    combined = "\n".join(texts)
    system_prompt = _build_correct_batch_system_prompt(combined, n, custom_rules)

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[user_msg],
            config=gtypes.GenerateContentConfig(
                system_instruction=system_prompt,
                response_mime_type="application/json",
                response_schema=_GEMINI_RESPONSE_SCHEMA,
                temperature=_correct_temp_for_attempt(attempt),
            ),
        )
        raw_out = (response.text or "").strip()
        parsed = _parse_batch_json(raw_out, n)
    except Exception as e:
        return list(texts), [f"gemini: {e}"] * n

    return _post_process_correct_batch(texts, parsed, per_item)


def correct_batch(texts: list[str], engine: str = "qwen",
                  custom_rules: str | None = None,
                  timeout: float | None = None,
                  attempt: int = 0
                  ) -> tuple[list[str], list[str | None]]:
    """แก้ OCR errors หลายข้อความใน 1 LLM call. apple → fallback เป็น qwen"""
    if not texts:
        return [], []

    if engine not in ("qwen", "gemini"):
        engine = "qwen"

    n = len(texts)
    work_idxs: list[int] = []
    work_texts: list[str] = []
    for i, t in enumerate(texts):
        if t and t.strip():
            work_idxs.append(i)
            work_texts.append(t)

    corrections: list[str] = list(texts)
    errors: list[str | None] = [None] * n

    if not work_texts:
        return corrections, errors

    if engine == "gemini":
        eff_timeout = timeout if timeout is not None else GEMINI_TIMEOUT
        sub_c, sub_e = _correct_batch_gemini(work_texts, custom_rules, eff_timeout, attempt)
    else:
        eff_timeout = timeout if timeout is not None else TRANSLATE_BATCH_TIMEOUT
        sub_c, sub_e = _correct_batch_qwen(work_texts, custom_rules, eff_timeout, attempt)

    for j, orig_idx in enumerate(work_idxs):
        corrections[orig_idx] = sub_c[j]
        errors[orig_idx] = sub_e[j]

    n_ok = sum(1 for e in errors if e is None)
    print(f"[correct-batch] engine={engine} n={n} ok={n_ok} fail={n - n_ok} attempt={attempt}", flush=True)
    return corrections, errors
