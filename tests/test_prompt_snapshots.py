"""Golden snapshot ของ prompt ที่ประกอบแล้ว — เกราะกัน prompt-reorg เปลี่ยนข้อความ
สร้าง golden:  venv/bin/python tests/test_prompt_snapshots.py --write
ตรวจ:         venv/bin/python tests/test_prompt_snapshots.py
ทุกเคสต้อง byte-equal กับ golden — ต่างแม้ตัวเดียว = FAIL"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

import correct
import tm
import translate

GOLDEN_PATH = Path(__file__).resolve().parent / "prompt_snapshots.golden.json"

SAMPLE_RULES = "ぴぴたん => ปิปิตัน\nGrim military tone, terse phrasing."
SAMPLE_CHARACTERS = [
    {"id": "c1", "name": "ยูกิ", "gender": "female", "age": "adult"},
    {"id": "c2", "name": "เคน", "gender": "male", "age": "teen"},
    {"id": "c3", "name": "หลวงพ่อ", "gender": "male", "age": "senior",
     "persona": "พระสงฆ์ พูดช้า ใจเย็น"},
]
SAMPLE_HITS = [
    {"source": "Stainless Steel Bottle 500ml", "target": "Bình inox 500ml"},
    {"source": "Do not microwave.", "target": "Không dùng trong lò vi sóng."},
]


def build_cases() -> dict[str, str]:
    cases: dict[str, str] = {}

    # ── literal dicts ──
    for key, val in translate.TRANSLATE_PROMPTS.items():
        cases[f"lit/TRANSLATE_PROMPTS/{key}"] = val
    for (src, tgt), val in translate.TRANSLATE_PROMPTS_BY_PAIR.items():
        cases[f"lit/TRANSLATE_PROMPTS_BY_PAIR/{src}-{tgt}"] = val
    for key, val in translate.TRANSLATE_STYLE_PROMPTS.items():
        cases[f"lit/TRANSLATE_STYLE_PROMPTS/{key}"] = val

    # ── batch system prompt: full cross (pair × content_type), rules+chars on ──
    pairs = [("ja", "th"), ("en", "th"), ("en", "vi"), ("th", "en"),
             (None, "th"), (None, "en"), (None, "ja"), (None, "vi")]
    ctypes = [None, "manga_novel", "tutorial", "product_catalog"]
    for src, tgt in pairs:
        for ct in ctypes:
            name = f"batch/{src or 'none'}-{tgt}/{ct or 'plain'}/full"
            cases[name] = translate._build_batch_system_prompt(
                tgt, 3, SAMPLE_RULES, SAMPLE_CHARACTERS,
                id_start=5, source=src, content_type=ct)

    # ── edge cases: rules/chars ปิดทีละตัว, sparse ids, id_start=1 ──
    cases["batch/ja-th/plain/no_rules"] = translate._build_batch_system_prompt(
        "th", 3, None, SAMPLE_CHARACTERS, id_start=5, source="ja")
    cases["batch/ja-th/plain/no_chars"] = translate._build_batch_system_prompt(
        "th", 3, SAMPLE_RULES, None, id_start=5, source="ja")
    cases["batch/ja-th/plain/bare"] = translate._build_batch_system_prompt(
        "th", 3, None, None, id_start=1, source="ja")
    cases["batch/ja-th/manga/sparse_ids"] = translate._build_batch_system_prompt(
        "th", 3, SAMPLE_RULES, SAMPLE_CHARACTERS,
        ids=[2, 7, 9], source="ja", content_type="manga_novel")
    cases["batch/en-vi/catalog/sparse_ids"] = translate._build_batch_system_prompt(
        "vi", 3, SAMPLE_RULES, SAMPLE_CHARACTERS,
        ids=[2, 7, 9], source="en", content_type="product_catalog")
    # texts-based source detection path
    cases["batch/detect-ja/plain/bare"] = translate._build_batch_system_prompt(
        "th", 2, None, None, texts=["こんにちは", "元気?"])

    # ── correct: batch system prompt + single prompts ──
    th_text = "ปี ค.ศ. 1930 มีการเพาะ เชื้อจุลินทรีย์"
    ja_text = "人り口はここです"
    mixed_text = "ประตู 入り口  here"
    for label, text in (("th", th_text), ("ja", ja_text), ("mixed", mixed_text)):
        cases[f"correct/batch/{label}/no_rules"] = \
            correct._build_correct_batch_system_prompt(text, 3, None)
        cases[f"correct/batch/{label}/rules"] = \
            correct._build_correct_batch_system_prompt(text, 3, SAMPLE_RULES)
        cases[f"correct/pick/{label}"] = correct.pick_prompt(text)
        cases[f"correct/pick_context/{label}"] = correct.pick_context_prompt(text)

    # ── tm rules intro ──
    cases["tm/format_rules/empty"] = tm._format_rules([])
    cases["tm/format_rules/hits"] = tm._format_rules(SAMPLE_HITS)

    return cases


def main() -> int:
    cases = build_cases()
    if "--write" in sys.argv:
        GOLDEN_PATH.write_text(
            json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"wrote {len(cases)} cases -> {GOLDEN_PATH.name}")
        return 0

    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    failures: list[str] = []
    for name in sorted(set(golden) | set(cases)):
        if name not in cases:
            failures.append(f"{name}: missing from current code")
        elif name not in golden:
            failures.append(f"{name}: not in golden (new case? re-run --write intentionally)")
        elif cases[name] != golden[name]:
            # หา diff ตัวแรกช่วย debug
            a, b = golden[name], cases[name]
            pos = next((i for i in range(min(len(a), len(b))) if a[i] != b[i]),
                       min(len(a), len(b)))
            failures.append(
                f"{name}: mismatch at char {pos}: "
                f"golden={a[max(0, pos - 30):pos + 30]!r} "
                f"current={b[max(0, pos - 30):pos + 30]!r}")
    if failures:
        for f in failures:
            print(f"FAIL {f}")
        print(f"\n{len(failures)} failures / {len(golden)} cases")
        return 1
    print(f"PASS all {len(golden)} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
