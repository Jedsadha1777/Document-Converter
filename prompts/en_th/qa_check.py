# qa_check.py — deterministic validator สำหรับ output →TH
# รองรับ source_lang='ja' และ 'en' — รันหลังได้คำแปล → มี errors ส่งกลับให้ LLM แก้

import re
import unicodedata

# ---- JA: อักษรญี่ปุ่น/จีนที่ห้ามหลุด --------------------------------------
JP_LEAK = re.compile(
    r"[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F\u4E00-\u9FFF\u3400-\u4DBF\u3005\u3006]"
)
JP_PUNCT = re.compile(r"[「」『』。、・〜]")

# ---- EN: ตรวจอังกฤษตกค้าง --------------------------------------------------
# stopwords โผล่เดี่ยวๆ = สัญญาณแรงว่าบรรทัดนั้นยังไม่ได้แปล → error
EN_STOPWORDS = {
    "the", "and", "is", "are", "was", "were", "be", "been", "you", "your",
    "this", "that", "these", "those", "with", "from", "have", "has", "had",
    "will", "would", "could", "should", "not", "for", "but", "they", "she",
    "he", "his", "her", "its", "our", "their", "what", "when", "where",
    "why", "how", "can", "all", "there", "which", "into", "about", "than",
    "then", "them", "who", "does", "did", "very", "just", "also",
}
# แบรนด์/ศัพท์ที่อนุญาตเพิ่มได้ผ่านพารามิเตอร์ latin_allowlist
DEFAULT_ALLOWLIST = {
    "google", "microsoft", "iphone", "ipad", "android", "windows", "excel",
    "word", "powerpoint", "line", "facebook", "youtube", "instagram",
    "tiktok", "wi-fi", "wifi", "iso", "ok", "wordpress",
}
LATIN_TOKEN = re.compile(r"[A-Za-z][A-Za-z'&.\-]*")
AMPM = re.compile(r"(?<![A-Za-z])[APap]\.?[Mm]\.?(?![A-Za-z])")
CURRENCY_SYMBOL = re.compile(r"[$£¥€]")
THAI_DIGIT = re.compile(r"[๐-๙]")


def _digits(s: str) -> list[str]:
    # NFKC: normalize full-width １２３ → 123 ก่อนดึง digits
    return re.findall(r"\d", unicodedata.normalize("NFKC", s))


def _is_subsequence(a: list[str], b: list[str]) -> bool:
    it = iter(b)
    return all(ch in it for ch in a)


def check(source: str, output: str, source_lang: str = "ja",
          latin_allowlist: set[str] | None = None) -> dict:
    """คืน {'errors': [...], 'warnings': [...]} — errors ว่าง = ผ่าน"""
    errors: list[str] = []
    warnings: list[str] = []
    allow = DEFAULT_ALLOWLIST | {w.lower() for w in (latin_allowlist or set())}

    # 1) script leak
    if source_lang == "ja":
        leaks = sorted(set(JP_LEAK.findall(output)))
        if leaks:
            errors.append(f"Japanese/Chinese characters leaked: {leaks}")
        puncts = sorted(set(JP_PUNCT.findall(output)))
        if puncts:
            errors.append(f"Japanese punctuation leaked: {puncts}")
    elif source_lang == "en":
        if AMPM.search(output):
            errors.append("AM/PM leaked — convert to Thai time words (บ่าย 3, 7 โมงเช้า)")
        if CURRENCY_SYMBOL.search(output):
            warnings.append("currency symbol in output — should be Thai word (ดอลลาร์/เยน/ปอนด์)")
        stop_hits, latin_unknown = [], []
        for tok in LATIN_TOKEN.findall(output):
            low = tok.lower().strip(".")
            if low in EN_STOPWORDS:
                stop_hits.append(tok)
            elif low not in allow and not (tok.isupper() and len(tok) <= 5):
                # acronym ตัวพิมพ์ใหญ่ ≤5 ตัว (AI, CEO, GPS, HTML) ปล่อยผ่านเงียบๆ
                latin_unknown.append(tok)
        if stop_hits:
            errors.append(f"untranslated English (stopwords found): {sorted(set(stop_hits))}")
        if latin_unknown:
            warnings.append(f"Latin tokens — verify brand/acronym/glossary: {sorted(set(latin_unknown))}")

    # 2) digit parity
    if THAI_DIGIT.search(output):
        errors.append("Thai numerals (๐-๙) found in output")
    src_d, out_d = _digits(source), _digits(output)
    if not _is_subsequence(src_d, out_d):
        errors.append(f"digit parity broken: source={src_d} output={out_d}")
    elif len(out_d) > len(src_d):
        warnings.append(f"output has extra digits (spelled-out/kanji numerals?): {src_d} → {out_d}")

    # 3) line parity
    if source.count("\n") != output.count("\n"):
        errors.append(
            f"line count mismatch: source={source.count(chr(10)) + 1} "
            f"output={output.count(chr(10)) + 1}"
        )

    return {"errors": errors, "warnings": warnings}


def retry_message(errors: list[str]) -> str:
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
        # (source, output, lang, expect_errors)
        ("行きます", "ไปครับ", "ja", False),
        ("令和7年です", "ปีเรวะที่ 7 ครับ", "ja", False),
        ("そうですね", "งั้นสินะー", "ja", True),
        ("I don't know", "ไม่รู้", "en", False),
        ("in 1998", "ในปี พ.ศ. 2541", "en", True),            # ค.ศ.→พ.ศ. → digits พัง
        ("Meet at 3 PM", "เจอกันบ่าย 3", "en", False),
        ("Meet at 3 PM", "เจอกันตอน 3 PM", "en", True),        # AM/PM หลุด
        ("The file was submitted", "The file ถูกส่งแล้ว", "en", True),  # อังกฤษตกค้าง
        ("Open Google Maps", "เปิด Google Maps", "en", False),  # Maps = warning เท่านั้น
        ("It costs $100", "ราคา 100 ดอลลาร์", "en", False),
        ("The CEO said no", "CEO บอกว่าไม่", "en", False),      # acronym ผ่าน
        ("twenty-five people", "25 คน", "en", False),           # extra digit = warning
        ("Hello\nHow are you?", "สวัสดี สบายดีไหม", "en", True),  # รวมบรรทัด
    ]
    for src, out, lang, expect_err in tests:
        r = check(src, out, source_lang=lang)
        ok = bool(r["errors"]) == expect_err
        print(f"{'PASS' if ok else 'FAIL'} [{lang}] {src!r} → {out!r}")
        for e in r["errors"]:
            print(f"       error: {e}")
        for w in r["warnings"]:
            print(f"       warn : {w}")
