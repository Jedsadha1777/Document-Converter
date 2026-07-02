# qa_check.py — deterministic validator สำหรับ output ปลายทาง TH / VI
# check(source, output, source_lang='ja'|'en', target_lang='th'|'vi')
# หมายเหตุ VI: target เป็น Latin เหมือน source → ตรวจด้วย script ไม่ได้
#   ใช้ 3 ชั้นแทน: EN stopwords / คำตกวรรณยุกต์ที่ไม่มีทางถูก / diacritic density

import re
import unicodedata

# ---------- shared ----------
def _digits(s: str) -> list[str]:
    return re.findall(r"\d", unicodedata.normalize("NFKC", s))

def _is_subsequence(a: list[str], b: list[str]) -> bool:
    it = iter(b)
    return all(ch in it for ch in a)

EN_STOPWORDS = {
    "the", "and", "is", "are", "was", "were", "be", "been", "you", "your",
    "this", "that", "these", "those", "with", "from", "have", "has", "had",
    "will", "would", "could", "should", "not", "for", "but", "they", "she",
    "he", "his", "her", "its", "our", "their", "what", "when", "where",
    "why", "how", "can", "all", "there", "which", "into", "about", "than",
    "then", "them", "who", "does", "did", "very", "just", "also",
    "us", "my", "of", "or", "if", "by",
}
# คำอังกฤษที่บังเอิญเป็นคำเวียดนามจริง (than = ถ่านหิน/บ่น, can = can đảm/can thiệp)
VI_STOPWORD_EXCLUDE = {"than", "can"}

DEFAULT_ALLOWLIST = {
    "google", "microsoft", "iphone", "ipad", "android", "windows", "excel",
    "word", "powerpoint", "line", "facebook", "youtube", "instagram",
    "tiktok", "wi-fi", "wifi", "iso", "ok", "wordpress",
}
LATIN_TOKEN = re.compile(r"[A-Za-z][A-Za-z'&.\-]*")
AMPM = re.compile(r"(?<![A-Za-z])[APap]\.?[Mm]\.?(?![A-Za-z])")
THAI_DIGIT = re.compile(r"[๐-๙]")
CURRENCY_SYMBOL = re.compile(r"[$£¥€]")

# ---------- TH target ----------
JP_LEAK = re.compile(
    r"[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F\u4E00-\u9FFF\u3400-\u4DBF\u3005\u3006]"
)
JP_PUNCT = re.compile(r"[「」『』。、・〜]")

# ---------- VI target ----------
NON_LATIN_LEAK = re.compile(
    r"[\u0E00-\u0E7F\u3040-\u30FF\u31F0-\u31FF\u4E00-\u9FFF\u3400-\u4DBF\uAC00-\uD7AF]"
)
_VI_DIAC_LOWER = ("ăâđêôơư"
                  "áàảãạắằẳẵặấầẩẫậ"
                  "éèẻẽẹếềểễệ"
                  "íìỉĩị"
                  "óòỏõọốồổỗộớờởỡợ"
                  "úùủũụứừửữự"
                  "ýỳỷỹỵ")
VI_DIAC = set(_VI_DIAC_LOWER + _VI_DIAC_LOWER.upper())
# รูปไม่มีวรรณยุกต์ที่ "ไม่ใช่คำเวียดที่ถูกต้อง" — เจอ = ตกวรรณยุกต์แน่นอน
VI_MISSING_DIAC_WORDS = {
    "khong", "duoc", "nguoi", "tieng", "viec", "nghia",
    "truoc", "thuong", "duong", "hieu", "mien", "toi",
}
VI_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
# particle ท้ายประโยค (สำหรับโหมด catalog) — เช็คเฉพาะตัวที่ unambiguous
VI_FINAL_PARTICLE = re.compile(
    r"(?:^|[\s,])(ạ|nhé|nha|nhỉ)(?=[\s.!…?\"')]*$)", re.IGNORECASE | re.MULTILINE
)


