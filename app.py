import base64
import difflib
import io
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx
from PIL import Image
Image.MAX_IMAGE_PIXELS = None  # ปลดล็อก decompression-bomb limit สำหรับรูปขนาดใหญ่

# ปลดล็อก docling-core image size limit (default 20MB) — รับรูปใหญ่ ๆ ได้
from docling_core.utils.settings import settings as _docling_core_settings
_docling_core_settings.max_image_decoded_size = 500 * 1024 * 1024  # 500MB

from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

OLLAMA_URL = "http://localhost:11434"
# correction กับ translation ใช้คนละโมเดลได้ — ปรับตามคุณภาพที่ทดสอบจริง
OLLAMA_MODEL_CORRECT = "qwen2.5:3b"     # correction: 3B follow rule แม่นกว่า
OLLAMA_MODEL_TRANSLATE = "qwen2.5:1.5b"  # translation TH: 1.5B เป็นธรรมชาติกว่าตามที่ทดสอบ
OLLAMA_MODEL = OLLAMA_MODEL_CORRECT      # backward-compat (ตัวเก่าที่อ้างถึง)

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import OcrMacOptions, PdfPipelineOptions
from docling.document_converter import (
    DocumentConverter,
    ImageFormatOption,
    PdfFormatOption,
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True

LANG_PRESETS = {
    "auto":     ["en-US", "th-TH", "ja-JP", "zh-Hans"],
    "th":       ["th-TH", "en-US"],
    "en":       ["en-US"],
    "ja":       ["ja-JP", "en-US"],
    "zh":       ["zh-Hans", "zh-Hant", "en-US"],
    "ko":       ["ko-KR", "en-US"],
    "th_en":    ["th-TH", "en-US"],
    "ja_en":    ["ja-JP", "en-US"],
}


def make_pipeline_options(kind: str, lang: str = "auto") -> PdfPipelineOptions:
    """สร้าง PipelineOptions ตามชนิดและภาษาที่ต้องการ — ปิดงานที่ไม่จำเป็นเพื่อความเร็ว"""
    po = PdfPipelineOptions()
    langs = LANG_PRESETS.get(lang, LANG_PRESETS["auto"])
    po.ocr_options = OcrMacOptions(lang=langs, recognition="accurate")
    po.generate_page_images = True
    po.images_scale = 2.0  # 144 DPI — ดีพอสำหรับ CJK + Thai OCR

    if kind == "texts":
        po.do_ocr = True
        po.do_table_structure = False  # ข้าม TableFormer (โมเดลหนัก)
    elif kind == "tables":
        po.do_ocr = True
        po.do_table_structure = True
    elif kind in ("pictures", "pages"):
        po.do_ocr = False              # ข้าม OCR
        po.do_table_structure = False  # ข้าม TableFormer
    else:  # all, groups, key_value_items, form_items
        po.do_ocr = True
        po.do_table_structure = True
    return po


_converter_cache: dict[tuple[str, str], DocumentConverter] = {}


def get_converter(kind: str, lang: str = "auto") -> DocumentConverter:
    key = (kind, lang)
    if key not in _converter_cache:
        po = make_pipeline_options(kind, lang)
        print(
            f"[docling] สร้าง converter kind={kind} lang={lang} "
            f"(ocr={po.do_ocr}, table={po.do_table_structure}, langs={po.ocr_options.lang})",
            flush=True,
        )
        _converter_cache[key] = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=po),
                InputFormat.IMAGE: ImageFormatOption(pipeline_options=po),
            }
        )
    return _converter_cache[key]


print("[docling] pre-warming converter (kind=all, lang=auto)...", flush=True)
get_converter("all", "auto")
print("[docling] พร้อมใช้งาน — converter ถูก cache ตามชนิด+ภาษา", flush=True)

ELEMENT_KEYS = ["texts", "tables", "pictures", "groups", "pages", "key_value_items", "form_items"]


def filter_document(doc_dict: dict, kind: str) -> dict:
    if kind == "all":
        return doc_dict
    if kind not in ELEMENT_KEYS:
        return doc_dict
    return {
        "schema_name": doc_dict.get("schema_name"),
        "version": doc_dict.get("version"),
        "name": doc_dict.get("name"),
        kind: doc_dict.get(kind, []),
    }


