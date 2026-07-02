# qa_check.py — deterministic validator สำหรับ output JA→TH
# ใช้คู่กับ base.py: รันหลังได้คำแปล → ถ้ามี error ส่งกลับให้ LLM แก้ (retry loop)

import re
import unicodedata

# ---- อักษรญี่ปุ่น/จีนที่ห้ามหลุด ----------------------------------------
# hiragana 3040-309F | katakana 30A0-30FF (รวม ー 30FC) | kana ext 31F0-31FF
# halfwidth kana FF66-FF9F | CJK 4E00-9FFF | CJK ExtA 3400-4DBF | 々〆 3005-3006
JP_LEAK = re.compile(
    r"[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F\u4E00-\u9FFF\u3400-\u4DBF\u3005\u3006]"
)
JP_PUNCT = re.compile(r"[「」『』。、・〜]")
THAI_DIGIT = re.compile(r"[๐-๙]")


def _digits(s: str) -> list[str]:
    # NFKC: normalize full-width １２３ → 123 ก่อนดึง digits
    return re.findall(r"\d", unicodedata.normalize("NFKC", s))


def _is_subsequence(a: list[str], b: list[str]) -> bool:
    it = iter(b)
    return all(ch in it for ch in a)


def check(source: str, output: str) -> dict:
    """คืน {'errors': [...], 'warnings': [...]} — errors ว่าง = ผ่าน"""
    errors: list[str] = []
    warnings: list[str] = []

    # 1) script leak
    leaks = sorted(set(JP_LEAK.findall(output)))
    if leaks:
        errors.append(f"Japanese/Chinese characters leaked: {leaks}")
    puncts = sorted(set(JP_PUNCT.findall(output)))
    if puncts:
        errors.append(f"Japanese punctuation leaked: {puncts}")

    # 2) digit parity
    if THAI_DIGIT.search(output):
        errors.append("Thai numerals (๐-๙) found in output")
    src_d, out_d = _digits(source), _digits(output)
    if not _is_subsequence(src_d, out_d):
        errors.append(f"digit parity broken: source={src_d} output={out_d}")
    elif len(out_d) > len(src_d):
        # เลขเกินอาจถูกต้อง (เลขคันจิ 三人 → 3 คน) — เตือนไว้ให้ human ดู
        warnings.append(f"output has extra digits (kanji numerals?): {src_d} → {out_d}")

    # 3) line parity
    if source.count("\n") != output.count("\n"):
        errors.append(
            f"line count mismatch: source={source.count(chr(10)) + 1} "
            f"output={output.count(chr(10)) + 1}"
        )

    return {"errors": errors, "warnings": warnings}


def retry_message(errors: list[str]) -> str:
    """ข้อความส่งกลับให้ LLM แก้ในรอบ retry"""
    return (
        "Your translation violated these ABSOLUTE rules:\n- "
        + "\n- ".join(errors)
        + "\nFix every violation and re-output ONLY the corrected Thai translation, "
        "keeping the same number of lines."
    )


if __name__ == "__main__":
    import sys
    # console Windows default (เช่น cp932) พิมพ์ตัวอย่างไทย/ญี่ปุ่นไม่ได้
    sys.stdout.reconfigure(encoding="utf-8")
    tests = [
        # (source, output, expect_errors)
        ("行きます", "ไปครับ", False),
        ("令和7年です", "ปีเรวะที่ 7 ครับ", False),
        ("令和7年です", "令和7年ครับ", True),           # kanji leak
        ("三人います", "มี 3 คน", False),               # extra digit = warning only
        ("25歳です", "อายุ ยี่สิบห้า ปีครับ", True),      # digits dropped
        ("１２３個", "123 ชิ้น", False),                # full-width normalize
        ("そうですね", "งั้นสินะー", True),              # ー leak
        ("「保存」を押す", "กด 「บันทึก」", True),        # JP punctuation leak
        ("こんにちは\n元気?", "สวัสดี สบายดีไหม", True),  # line merge
        ("5時に25人", "25 คนตอน 5 โมง", True),          # order broken
    ]
    for src, out, expect_err in tests:
        r = check(src, out)
        ok = bool(r["errors"]) == expect_err
        print(f"{'PASS' if ok else 'FAIL'} | {src!r} → {out!r}")
        for e in r["errors"]:
            print(f"       error: {e}")
        for w in r["warnings"]:
            print(f"       warn : {w}")