def check(source: str, output: str, source_lang: str = "ja",
          target_lang: str = "th", latin_allowlist: set[str] | None = None,
          forbid_final_particles: bool = False) -> dict:
    """คืน {'errors': [...], 'warnings': [...]} — errors ว่าง = ผ่าน"""
    errors: list[str] = []
    warnings: list[str] = []
    allow = DEFAULT_ALLOWLIST | {w.lower() for w in (latin_allowlist or set())}

    # ---------- 1) target-language checks ----------
    if target_lang == "th":
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
                warnings.append("currency symbol in output — should be Thai word (ดอลลาร์/เยน)")
            stop_hits, latin_unknown = [], []
            for tok in LATIN_TOKEN.findall(output):
                low = tok.lower().strip(".")
                if low in EN_STOPWORDS:
                    stop_hits.append(tok)
                elif low not in allow and not (tok.isupper() and len(tok) <= 5):
                    latin_unknown.append(tok)
            if stop_hits:
                errors.append(f"untranslated English (stopwords found): {sorted(set(stop_hits))}")
            if latin_unknown:
                warnings.append(f"Latin tokens — verify brand/acronym/glossary: {sorted(set(latin_unknown))}")
        if THAI_DIGIT.search(output):
            errors.append("Thai numerals (๐-๙) found in output")

    elif target_lang == "vi":
        if NON_LATIN_LEAK.search(output):
            leaks = sorted(set(NON_LATIN_LEAK.findall(output)))
            errors.append(f"non-Latin characters leaked: {leaks}")
        # (a) คำตกวรรณยุกต์ที่ชี้ขาดได้
        tokens = VI_WORD.findall(output)
        bad_diac = sorted({t for t in tokens if t.lower() in VI_MISSING_DIAC_WORDS})
        if bad_diac:
            errors.append(f"missing diacritics (invalid bare forms): {bad_diac}")
        # (b) EN stopwords ตกค้าง (ตัดคำชนกับเวียดนามออก)
        stop = EN_STOPWORDS - VI_STOPWORD_EXCLUDE
        stop_hits = sorted({t for t in tokens
                            if t.lower() in stop and not any(c in VI_DIAC for c in t)})
        if stop_hits:
            errors.append(f"untranslated English (stopwords found): {stop_hits}")
        # (c) diacritic density — จับทั้ง 'tieng Viet khong dau' และอังกฤษหลุดทั้งท่อน
        if len(tokens) >= 6:
            diac_ratio = sum(1 for t in tokens if any(c in VI_DIAC for c in t)) / len(tokens)
            if diac_ratio < 0.25:
                warnings.append(
                    f"low diacritic density ({diac_ratio:.0%}) — "
                    "possibly missing diacritics or untranslated English"
                )
        if AMPM.search(output):
            errors.append("AM/PM leaked — convert to Vietnamese time (3 giờ chiều, 7 giờ sáng)")
        if forbid_final_particles:
            hits = sorted({m.group(1) for m in VI_FINAL_PARTICLE.finditer(output)})
            if hits:
                errors.append(f"sentence-final chat particles in catalog text: {hits}")

    # ---------- 2) digit parity (shared) ----------
    src_d, out_d = _digits(source), _digits(output)
    if not _is_subsequence(src_d, out_d):
        errors.append(f"digit parity broken: source={src_d} output={out_d}")
    elif len(out_d) > len(src_d):
        warnings.append(f"output has extra digits (spelled-out numbers / month names?): {src_d} → {out_d}")

    # ---------- 3) line parity (shared) ----------
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
        + "\nFix every violation and re-output ONLY the corrected translation, "
        "keeping the same number of lines."
    )


if __name__ == "__main__":
    import sys
    # console Windows default (เช่น cp932) พิมพ์ตัวอย่างไทย/ญี่ปุ่นไม่ได้
    sys.stdout.reconfigure(encoding="utf-8")
    tests = [
        # (source, output, source_lang, target_lang, kwargs, expect_errors)
        # --- regression TH ---
        ("行きます", "ไปครับ", "ja", "th", {}, False),
        ("令和7年です", "ปีเรวะที่ 7 ครับ", "ja", "th", {}, False),
        ("Meet at 3 PM", "เจอกันตอน 3 PM", "en", "th", {}, True),
        # --- VI ---
        ("We offer free samples", "Chúng tôi cung cấp mẫu miễn phí", "en", "vi", {}, False),
        ("We offer free samples", "Chung toi cung cap mau mien phi", "en", "vi", {}, True),
        ("Made in China", "Sản xuất tại Trung Quốc", "en", "vi", {}, False),
        ("Contact us for a quote", "Contact us để nhận báo giá", "en", "vi", {}, True),
        ("Meet at 3 PM", "Gặp lúc 3 giờ chiều", "en", "vi", {}, False),
        ("Meet at 3 PM", "Gặp lúc 3 PM", "en", "vi", {}, True),
        ("May 5, 2026", "ngày 5 tháng 5 năm 2026", "en", "vi", {}, False),
        ("Warranty: 2 years", "Bảo hành: 2 năm", "en", "vi", {}, False),
        ("Add to cart\nBuy now", "Thêm vào giỏ hàng Mua ngay", "en", "vi", {}, True),
        ("Made of stainless steel", "Được làm bằng thép không gỉ ạ",
         "en", "vi", {"forbid_final_particles": True}, True),
        ("Therefore it meets ISO 9001", "Vì vậy, sản phẩm đạt chuẩn ISO 9001",
         "en", "vi", {"forbid_final_particles": True}, False),
        ("Thank you", "Cảm ơn ạ", "en", "vi", {}, False),  # dialogue mode: ạ อนุญาต
    ]
    for src, out, sl, tl, kw, expect_err in tests:
        r = check(src, out, source_lang=sl, target_lang=tl, **kw)
        ok = bool(r["errors"]) == expect_err
        print(f"{'PASS' if ok else 'FAIL'} [{sl}->{tl}] {src!r} → {out!r}")
        for e in r["errors"]:
            print(f"       error: {e}")
        for w in r["warnings"]:
            print(f"       warn : {w}")