def _bbox_dict(bbox):
    return {
        "l": float(bbox.l),
        "t": float(bbox.t),
        "r": float(bbox.r),
        "b": float(bbox.b),
        "coord_origin": getattr(bbox.coord_origin, "value", str(bbox.coord_origin)),
    }


def build_preview(doc):
    pages = []
    for page_no, page in (doc.pages or {}).items():
        page_w = float(page.size.width) if page.size else None
        page_h = float(page.size.height) if page.size else None
        image_data = None
        if page.image is not None:
            pil_img = page.image.pil_image
            if pil_img is not None:
                buf = io.BytesIO()
                pil_img.save(buf, format="PNG", optimize=True)
                b64 = base64.b64encode(buf.getvalue()).decode()
                image_data = f"data:image/png;base64,{b64}"
                if page_w is None: page_w = pil_img.width
                if page_h is None: page_h = pil_img.height
        pages.append({
            "page_no": int(page_no),
            "width": page_w,
            "height": page_h,
            "image": image_data,
        })
    pages.sort(key=lambda p: p["page_no"])

    items = []

    def add_item(category, item):
        text = ""
        if category == "texts":
            text = getattr(item, "text", "") or getattr(item, "orig", "") or ""
        elif category == "tables":
            text = "[table]"
        elif category == "pictures":
            text = "[picture]"
        label = getattr(item, "label", category)
        label = getattr(label, "value", str(label))
        for prov in (getattr(item, "prov", None) or []):
            if prov.bbox is None:
                continue
            items.append({
                "self_ref": item.self_ref,
                "category": category,
                "label": label,
                "text": text,
                "page_no": prov.page_no,
                "bbox": _bbox_dict(prov.bbox),
            })

    for t in (doc.texts or []):
        add_item("texts", t)
    for t in (doc.tables or []):
        add_item("tables", t)
    for p in (doc.pictures or []):
        add_item("pictures", p)

    return {"pages": pages, "items": items}


@app.route("/")
def index():
    resp = app.make_response(render_template("index.html", types=["all"] + ELEMENT_KEYS))
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


# ───────── manga mode (mokuro: comic-text-detector + manga-ocr) ─────────
_manga_ocr = None


def get_manga_ocr():
    """lazy-load mokuro's MangaPageOcr (~400MB model download ครั้งแรก)"""
    global _manga_ocr
    if _manga_ocr is None:
        print("[manga] กำลังโหลด MangaPageOcr (อาจดาวน์โหลดโมเดลครั้งแรก)...", flush=True)
        from mokuro.manga_page_ocr import MangaPageOcr
        _manga_ocr = MangaPageOcr(force_cpu=False)
        print("[manga] พร้อมใช้งาน", flush=True)
    return _manga_ocr


def run_manga_pipeline(path: Path, filename: str):
    """แทนที่ docling ด้วย mokuro สำหรับมังงะ/ข้อความญี่ปุ่นแนวตั้ง"""
    mocr = get_manga_ocr()
    res = mocr(str(path))

    img_w = int(res["img_width"])
    img_h = int(res["img_height"])

    # โหลดภาพต้นฉบับเป็น PNG (สำหรับ preview)
    pil = Image.open(path).convert("RGB")
    if pil.size != (img_w, img_h):
        pil = pil.resize((img_w, img_h))
    buf = io.BytesIO()
    pil.save(buf, format="PNG", optimize=True)
    image_data = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    texts = []
    items = []
    for i, blk in enumerate(res.get("blocks", [])):
        x1, y1, x2, y2 = blk["box"]
        text = "\n".join(blk.get("lines", []) or [])
        texts.append({
            "self_ref": f"#/texts/{i}",
            "label": "text",
            "vertical": bool(blk.get("vertical")),
            "font_size": float(blk.get("font_size") or 0),
            "bbox": {
                "l": float(x1), "t": float(y1),
                "r": float(x2), "b": float(y2),
                "coord_origin": "TOPLEFT",
            },
            "text": text,
        })
        items.append({
            "self_ref": f"#/texts/{i}",
            "category": "texts",
            "label": "text" + (" [vertical]" if blk.get("vertical") else ""),
            "text": text,
            "page_no": 1,
            "bbox": {
                "l": float(x1), "t": float(y1),
                "r": float(x2), "b": float(y2),
                "coord_origin": "TOPLEFT",
            },
        })

    doc_dict = {
        "schema_name": "MangaPageOcr",
        "version": "1.0",
        "name": Path(filename).stem,
        "img_width": img_w,
        "img_height": img_h,
        "texts": texts,
    }
    preview = {
        "pages": [{"page_no": 1, "width": img_w, "height": img_h, "image": image_data}],
        "items": items,
    }
    return doc_dict, preview


