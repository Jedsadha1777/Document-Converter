"""OCR pipelines: docling (default) + manga (mokuro) + fast (ocrmac direct)"""
import base64
import io
from pathlib import Path

from PIL import Image
Image.MAX_IMAGE_PIXELS = None

# ปลดล็อก docling-core image size limit (default 20MB)
from docling_core.utils.settings import settings as _docling_core_settings
_docling_core_settings.max_image_decoded_size = 500 * 1024 * 1024

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import EasyOcrOptions, PdfPipelineOptions
from docling.document_converter import (
    DocumentConverter,
    ImageFormatOption,
    PdfFormatOption,
)

from config import LANG_PRESETS, OCR_ENGINES, OCRMAC_LANG_PRESETS, ELEMENT_KEYS

try:
    from docling.datamodel.pipeline_options import OcrMacOptions  # macOS only
    _OCRMAC_OPTIONS_AVAILABLE = True
except Exception:
    OcrMacOptions = None  # type: ignore[assignment]
    _OCRMAC_OPTIONS_AVAILABLE = False


def _ocrmac_available() -> bool:
    if not _OCRMAC_OPTIONS_AVAILABLE:
        return False
    try:
        import ocrmac  # noqa: F401
        return True
    except Exception:
        return False


OCRMAC_AVAILABLE = _ocrmac_available()


def make_pipeline_options(kind: str, lang: str = "auto",
                          engine: str = "easyocr") -> PdfPipelineOptions:
    """ปิดงานที่ไม่จำเป็นเพื่อความเร็ว"""
    po = PdfPipelineOptions()

    if engine == "ocrmac" and OCRMAC_AVAILABLE:
        langs = OCRMAC_LANG_PRESETS.get(lang, OCRMAC_LANG_PRESETS["auto"])
        po.ocr_options = OcrMacOptions(lang=langs)
    else:
        langs = LANG_PRESETS.get(lang, LANG_PRESETS["auto"])
        po.ocr_options = EasyOcrOptions(lang=langs)

    po.generate_page_images = True
    po.images_scale = 2.0  # 144 DPI — ดีพอสำหรับ CJK + Thai OCR

    if kind == "texts":
        po.do_ocr = True
        po.do_table_structure = False
    elif kind == "tables":
        po.do_ocr = True
        po.do_table_structure = True
    elif kind in ("pictures", "pages"):
        po.do_ocr = False
        po.do_table_structure = False
    else:
        po.do_ocr = True
        po.do_table_structure = True
    return po


_converter_cache: dict[tuple[str, str, str], DocumentConverter] = {}


def get_converter(kind: str, lang: str = "auto",
                  engine: str = "easyocr") -> DocumentConverter:
    if engine not in OCR_ENGINES:
        engine = "easyocr"
    if engine == "ocrmac" and not OCRMAC_AVAILABLE:
        engine = "easyocr"
    key = (kind, lang, engine)
    if key not in _converter_cache:
        po = make_pipeline_options(kind, lang, engine)
        print(
            f"[docling] สร้าง converter kind={kind} lang={lang} engine={engine} "
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


# ── manga mode (mokuro: comic-text-detector + manga-ocr) ──
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


# ── fast mode (ocrmac → bbox + text) ──

def _merge_nearby_boxes(boxes: list[dict]) -> list[dict]:
    """รวมกล่อง OCR ที่อยู่ใกล้กันเป็นกล่องเดียว (น่าจะเป็น paragraph/block เดียวกัน).
    เกณฑ์: vertical gap < median line height AND horizontal overlap > 30% ของกล่องที่แคบกว่า.
    boxes: coord_origin = TOPLEFT"""
    if not boxes:
        return boxes
    n = len(boxes)
    heights = sorted(b["b"] - b["t"] for b in boxes)
    median_h = heights[n // 2] if heights else 20
    v_gap_thresh = max(median_h * 0.7, 6)

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
            if bi["t"] > bj["b"]:
                v_gap = bi["t"] - bj["b"]
            elif bj["t"] > bi["b"]:
                v_gap = bj["t"] - bi["b"]
            else:
                v_gap = 0
            if v_gap >= v_gap_thresh:
                continue
            h_overlap = min(bi["r"], bj["r"]) - max(bi["l"], bj["l"])
            min_w = min(bi["r"] - bi["l"], bj["r"] - bj["l"])
            if min_w <= 0:
                continue
            if h_overlap >= min_w * 0.3:
                union(i, j)

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
        text = " ".join(c["text"] for c in cluster if c.get("text"))
        merged.append({
            "text": text, "l": l, "t": t, "r": r, "b": b,
            "conf": min(c.get("conf", 1.0) for c in cluster),
        })
    # reading order: top → bottom, left → right
    merged.sort(key=lambda b: (b["t"], b["l"]))
    return merged


def run_fast_pipeline(path: Path, filename: str, lang: str = "auto"):
    """ข้าม docling — ใช้ Apple Vision (ocrmac) ตรง ๆ เร็วกว่ามาก"""
    from ocrmac import ocrmac as _ocrmac

    pil = Image.open(path).convert("RGB")
    img_w, img_h = pil.size

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
    # results: [(text, confidence, (x, y, w, h))] — y origin = bottom-left ของรูป

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
