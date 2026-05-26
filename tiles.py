"""Per-page asset cache for visual preview.
Layout (per upload session):
    cache/tiles/{doc_id}/p{N}/manifest.json   — image dims + max_level (client clamp)
    cache/tiles/{doc_id}/p{N}/thumb.png       — small preview สำหรับ thumbnail sidebar
    cache/tiles/{doc_id}/p{N}/original.png    — full-res, client (WASM stb_image_resize2)
                                                downsample เองตาม zoom level (no server-side caching).

max_level = log2 ของ max_dim / TILE_SIZE — clamp ให้ pickLevel ไม่ลึกเกินจำเป็น.
"""
import json
import math
import shutil
from pathlib import Path

from PIL import Image

from config import (
    TILE_DIR,
    TILE_KEEP_DOCS,
    TILE_SIZE,
    THUMB_WIDTH,
)


def _doc_root(doc_id: str) -> Path:
    return Path(TILE_DIR) / doc_id


def _page_root(doc_id: str, page_no: int) -> Path:
    return _doc_root(doc_id) / f"p{page_no}"


def _max_level(w: int, h: int) -> int:
    """smallest non-negative level where max(w, h) at that level <= TILE_SIZE.
    level 0 = full size; +1 level = half each dim."""
    max_dim = max(w, h)
    if max_dim <= TILE_SIZE:
        return 0
    return int(math.ceil(math.log2(max_dim / TILE_SIZE)))


def generate_page_pyramid(pil_img: Image.Image, doc_id: str, page_no: int) -> dict:
    """Save original.png + thumb.png + manifest.json (ครั้งเดียวต่อ upload).
    ไม่ใส่ derived-level บน disk — client (WASM) downsample เอง."""
    if pil_img.mode != "RGB":
        pil_img = pil_img.convert("RGB")
    w, h = pil_img.size

    out_dir = _page_root(doc_id, page_no)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    pil_img.save(out_dir / "original.png", optimize=False)

    thumb_w = min(THUMB_WIDTH, w)
    thumb_h = max(1, round(thumb_w * h / w))
    pil_img.resize((thumb_w, thumb_h), Image.LANCZOS).save(
        out_dir / "thumb.png", optimize=True
    )

    manifest = {
        "width": w, "height": h,
        "max_level": _max_level(w, h),
        "thumb_width": thumb_w,
        "thumb_height": thumb_h,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def get_original_path(doc_id: str, page_no: int) -> Path | None:
    """Return path ของ original.png — full-res, สำหรับ client (WASM) downsample เอง."""
    p = _page_root(doc_id, page_no) / "original.png"
    return p if p.is_file() else None


def get_manifest_path(doc_id: str, page_no: int) -> Path | None:
    p = _page_root(doc_id, page_no) / "manifest.json"
    return p if p.is_file() else None


def get_thumb_path(doc_id: str, page_no: int) -> Path | None:
    p = _page_root(doc_id, page_no) / "thumb.png"
    return p if p.is_file() else None


def cleanup_old_docs(keep_recent: int = TILE_KEEP_DOCS) -> int:
    """ลบ doc tile dirs เก่า เก็บแค่ N ที่ใหม่สุด (sort by mtime). Returns # deleted.
    เรียกตอน upload ใหม่กัน disk บวมเมื่อใช้งานยาว"""
    root = Path(TILE_DIR)
    if not root.exists():
        return 0
    dirs = sorted(
        [d for d in root.iterdir() if d.is_dir()],
        key=lambda d: d.stat().st_mtime,
        reverse=True,
    )
    n_deleted = 0
    for d in dirs[keep_recent:]:
        shutil.rmtree(d, ignore_errors=True)
        n_deleted += 1
    return n_deleted