# ───────── LLM correction (Ollama + Qwen2.5 1.5B) ─────────

PROMPT_JA = (
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
    has_jp = (_has(text, 0x3040, 0x309F)   # hiragana
              or _has(text, 0x30A0, 0x30FF)  # katakana
              or _has(text, 0x4E00, 0x9FAF)) # kanji (CJK Unified)
    if has_thai and not has_jp:
        return PROMPT_TH
    if has_jp and not has_thai:
        return PROMPT_JA
    return PROMPT_MIXED


MAX_LEN_GROWTH = 2            # อักขระที่เพิ่มขึ้นได้สูงสุด (จริง ๆ OCR fix มักทำให้สั้นลงหรือเท่าเดิม)
MAX_DELETE_RUN = 2            # ลบติดกันได้สูงสุด 2 อักขระ (เผื่อ space ซ้ำ); ลบเกินนี้ = ลบคำ
MAX_REPLACE_RUN = 1           # แทนที่ติดกันได้ 1 อักขระเท่านั้น (kanji confusion 1→1); เกินนี้ = conjugation/rewrite
MAX_INSERT_RUN = 0            # ห้าม insert ใด ๆ — OCR fix ที่ valid ไม่ควรเพิ่มอักขระ
                              # (replace = แก้ตัวผิด, delete = ลบ space/อักขระเกิน เท่านั้น)
MIN_CHAR_OVERLAP = 0.6        # ตัวอักษรร่วมต้องมีอย่างน้อย 60%
SENTENCE_ENDERS = "。、!?！？.,"  # อักขระจบประโยค/วลี — insert ติด ๆ กันก่อนตัวเหล่านี้ = verb conjugation


def _global_guard(orig: str, corrected: str) -> str | None:
    """ตรวจระดับทั้ง string — ถ้าผิดร้ายแรง (translation, rewrite ทั้งก้อน) ให้ full reject"""
    if not orig or not corrected:
        return None
    # ยาวกว่าต้นฉบับเกินไป
    if len(corrected) > len(orig) + MAX_LEN_GROWTH:
        return f"corrected longer by {len(corrected) - len(orig)} chars"
    # input สั้น output ห้ามยาวขึ้นเลย (ป้องกัน "ど。" → "です。")
    if len(orig) <= 6 and len(corrected) > len(orig):
        return f"short input grew from {len(orig)}→{len(corrected)} chars"
    # สั้นลงเกินไป
    if len(corrected) < len(orig) * 0.7:
        return "corrected significantly shorter"
    # มี latin เพิ่มในขณะต้นฉบับไม่มี → translation
    has_latin_orig = any('a' <= c.lower() <= 'z' for c in orig)
    has_latin_new = any('a' <= c.lower() <= 'z' for c in corrected)
    if has_latin_new and not has_latin_orig:
        return "added latin characters (translation?)"
    # character overlap น้อย → rewrite
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
    """ตรวจ opcode เดียว — return reason ถ้าควร reject op นี้, else None"""
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
        # ห้าม replace whitespace ด้วย non-whitespace (โมเดล hallucinate)
        # spurious space ใน Thai word ต้อง DELETE ไม่ใช่ REPLACE
        orig_seg = orig[i1:i2]
        new_seg = corrected[j1:j2]
        if orig_seg.isspace() and not new_seg.isspace():
            return f"replace whitespace with non-space {orig_seg!r} → {new_seg!r}"
        if not orig_seg.isspace() and new_seg.isspace():
            return f"replace non-space with whitespace {orig_seg!r} → {new_seg!r}"
    return None


def apply_partial_corrections(orig: str, corrected: str) -> tuple[str, int, list[str]]:
    """รวบ ops ที่ผ่าน guard, ทิ้ง ops ที่ไม่ผ่าน — return (text, accepted_count, rejected_reasons)"""
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
            out.append(orig[i1:i2])  # revert: ใช้ต้นฉบับช่วงนี้
            rejected.append(f"{tag}: {reason}")
        else:
            out.append(corrected[j1:j2])  # accept
            accepted += 1
    return "".join(out), accepted, rejected


PROMPT_CONTEXT_BASE = (
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


# legacy alias
PROMPT_CONTEXT = PROMPT_CONTEXT_BASE


def _build_context_user_msg(target: str, before: list[str], after: list[str]) -> str:
    parts: list[str] = []
    parts.extend(s.strip() for s in (before or []) if (s or "").strip())
    parts.append(f">> {target} <<")
    parts.extend(s.strip() for s in (after or []) if (s or "").strip())
    return "\n".join(parts)


def _call_ollama_correct(text: str, system_prompt: str,
                         timeout: float = 30.0) -> str:
    resp = httpx.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": OLLAMA_MODEL_CORRECT,
            "stream": False,
            "messages": [
                {"role": "system", "content": system_prompt},
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


def correct_text_with_llm(
    text: str,
    timeout: float = 30.0,
    context_before: list[str] | None = None,
    context_after: list[str] | None = None,
) -> tuple[str, str | None]:
    """ส่งข้อความให้ Ollama แก้ — return (corrected_text, error_or_none).
    ถ้ามี context (before/after) จะใช้ context-aware prompt และผ่อน guard
    """
    text = (text or "").strip()
    if not text:
        return text, None

    has_context = bool(context_before) or bool(context_after)
    try:
        if has_context:
            user_msg = _build_context_user_msg(text, context_before or [], context_after or [])
            out = _call_ollama_correct(user_msg, pick_context_prompt(text), timeout)
            out = out.strip()
            if out.startswith(">>"): out = out[2:].strip()
            if out.endswith("<<"): out = out[:-2].strip()
            # ถ้า context-mode ออกผลที่ "ทุก op ถูก reject" → fallback ไป no-context (โมเดลมักทำผิดเมื่อมี context noise)
            if out and out != text:
                gerr_test = _global_guard(text, out)
                if gerr_test:
                    print(f"[correct/ctx→fb] context output failed global guard: {gerr_test}", flush=True)
                    out = _call_ollama_correct(text, pick_prompt(text), timeout)
                else:
                    _, accepted_test, rejected_test = apply_partial_corrections(text, out)
                    if accepted_test == 0 and rejected_test:
                        print(f"[correct/ctx→fb] all ops rejected, retry no-context", flush=True)
                        out = _call_ollama_correct(text, pick_prompt(text), timeout)
        else:
            out = _call_ollama_correct(text, pick_prompt(text), timeout)

        out = out or text
        if out == text:
            return out, None

        # ── Guard ──
        gerr = _global_guard(text, out)

        if not has_context:
            if gerr:
                print(f"[correct] full reject: {gerr} | orig={text!r} | new={out!r}", flush=True)
                return text, None
            partial, accepted, rejected = apply_partial_corrections(text, out)
            if rejected:
                print(f"[correct] partial: accepted={accepted}, rejected={len(rejected)} ops: {rejected}", flush=True)
            return partial, None

        # ── Context mode ──
        # context เป็นแค่ข้อมูลช่วย LLM ตัดสินใจการ correct word-level
        # ใช้ guard เข้มเหมือน no-context mode — ไม่อนุญาตให้แทนที่ทั้งคำ
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
    # sync preview items by self_ref
    by_ref = {t.get("self_ref"): t.get("text") for t in (doc_dict.get("texts") or [])}
    for item in preview.get("items", []) or []:
        if item.get("category") == "texts":
            new_text = by_ref.get(item.get("self_ref"))
            if new_text is not None:
                item["text"] = new_text
    return n, errors


@app.route("/correct", methods=["POST"])
def correct_endpoint():
    """รับข้อความเดี่ยว ส่งไป LLM แก้ — ใช้สำหรับ progressive correction ฝั่ง client.
    Optional: context (list[str]) — ประโยคก่อนหน้า ให้ LLM ดู pattern แล้วเดาคำที่ตกหล่นได้
    """
    payload = request.get_json(silent=True) or {}
    text = payload.get("text", "")
    before = payload.get("context_before") or payload.get("context") or []
    after = payload.get("context_after") or []
    if not isinstance(before, list):
        before = [str(before)] if before else []
    if not isinstance(after, list):
        after = [str(after)] if after else []
    corrected, err = correct_text_with_llm(
        text,
        context_before=[str(s) for s in before],
        context_after=[str(s) for s in after],
    )
    if err:
        return jsonify({"corrected": text, "error": err}), 200
    return jsonify({"corrected": corrected, "original": text})


# ───────── Translation ─────────
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


# แปลงเลขไทยกลับเป็นเลขอารบิก — กันโมเดลพลาด
THAI_TO_ARABIC = str.maketrans("๐๑๒๓๔๕๖๗๘๙", "0123456789")


def _normalize_numerals(text: str) -> str:
    return text.translate(THAI_TO_ARABIC)


def _has_cjk(s: str) -> bool:
    """ตรวจว่ามีอักษร CJK (hiragana/katakana/kanji) หลุดอยู่ในข้อความหรือไม่"""
    return any(
        '぀' <= c <= 'ゟ' or   # hiragana
        '゠' <= c <= 'ヿ' or   # katakana
        '一' <= c <= '鿿' or   # CJK Unified Ideographs (kanji/汉字)
        '㐀' <= c <= '䶿'      # CJK Extension A
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
    """ตรวจว่าลำดับตัวเลขใน output ตรงกับ input หรือไม่
    OCR fix/translation ไม่ควรเปลี่ยนตัวเลข — ถ้าลำดับต่างกัน ถือว่าผิด
    """
    a = "".join(re.findall(r"[0-9]+", orig or ""))
    b = "".join(re.findall(r"[0-9]+", out or ""))
    return a != b


# Refusal patterns — โมเดลปฏิเสธการแปล (safety filter ของ Qwen ฯลฯ)
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
    """รวมบรรทัดที่ถูกตัดมาจาก OCR เป็นบรรทัดเดียวก่อนแปล
    Thai/Japanese/Chinese/Korean ไม่มี space ระหว่างคำ → \\n ระหว่างอักษรเหล่านี้ควรเป็น ""
    Latin (English) → \\n ระหว่างคำควรเป็น " "
    เคสผสม → ดูบริบทแต่ละ \\n แยก: ถ้าอักษรซ้ายและขวาของ \\n เป็น CJK/Thai → ""
    มิฉะนั้น → " "
    """
    if not text:
        return ""

    def is_asian(c: str) -> bool:
        if not c:
            return False
        return (
            '぀' <= c <= 'ゟ' or   # hiragana
            '゠' <= c <= 'ヿ' or   # katakana
            '一' <= c <= '鿿' or   # CJK
            '㐀' <= c <= '䶿' or   # CJK Ext A
            '가' <= c <= '힯' or   # Hangul
            '฀' <= c <= '๿'      # Thai
        )

    # normalize \r\n, \r, \t → \n
    text = re.sub(r"\r\n?|\t", "\n", text)
    # ยุบ \n ซ้อน
    text = re.sub(r"\n+", "\n", text)

    # แยกแต่ละ \n: ถ้าตัวอักษรรอบ ๆ เป็น Asian → join เปล่า, ไม่ใช่ → ใช้ space
    out: list[str] = []
    for i, ch in enumerate(text):
        if ch == "\n":
            left = next((text[j] for j in range(i - 1, -1, -1) if not text[j].isspace()), "")
            right = next((text[j] for j in range(i + 1, len(text)) if not text[j].isspace()), "")
            # ถ้าฝั่งใดฝั่งหนึ่งเป็น Asian script → ไม่ใส่ space
            # (เคส "ABC\nを使う" — แม้ ABC เป็น Latin แต่ฝั่ง を คือ Asian → ติดกัน)
            sep = "" if (is_asian(left) or is_asian(right)) else " "
            out.append(sep)
        else:
            out.append(ch)
    joined = "".join(out)
    # ยุบ space ซ้อน
    joined = re.sub(r" {2,}", " ", joined)
    return joined.strip()


def _call_ollama_translate(text: str, system_prompt: str,
                           timeout: float = 60.0) -> str:
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
    if not text:
        return "", None
    # ป้องกัน URL / HTML / domain / email
    text_protected, mapping = _protect_segments(text)
    prompt = TRANSLATE_PROMPTS.get(target, TRANSLATE_PROMPTS["th"])
    # เพิ่มคำสั่ง "factual translation" — ลด safety refusal กับ medical/anatomical text
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
        # restore segments ที่ป้องกันไว้ก่อนเช็ค digit guard
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


# ───────── Apple Translate (ผ่าน macOS Shortcuts CLI) ─────────
APPLE_SHORTCUT_TH = "DoclingTranslateTH"
APPLE_SHORTCUT_EN = "DoclingTranslateEN"


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


APPLE_MIN_INPUT_CHARS = 3  # < threshold นี้ Apple จับภาษาไม่ได้ → skip


# ───────── ป้องกันส่วนที่ไม่ควรแปล ─────────
# Pattern เรียงจากเฉพาะเจาะจงไปกว้าง — match ก่อนได้ก่อน
_PROTECT_PATTERNS = [
    r"<[^<>]{1,200}>",                                    # HTML/XML tags <a>, </tag>, <input ...>
    r"https?://[^\s<>\"']+",                              # URL เต็ม
    r"www\.[^\s<>\"']+",                                  # www.example.com/path
    r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",   # email
    # bare domain — เช่น example.com / sub.domain.co.th (ไม่ตามด้วย /)
    r"\b[a-zA-Z][a-zA-Z0-9-]*\.(?:com|org|net|io|dev|app|co|edu|gov|info|me|ai|tech|xyz|biz)(?:\.[a-z]{2,3})?\b",
    r"`[^`]+`",                                           # inline code `code`
]


def _protect_segments(text: str) -> tuple[str, dict[str, str]]:
    """แทนที่ส่วนที่ไม่ควรแปล (URL/HTML/email/domain/code) ด้วย placeholder
    return (protected_text, mapping เพื่อ restore กลับ)
    """
    mapping: dict[str, str] = {}
    counter = [0]

    def make_token(value: str) -> str:
        # ใช้รูป "X9990X" — Apple Translate มักรักษาตัวเลข + uppercase หลัง preserve
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
    # restore — ทำหลายรอบในกรณี placeholder ถูก concat แปลก ๆ
    for _ in range(3):
        changed = False
        for key, value in mapping.items():
            if key in text:
                text = text.replace(key, value)
                changed = True
        if not changed:
            break
    return text


def apple_translate_text(text: str, target: str = "th") -> tuple[str, str | None]:
    """แปลผ่าน Apple Translate ใน macOS Shortcut ที่ผู้ใช้สร้างไว้
    ถ้า Apple ไม่รองรับ (เช่น text สั้นเกิน detect ภาษาไม่ได้) → คืนต้นฉบับ
    """
    text = _join_lines(text or "")
    if not text:
        return "", None

    # input สั้นมาก → Apple มักจับภาษาไม่ได้และคืน error → skip ไปเลย
    stripped = text.strip()
    if len(stripped) < APPLE_MIN_INPUT_CHARS:
        return text, None

    if not _shortcuts_available():
        return text, "ไม่พบ shortcuts CLI (ต้องใช้ macOS 12+)"

    name = APPLE_SHORTCUT_TH if target == "th" else APPLE_SHORTCUT_EN
    available = _list_shortcuts()
    if name not in available:
        return text, (
            f"ยังไม่ได้สร้าง Shortcut '{name}' — ดูคำแนะนำที่ /apple-translate-setup"
        )

    # ป้องกัน URL / HTML tag / domain / email / code จากการแปลผิด
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


@app.route("/apple-translate-status", methods=["GET"])
def apple_translate_status():
    """ตรวจว่า shortcuts CLI พร้อม + Shortcut ที่จำเป็นถูกสร้างไว้หรือยัง"""
    if not _shortcuts_available():
        return jsonify({"available": False, "reason": "shortcuts CLI not found"})
    sc = _list_shortcuts()
    return jsonify({
        "available": True,
        "shortcuts": {
            "th": APPLE_SHORTCUT_TH in sc,
            "en": APPLE_SHORTCUT_EN in sc,
        },
        "required": {"th": APPLE_SHORTCUT_TH, "en": APPLE_SHORTCUT_EN},
    })


@app.route("/apple-translate-setup")
def apple_translate_setup():
    """แสดงคำแนะนำการสร้าง Shortcut"""
    return render_template(
        "apple_setup.html",
        sh_th=APPLE_SHORTCUT_TH,
        sh_en=APPLE_SHORTCUT_EN,
    )


# ───────── Fast mode (ocrmac → bbox + text) ─────────
def _merge_nearby_boxes(boxes: list[dict]) -> list[dict]:
    """รวมกล่อง OCR ที่อยู่ใกล้กัน (น่าจะเป็น paragraph/block เดียวกัน) เป็นกล่องเดียว
    เกณฑ์: vertical gap < median line height AND horizontal overlap > 30% ของกล่องที่แคบกว่า
    boxes: [{text, l, t, r, b, conf}, ...] — coord_origin = TOPLEFT
    """
    if not boxes:
        return boxes
    n = len(boxes)
    heights = sorted(b["b"] - b["t"] for b in boxes)
    median_h = heights[n // 2] if heights else 20
    v_gap_thresh = max(median_h * 0.7, 6)

    # union-find สำหรับ cluster boxes
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(n):
        bi = boxes[i]
        for j in range(i + 1, n):
            bj = boxes[j]
            # vertical gap (สมมติ TOPLEFT: t < b)
            if bi["t"] > bj["b"]:
                v_gap = bi["t"] - bj["b"]
            elif bj["t"] > bi["b"]:
                v_gap = bj["t"] - bi["b"]
            else:
                v_gap = 0
            if v_gap >= v_gap_thresh:
                continue
            # horizontal overlap
            h_overlap = min(bi["r"], bj["r"]) - max(bi["l"], bj["l"])
            min_w = min(bi["r"] - bi["l"], bj["r"] - bj["l"])
            if min_w <= 0:
                continue
            if h_overlap >= min_w * 0.3:
                union(i, j)

    # รวบรวมตาม cluster
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    merged: list[dict] = []
    for idxs in groups.values():
        cluster = [boxes[i] for i in idxs]
        cluster.sort(key=lambda b: (b["t"], b["l"]))
        l = min(c["l"] for c in cluster)
        t = min(c["t"] for c in cluster)
        r = max(c["r"] for c in cluster)
        b = max(c["b"] for c in cluster)
        # join text — ใช้ space ระหว่างชิ้น (ภายหลัง translate join_lines จะปรับให้)
        text = " ".join(c["text"] for c in cluster if c.get("text"))
        merged.append({
            "text": text, "l": l, "t": t, "r": r, "b": b,
            "conf": min(c.get("conf", 1.0) for c in cluster),
        })
    # เรียงตาม reading order (top → bottom, left → right)
    merged.sort(key=lambda b: (b["t"], b["l"]))
    return merged


def run_fast_pipeline(path: Path, filename: str, lang: str = "auto"):
    """ข้าม docling — ใช้ Apple Vision (ocrmac) ตรง ๆ เร็วกว่ามาก
    เหมาะกับงานที่ต้องการ text + bbox อย่างเร็ว (เช่น camera-style preview)
    """
    from ocrmac import ocrmac as _ocrmac

    pil = Image.open(path).convert("RGB")
    img_w, img_h = pil.size

    # เลือกภาษา OCR ตาม lang preset
    langs_map = {
        "auto":  ["en-US", "th-TH", "ja-JP", "zh-Hans"],
        "en":    ["en-US"],
        "th_en": ["th-TH", "en-US"],
        "ja_en": ["ja-JP", "en-US"],
    }
    langs = langs_map.get(lang, langs_map["auto"])

    ocr = _ocrmac.OCR(
        pil,
        recognition_level="accurate",
        language_preference=langs,
    )
    results = ocr.recognize(px=True)
    # results: list of (text, confidence, (x, y, w, h)) ใน pixel space
    # bbox y origin = bottom-left ของรูป

    # แปลงเป็น TOPLEFT เพื่อทำ clustering ง่ายขึ้น
    raw_boxes = []
    for txt, conf, (x, y, w, h) in results:
        if not txt or not txt.strip():
            continue
        raw_boxes.append({
            "text": txt,
            "l": float(x),
            "t": float(img_h - (y + h)),
            "r": float(x + w),
            "b": float(img_h - y),
            "conf": float(conf),
        })

    # รวมกล่องที่อยู่ใกล้กัน เป็น paragraph/block
    merged_boxes = _merge_nearby_boxes(raw_boxes)

    texts = []
    items = []
    for i, mb in enumerate(merged_boxes):
        ref = f"#/texts/{i}"
        bbox = {
            "l": mb["l"], "t": mb["t"], "r": mb["r"], "b": mb["b"],
            "coord_origin": "TOPLEFT",
        }
        texts.append({
            "self_ref": ref,
            "label": "text",
            "confidence": mb.get("conf", 1.0),
            "bbox": bbox,
            "text": mb["text"],
            "orig": mb["text"],
        })
        items.append({
            "self_ref": ref,
            "category": "texts",
            "label": "text",
            "text": mb["text"],
            "page_no": 1,
            "bbox": bbox,
        })

    buf = io.BytesIO()
    pil.save(buf, format="PNG", optimize=True)
    image_data = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    doc_dict = {
        "schema_name": "FastOCR",
        "version": "1.0",
        "name": Path(filename).stem,
        "img_width": img_w,
        "img_height": img_h,
        "engine": "ocrmac",
        "texts": texts,
    }
    preview = {
        "pages": [{"page_no": 1, "width": float(img_w), "height": float(img_h), "image": image_data}],
        "items": items,
    }
    return doc_dict, preview


@app.route("/translate", methods=["POST"])
def translate_endpoint():
    payload = request.get_json(silent=True) or {}
    text = payload.get("text", "")
    target = payload.get("target", "th")
    engine = payload.get("engine", "qwen")  # qwen | apple

    if engine == "apple":
        translated, err = apple_translate_text(text, target)
    else:
        translated, err = translate_text(text, target)
    if err:
        return jsonify({"translated": text, "error": err}), 200
    return jsonify({"translated": translated, "target": target, "engine": engine})


@app.route("/convert", methods=["POST"])
def convert():
    if "file" not in request.files:
        return jsonify({"error": "ไม่พบไฟล์ที่อัพโหลด"}), 400

    uploaded = request.files["file"]
    if not uploaded.filename:
        return jsonify({"error": "กรุณาเลือกไฟล์"}), 400

    kind = request.form.get("type", "all")
    lang = request.form.get("lang", "auto")
    fast = request.form.get("fast", "0") in ("1", "true", "on", "yes")
    correct = request.form.get("correct", "0") in ("1", "true", "on", "yes")

    filename = secure_filename(uploaded.filename)
    with tempfile.TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / filename
        uploaded.save(path)

        try:
            if fast:
                # โหมดเร็ว — ข้าม docling layout/table ใช้ Apple Vision ตรง ๆ
                doc_dict, preview = run_fast_pipeline(path, filename, lang)
            elif lang == "manga":
                doc_dict, preview = run_manga_pipeline(path, filename)
            else:
                result = get_converter(kind, lang).convert(str(path))
                doc = result.document
                doc_dict = doc.export_to_dict()
                preview = build_preview(doc)
        except Exception as exc:
            return jsonify({"error": f"แปลงไฟล์ไม่สำเร็จ: {exc}"}), 500

    correction_info = None
    if correct:
        n, errs = apply_correction_to_doc(doc_dict, preview)
        correction_info = {"corrected": n, "errors": errs}

    filtered = doc_dict if (fast or lang == "manga") else filter_document(doc_dict, kind)
    return jsonify({
        "json_text": json.dumps(filtered, ensure_ascii=False, indent=2),
        "preview": preview,
        "correction": correction_info,
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)
