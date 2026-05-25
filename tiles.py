"""Tile pyramid generation + lookup.
Layout (per upload session):
    cache/tiles/{doc_id}/p{N}/manifest.json
    cache/tiles/{doc_id}/p{N}/thumb.png
    cache/tiles/{doc_id}/p{N}/{level}/{x}_{y}.png

Convention: level 0 = full resolution; level N = smallest (fits in one tile).
Tile size = TILE_SIZE × TILE_SIZE with 1px overlap (DZI-style) — กัน seam ระหว่าง tile.
"""
import json
import math
import shutil
from pathlib import Path

from PIL import Image

from config import (
    TILE_DIR,
    TILE_FORMAT,
    TILE_KEEP_DOCS,
    TILE_OVERLAP,
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
    """LAZY mode — save manifest + thumbnail + original PNG; tiles generated on-demand
    เมื่อ /tiles/{doc_id}/p{N}/{level}/{x}_{y}.png ถูก request ที่ route.
    Upload เร็ว (ไม่ต้องสร้างเป็นพันๆ tile บน 40000px image)."""
    if pil_img.mode != "RGB":
        pil_img = pil_img.convert("RGB")
    w, h = pil_img.size
    max_level = _max_level(w, h)

    out_dir = _page_root(doc_id, page_no)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # save original full-res — source สำหรับ on-demand tile crop
    pil_img.save(out_dir / "original.png", optimize=False)

    thumb_w = min(THUMB_WIDTH, w)
    thumb_h = max(1, round(thumb_w * h / w))
    pil_img.resize((thumb_w, thumb_h), Image.LANCZOS).save(
        out_dir / "thumb.png", optimize=True
    )

    manifest = {
        "width": w, "height": h,
        "tile_size": TILE_SIZE,
        "overlap": TILE_OVERLAP,
        "format": TILE_FORMAT,
        "max_level": max_level,
        "thumb_width": thumb_w,
        "thumb_height": thumb_h,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def get_level_path(doc_id: str, page_no: int, level: int) -> Path | None:
    """Return file path สำหรับ level PNG (full image at that resolution).
    Lazy: ถ้ายังไม่มี → derive จาก level-1 (cached). None ถ้า out of range / page missing."""
    page_dir = _page_root(doc_id, page_no)
    if not page_dir.is_dir():
        return None
    if level < 0 or level > 50:
        return None
    if level == 0:
        p = page_dir / "original.png"
        return p if p.is_file() else None
    cache_p = page_dir / f"level_{level}.png"
    if cache_p.is_file():
        return cache_p
    # derive — ensure level-1 exists แล้ว downsample
    parent = get_level_path(doc_id, page_no, level - 1)
    if parent is None:
        return None
    src = Image.open(parent)
    cw, ch = src.size
    src.resize((max(1, cw // 2), max(1, ch // 2)), Image.LANCZOS).save(cache_p, optimize=False)
    return cache_p


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
