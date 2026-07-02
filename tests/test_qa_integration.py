"""Integration tests: qa_check wiring ใน translate.py
รัน: .\\venv\\Scripts\\python.exe tests\\test_qa_integration.py (จาก Document-Converter/)"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

import translate

failures: list[str] = []


def expect(label: str, cond: bool) -> None:
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)


# ---- Task 1: _run_pair_qa mapping ----
r = translate._run_pair_qa("ja", "th", "行きます", "ไปครับ")
expect("ja->th clean passes", r is not None and r["errors"] == [])
r = translate._run_pair_qa("ja", "th", "「保存」を押す", "กด 「บันทึก」")
expect("ja->th punctuation leak caught",
       r is not None and any("punctuation" in e for e in r["errors"]))
r = translate._run_pair_qa("en", "th", "Meet at 3 PM", "เจอกันตอน 3 PM")
expect("en->th AM/PM caught",
       r is not None and any("AM/PM" in e for e in r["errors"]))
r = translate._run_pair_qa("en", "vi", "Made of steel", "Được làm bằng thép ạ",
                           forbid_final_particles=True)
expect("en->vi catalog particle caught",
       r is not None and any("particle" in e for e in r["errors"]))
r = translate._run_pair_qa("en", "vi", "Made of steel", "Được làm bằng thép ạ")
expect("en->vi dialogue particle allowed", r is not None and r["errors"] == [])
expect("th->en no validator", translate._run_pair_qa("th", "en", "x", "y") is None)
expect("unknown source no validator", translate._run_pair_qa(None, "th", "x", "y") is None)

# ---- Task 2: _post_process_batch qa marker ----
texts_b = ["「保存」を押す", "行きます"]
parsed_b = ["กด 「บันทึก」", "ไปครับ"]
per_item_b = [{"mapping": {}}, {"mapping": {}}]
tr_b, er_b = translate._post_process_batch(texts_b, parsed_b, per_item_b, "th", source="ja")
expect("batch item0 has qa marker", er_b[0] is not None and "qa: " in er_b[0])
expect("batch item1 clean", er_b[1] is None)
expect("batch translation not replaced", tr_b[0] == "กด 「บันทึก」" and tr_b[1] == "ไปครับ")
tr_b2, er_b2 = translate._post_process_batch(texts_b, parsed_b, per_item_b, "th")
expect("batch without source skips qa", er_b2[1] is None and (er_b2[0] is None or "qa: " not in er_b2[0]))

# ---- Task 3: apply_manual_batch plumbing ----
raw_json = '{"items":[{"id":1,"text":"กด 「บันทึก」"},{"id":2,"text":"ไปครับ"}]}'
tr_m, er_m = translate.apply_manual_batch(texts_b, "th", raw_json)
expect("manual item0 qa marker", er_m[0] is not None and "qa: " in er_m[0])
expect("manual item1 clean", er_m[1] is None)
raw_vi = '{"items":[{"id":1,"text":"Được làm bằng thép ạ"}]}'
tr_v, er_v = translate.apply_manual_batch(["Made of steel"], "vi", raw_vi,
                                          content_type="product_catalog")
expect("manual vi catalog particle caught", er_v[0] is not None and "particle" in er_v[0])
tr_v2, er_v2 = translate.apply_manual_batch(["Made of steel"], "vi", raw_vi)
expect("manual vi dialogue particle ok", er_v2[0] is None)

# ---- Task 4: build_qa_retry_message ----
msg = translate.build_qa_retry_message([5, 6], er_m, 2)
expect("retry msg built", msg is not None)
expect("retry msg has id 5", msg is not None and "id 5" in msg)
expect("retry msg no id 6", msg is not None and "id 6" not in msg)
expect("retry msg full-json instruction", msg is not None and "ALL 2 items" in msg)
expect("retry msg reasserts first-message rules",
       msg is not None and "first message" in msg)
expect("retry msg None when clean",
       translate.build_qa_retry_message([1, 2], [None, None], 2) is None)
expect("retry msg None for non-qa errors",
       translate.build_qa_retry_message([1], ["missing"], 1) is None)

# ---- Task 5: translate_text qa retry ----
# ใช้เคส AM/PM (en->th) เพราะ guard เดิม (_output_has_unwanted_script/_digits_changed)
# มองไม่เห็น — จับได้เฉพาะ qa_check
def _fake_ollama_factory(outputs):
    calls = {"prompts": [], "i": 0}

    def fake(text, system_prompt, timeout=60.0):
        calls["prompts"].append(system_prompt)
        out = outputs[min(calls["i"], len(outputs) - 1)]
        calls["i"] += 1
        return out
    return fake, calls


_orig_ollama = translate._call_ollama_translate

fake, calls = _fake_ollama_factory(["เจอกันตอน 3 PM", "เจอกันบ่าย 3"])
translate._call_ollama_translate = fake
try:
    out_s, err_s = translate.translate_text("Meet at 3 PM", "th")
finally:
    translate._call_ollama_translate = _orig_ollama
expect("single retry accepted (improved)", out_s == "เจอกันบ่าย 3" and err_s is None)
expect("single retry called twice", len(calls["prompts"]) == 2)
expect("single retry prompt carries violation list",
       len(calls["prompts"]) == 2 and "ABSOLUTE rules" in calls["prompts"][1])

fake2, calls2 = _fake_ollama_factory(["เจอกันตอน 3 PM", "เจอกันตอน 3 PM"])
translate._call_ollama_translate = fake2
try:
    out_s2, err_s2 = translate.translate_text("Meet at 3 PM", "th")
finally:
    translate._call_ollama_translate = _orig_ollama
expect("single retry rejected (not better) keeps first", out_s2 == "เจอกันตอน 3 PM")

fake3, calls3 = _fake_ollama_factory(["เจอกันบ่าย 3"])
translate._call_ollama_translate = fake3
try:
    out_s3, err_s3 = translate.translate_text("Meet at 3 PM", "th")
finally:
    translate._call_ollama_translate = _orig_ollama
expect("clean output no retry", out_s3 == "เจอกันบ่าย 3" and len(calls3["prompts"]) == 1)

print()
print(f"{len(failures)} failures")
sys.exit(1 if failures else 0)
