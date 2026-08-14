# -*- coding: utf-8 -*-
"""_sample_text_bg_colors — bg ต้องมาจากวงแหวนรอบนอกกล่อง ไม่ใช่เสียงข้างมากในกล่อง
รัน: venv/Scripts/python tests/test_bg_sampling.py

เคสหลัก: ตัวหนังสือหนา/แน่นจนพิกเซลหมึกมากกว่าพื้นภายใน bbox
→ แบบเดิม (majority ในกล่อง) จะสลับ bg เป็นสีหมึก — ring ต้องตัดสิน bg ถูก"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

from PIL import Image, ImageDraw

from pipelines import _sample_text_bg_colors


def _hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _is_light(h, floor=200):
    return all(c >= floor for c in _hex_to_rgb(h))


def _is_dark(h, ceil=80):
    return all(c <= ceil for c in _hex_to_rgb(h))


def test_dense_text_does_not_swap_bg():
    # กล่อง 100x50 บนพื้นขาว — หมึกดำกิน ~83% ภายในกล่อง (ตัวหนังสือหนา)
    # แบบ interior-majority: bg=ดำ (สลับ) / แบบ ring: bg=ขาว text=ดำ
    img = Image.new("RGB", (300, 150), "#ffffff")
    d = ImageDraw.Draw(img)
    d.rectangle([104, 54, 195, 95], fill="#111111")
    tc, bgc = _sample_text_bg_colors(img, 100, 50, 200, 100)
    assert bgc is not None and tc is not None, "ควรได้สี ไม่ใช่ None"
    assert _is_light(bgc), f"bg ควรเป็นสีพื้นรอบกล่อง (ขาว) แต่ได้ {bgc}"
    assert _is_dark(tc), f"text ควรเป็นสีหมึก (ดำ) แต่ได้ {tc}"


def test_thin_text_normal_case():
    # ตัวหนังสือบาง (~20% ของกล่อง) บนพื้นขาว — ต้องได้ bg ขาว text ดำ เหมือนเดิม
    img = Image.new("RGB", (300, 150), "#ffffff")
    d = ImageDraw.Draw(img)
    for y in (58, 70, 82):
        d.rectangle([106, y, 194, y + 4], fill="#111111")
    tc, bgc = _sample_text_bg_colors(img, 100, 50, 200, 100)
    assert bgc is not None and tc is not None, "ควรได้สี ไม่ใช่ None"
    assert _is_light(bgc), f"bg ควรขาว แต่ได้ {bgc}"
    assert _is_dark(tc), f"text ควรดำ แต่ได้ {tc}"


def test_box_at_image_corner():
    # กล่องชิดมุม (0,0) — วงแหวนเหลือแค่ด้านขวา/ล่าง ต้องไม่พังและได้สีถูก
    img = Image.new("RGB", (300, 150), "#ffffff")
    d = ImageDraw.Draw(img)
    for y in (8, 20, 32):
        d.rectangle([4, y, 96, y + 4], fill="#111111")
    tc, bgc = _sample_text_bg_colors(img, 0, 0, 100, 50)
    assert bgc is not None and tc is not None, "ควรได้สี ไม่ใช่ None"
    assert _is_light(bgc), f"bg ควรขาว แต่ได้ {bgc}"
    assert _is_dark(tc), f"text ควรดำ แต่ได้ {tc}"


def test_uniform_region_returns_none():
    # กล่องพื้นเรียบไม่มีตัวหนังสือ → (None, None) เหมือนพฤติกรรมเดิม
    img = Image.new("RGB", (300, 150), "#ffffff")
    tc, bgc = _sample_text_bg_colors(img, 100, 50, 200, 100)
    assert tc is None and bgc is None, f"ควรได้ (None, None) แต่ได้ ({tc}, {bgc})"


if __name__ == "__main__":
    tests = [
        test_dense_text_does_not_swap_bg,
        test_thin_text_normal_case,
        test_box_at_image_corner,
        test_uniform_region_returns_none,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print("---")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
