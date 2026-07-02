# qa_check Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เชื่อม `prompts/{jp_th,en_th,en_vn}/qa_check.py` เข้าเส้นทางแปลทั้งหมด: advisory marker ใน batch, auto-retry 1 รอบใน single path, และ retry message สำหรับ manual Gemini flow

**Architecture:** helper `_run_pair_qa` เลือก validator ตามคู่ภาษา → batch ทุกเส้นทางติด warning ผ่าน `_post_process_batch` จุดเดียว (advisory, ไม่มี LLM call) → single path (ollama) retry ในตัว 1 รอบ → endpoint apply-manual คืน `qa_retry_message` ให้ user copy วางต่อในแชท Gemini เดิม

**Tech Stack:** Python 3.12 (Flask), vanilla JS (ES modules), ไม่มี pytest — ใช้ plain script + assert ตาม convention ของ qa_check self-test

**Spec:** `docs/superpowers/specs/2026-07-02-qa-check-integration-design.md`

**ธรรมเนียมบังคับ:**
- backup ทุกไฟล์ก่อนแก้ → `Document-Converter/backup/<ชื่อ>.bak.<timestamp>` (timestamp เดียวกันทั้งชุด)
- **โปรเจกต์นี้ไม่ใช่ git repo** — ข้าม commit step ทั้งหมด, backup คือกลไก rollback
- ห้ามใส่ comment restate โค้ด
- ทุกคำสั่งรันจาก `d:\document_converter\Document-Converter` ด้วย `.\venv\Scripts\python.exe`
- คำเตือน: บรรทัดอ้างอิงด้านล่างเป็นตำแหน่ง ณ วันเขียนแผน — ใช้ anchor string ในการ Edit เสมอ

---

### Task 0: Backup

**Files:** ไม่มีไฟล์ใหม่ — copy 4 ไฟล์

- [ ] **Step 0.1: Backup ทุกไฟล์ที่จะแก้**

Run (PowerShell):
```powershell
Set-Location "d:\document_converter\Document-Converter"
$ts = Get-Date -Format yyyyMMdd_HHmmss
Copy-Item translate.py "backup\translate.py.bak.$ts"
Copy-Item app.py "backup\app.py.bak.$ts"
Copy-Item templates\index.html "backup\index.html.bak.$ts"
Copy-Item static\js\preview-prompt.js "backup\preview-prompt.js.bak.$ts"
```
Expected: 4 ไฟล์ใหม่ใน backup/

---

### Task 1: `_run_pair_qa` + imports

**Files:**
- Modify: `translate.py` (import block บนสุด + หลัง `_fill_prompt_slots` ~line 484)
- Create: `tests/test_qa_integration.py`

- [ ] **Step 1.1: เขียนเทสต์ (ยัง fail)**

สร้าง `tests/test_qa_integration.py`:

```python
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

print()
print(f"{len(failures)} failures")
sys.exit(1 if failures else 0)
```

- [ ] **Step 1.2: รันเทสต์ — ต้อง fail**

Run: `.\venv\Scripts\python.exe tests\test_qa_integration.py`
Expected: `AttributeError: module 'translate' has no attribute '_run_pair_qa'`

- [ ] **Step 1.3: เพิ่ม import ใน translate.py**

Edit — anchor เดิม:
```python
from prompts.en_th import base as _en_th_base
```
แทนด้วย:
```python
from prompts.en_th import base as _en_th_base
from prompts.jp_th import qa_check as _jp_th_qa
from prompts.en_th import qa_check as _en_th_qa
from prompts.en_vn import qa_check as _en_vn_qa
```

- [ ] **Step 1.4: เพิ่ม `_PAIR_QA_MODULES` + `_run_pair_qa`**

Edit — วางต่อท้ายฟังก์ชัน `_fill_prompt_slots` (หลังบรรทัด `.replace("{{GLOSSARY}}", gloss_fill))`):

```python
_PAIR_QA_MODULES = {
    ("ja", "th"): _jp_th_qa,
    ("en", "th"): _en_th_qa,
    ("en", "vi"): _en_vn_qa,
}


def _run_pair_qa(source: str | None, target: str, src_text: str, out_text: str,
                 forbid_final_particles: bool = False) -> dict | None:
    """deterministic validator ต่อคู่ภาษา — {'errors','warnings'} หรือ None ถ้าไม่มี validator
    validator พังห้ามทำการแปลพัง → exception กลืนเป็น None"""
    mod = _PAIR_QA_MODULES.get((source, target))
    if mod is None:
        return None
    try:
        if mod is _en_th_qa:
            return mod.check(src_text, out_text, source_lang="en")
        if mod is _en_vn_qa:
            return mod.check(src_text, out_text, source_lang="en", target_lang="vi",
                             forbid_final_particles=forbid_final_particles)
        return mod.check(src_text, out_text)
    except Exception as e:
        print(f"[qa_check] validator error ({source}->{target}): {e}", flush=True)
        return None
```

- [ ] **Step 1.5: รันเทสต์ — ต้องผ่าน**

Run: `.\venv\Scripts\python.exe tests\test_qa_integration.py`
Expected: ทุกบรรทัด PASS, `0 failures`, exit 0

---

### Task 2: qa marker ใน `_post_process_batch`

**Files:**
- Modify: `translate.py` — `_post_process_batch` (~line 1300)
- Modify: `tests/test_qa_integration.py`

- [ ] **Step 2.1: เพิ่มเทสต์ (ก่อนบรรทัด `print()` ท้ายไฟล์เทสต์)**

```python
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
```

- [ ] **Step 2.2: รันเทสต์ — ต้อง fail**

Run: `.\venv\Scripts\python.exe tests\test_qa_integration.py`
Expected: `TypeError: _post_process_batch() got an unexpected keyword argument 'source'`

- [ ] **Step 2.3: แก้ signature + เพิ่ม qa block**

Edit 1 — anchor:
```python
def _post_process_batch(texts: list[str], parsed: list[str | None],
                        per_item: list[dict], target: str
                        ) -> tuple[list[str], list[str | None]]:
```
แทนด้วย:
```python
def _post_process_batch(texts: list[str], parsed: list[str | None],
                        per_item: list[dict], target: str,
                        source: str | None = None,
                        content_type: str | None = None
                        ) -> tuple[list[str], list[str | None]]:
```

Edit 2 — anchor:
```python
            if _digits_changed(original, t):
                warnings.append("digit_mismatch")

            translations.append(t)
```
แทนด้วย (qa marker ต้องเป็นตัว**ท้ายสุด**ของ warnings — `build_qa_retry_message` ใน Task 4 ตัด string จากตำแหน่ง `qa: ` ถึงจบ):
```python
            if _digits_changed(original, t):
                warnings.append("digit_mismatch")
            if original.strip():
                qa = _run_pair_qa(source, target, _join_lines(original), t,
                                  forbid_final_particles=(content_type == "product_catalog"))
                if qa and qa["errors"]:
                    warnings.append("qa: " + " | ".join(qa["errors"]))

            translations.append(t)
```

- [ ] **Step 2.4: รันเทสต์ — ต้องผ่านทั้งหมด**

Run: `.\venv\Scripts\python.exe tests\test_qa_integration.py`
Expected: `0 failures`

---

### Task 3: ผู้เรียก 3 จุดส่ง source/content_type

**Files:**
- Modify: `translate.py` — ท้าย `_translate_batch_qwen`, ท้าย `_translate_batch_gemini`, `apply_manual_batch`
- Modify: `tests/test_qa_integration.py`

- [ ] **Step 3.1: เพิ่มเทสต์**

```python
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
```

- [ ] **Step 3.2: รันเทสต์ — ต้อง fail**

Expected: fail ที่ "manual item0 qa marker" (apply_manual_batch ยังไม่ส่ง source)
และ `TypeError` ที่ content_type

- [ ] **Step 3.3: แก้ผู้เรียกทั้ง 3**

Edit 1 — ท้าย `_translate_batch_qwen`, anchor:
```python
    return _post_process_batch(texts, parsed, per_item, target)


_GEMINI_RESPONSE_SCHEMA = {
```
แทนด้วย:
```python
    return _post_process_batch(texts, parsed, per_item, target,
                               source=_detect_source_language(texts),
                               content_type=content_type)


_GEMINI_RESPONSE_SCHEMA = {
```

Edit 2 — ท้าย `_translate_batch_gemini`, anchor (ตัวที่เหลือ):
```python
    return _post_process_batch(texts, parsed, per_item, target)
```
แทนด้วย:
```python
    return _post_process_batch(texts, parsed, per_item, target,
                               source=_detect_source_language(texts),
                               content_type=content_type)
```

Edit 3 — signature `apply_manual_batch`, anchor:
```python
def apply_manual_batch(texts: list[str], target: str, raw_response: str,
                       speakers: list[str | None] | None = None,
                       characters: list[dict] | None = None,
                       id_start: int = 1,
                       ids: list[int] | None = None,
                       emotions: list[str | None] | None = None,
                       ) -> tuple[list[str], list[str | None]]:
```
แทนด้วย:
```python
def apply_manual_batch(texts: list[str], target: str, raw_response: str,
                       speakers: list[str | None] | None = None,
                       characters: list[dict] | None = None,
                       id_start: int = 1,
                       ids: list[int] | None = None,
                       emotions: list[str | None] | None = None,
                       content_type: str | None = None,
                       ) -> tuple[list[str], list[str | None]]:
```

Edit 4 — ใน `apply_manual_batch`, anchor:
```python
    sub_t, sub_e = _post_process_batch(list(texts), parsed, per_item, target)
```
แทนด้วย:
```python
    sub_t, sub_e = _post_process_batch(list(texts), parsed, per_item, target,
                                       source=_detect_source_language(texts),
                                       content_type=content_type)
```

- [ ] **Step 3.4: รันเทสต์ — ต้องผ่านทั้งหมด**

---

### Task 4: `build_qa_retry_message`

**Files:**
- Modify: `translate.py` — วางต่อท้าย `apply_manual_batch` (ก่อน `def translate_batch`)
- Modify: `tests/test_qa_integration.py`

- [ ] **Step 4.1: เพิ่มเทสต์**

```python
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
```

- [ ] **Step 4.2: รันเทสต์ — ต้อง fail** (`AttributeError: build_qa_retry_message`)

- [ ] **Step 4.3: implement**

วางก่อน `def translate_batch(`:

```python
def build_qa_retry_message(ids: list[int], errors: list[str | None],
                           total: int) -> str | None:
    """รวม qa error รายบรรทัดเป็นข้อความ follow-up ให้ user วางต่อในแชท LLM เดิม
    (manual flow retry ในตัวไม่ได้) — อาศัยว่า qa marker เป็น warning ตัวท้ายสุดเสมอ"""
    items = []
    for i, err in enumerate(errors):
        if not err:
            continue
        pos = err.find("qa: ")
        if pos == -1:
            continue
        item_id = ids[i] if i < len(ids) else i + 1
        items.append(f"- id {item_id}: {err[pos + 4:]}")
    if not items:
        return None
    return (
        "Some translated items violated ABSOLUTE rules from my first message:\n"
        + "\n".join(items)
        + f"\n\nRe-output the COMPLETE JSON with ALL {total} items — same ids, same schema, "
        "same order — correcting the flagged items and keeping the rest unchanged.\n"
        "All rules from my first message (CHARACTER PROFILES, PROJECT-SPECIFIC RULES, "
        "GLOSSARY, LINE PARITY, NUMBERS) still apply."
    )
```

- [ ] **Step 4.4: รันเทสต์ — ต้องผ่านทั้งหมด**

---

### Task 5: retry 1 รอบใน `translate_text`

**Files:**
- Modify: `translate.py` — ใน `translate_text` (~line 600)
- Modify: `tests/test_qa_integration.py`

- [ ] **Step 5.1: เพิ่มเทสต์ (monkeypatch `_call_ollama_translate` — ไม่แตะ network)**

```python
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
```

- [ ] **Step 5.2: รันเทสต์ — ต้อง fail** ("single retry called twice" — ยังเรียกครั้งเดียว)

- [ ] **Step 5.3: implement**

Edit — ใน `translate_text`, anchor:
```python
        out = out or text_protected
        out = _join_lines(out)
        out = _normalize_numerals(out)
        out = _restore_segments(out, mapping)
```
แทนด้วย (ตรวจก่อน restore — เทียบกับ text_protected ฝั่งเดียวกัน กัน false positive
จาก URL/email ที่ถูก restore กลับ):
```python
        out = out or text_protected
        out = _join_lines(out)
        out = _normalize_numerals(out)
        qa = _run_pair_qa(source, target, text_protected, out)
        if qa and qa["errors"]:
            print(f"[translate] qa_check failed: {qa['errors']} — retry", flush=True)
            qa_mod = _PAIR_QA_MODULES[(source, target)]
            retry_out = _call_ollama_translate(
                text_protected,
                prompt_factual + "\n\n" + qa_mod.retry_message(qa["errors"]),
                timeout,
            )
            retry_out = _normalize_numerals(_join_lines(retry_out or ""))
            qa2 = _run_pair_qa(source, target, text_protected, retry_out)
            if retry_out and qa2 is not None and len(qa2["errors"]) < len(qa["errors"]):
                out = retry_out
            else:
                print("[translate] qa retry not better, keeping first output", flush=True)
        out = _restore_segments(out, mapping)
```

- [ ] **Step 5.4: รันเทสต์ — ต้องผ่านทั้งหมด** และรัน regression:

Run: `.\venv\Scripts\python.exe -m py_compile translate.py`
Expected: exit 0

---

### Task 6: endpoint `/translate-batch/apply-manual`

**Files:**
- Modify: `app.py` — import block + ตัว endpoint

- [ ] **Step 6.1: เพิ่ม import**

Edit — ใน `from translate import (...)` ของ app.py, anchor:
```python
    apply_manual_batch,
```
แทนด้วย:
```python
    apply_manual_batch,
    build_qa_retry_message,
```

- [ ] **Step 6.2: แก้ endpoint**

Edit — anchor:
```python
        ids_arg = [int(x) for x in ids_payload] if ids_payload else None
        translations, errors = apply_manual_batch(
            texts, target, raw_response,
            speakers=speakers, characters=characters,
            id_start=id_start, ids=ids_arg, emotions=emotions,
        )
        return jsonify({
            "translated": translations,
            "errors": errors,
            "target": target,
            "batch_size": len(texts),
        })
```
แทนด้วย:
```python
        ids_arg = [int(x) for x in ids_payload] if ids_payload else None
        content_type = payload.get("content_type") or None
        translations, errors = apply_manual_batch(
            texts, target, raw_response,
            speakers=speakers, characters=characters,
            id_start=id_start, ids=ids_arg, emotions=emotions,
            content_type=content_type,
        )
        ids_for_msg = ids_arg if ids_arg else [id_start + i for i in range(len(texts))]
        return jsonify({
            "translated": translations,
            "errors": errors,
            "target": target,
            "batch_size": len(texts),
            "qa_retry_message": build_qa_retry_message(ids_for_msg, errors, len(texts)),
        })
```

- [ ] **Step 6.3: ทดสอบ endpoint ผ่าน flask test client**

สร้างสคริปต์ชั่วคราวใน scratchpad (ไม่เก็บเข้าโปรเจกต์ — import app หนัก ~1 นาที เพราะลาก
transformers/docling มาด้วย):

```python
import sys
sys.path.insert(0, r"d:\document_converter\Document-Converter")
sys.stdout.reconfigure(encoding="utf-8")
from app import app

client = app.test_client()
resp = client.post("/translate-batch/apply-manual", json={
    "texts": ["「保存」を押す", "行きます"],
    "target": "th",
    "raw_response": '{"items":[{"id":1,"text":"กด 「บันทึก」"},{"id":2,"text":"ไปครับ"}]}',
    "content_type": "manga_novel",
})
data = resp.get_json()
assert resp.status_code == 200, resp.status_code
assert data["qa_retry_message"] and "id 1" in data["qa_retry_message"], data
assert "qa: " in (data["errors"][0] or ""), data
resp2 = client.post("/translate-batch/apply-manual", json={
    "texts": ["行きます"],
    "target": "th",
    "raw_response": '{"items":[{"id":1,"text":"ไปครับ"}]}',
})
data2 = resp2.get_json()
assert data2["qa_retry_message"] is None, data2
print("endpoint OK")
```

Run: `.\venv\Scripts\python.exe <scratchpad>\check_endpoint.py`
Expected: `endpoint OK`

---

### Task 7: UI กล่อง retry message

**Files:**
- Modify: `templates/index.html` — ใน `<template id="previewModalTpl">`
- Modify: `static/js/preview-prompt.js` — `_ensureModal` + `applyManualResponse`

- [ ] **Step 7.1: เพิ่มกล่องใน template (ซ่อนไว้ก่อน)**

Edit — anchor:
```html
        <div class="preview-apply-row">
            <button type="button" id="previewApplyManualBtn">Apply to table</button>
            <span id="previewManualStatus" class="preview-status"></span>
        </div>
```
แทนด้วย:
```html
        <div class="preview-apply-row">
            <button type="button" id="previewApplyManualBtn">Apply to table</button>
            <span id="previewManualStatus" class="preview-status"></span>
        </div>
        <div id="previewQaRetry" style="display:none;">
            <h3 class="preview-h3"><span class="material-symbols-outlined">rule</span>QA check failed — paste this follow-up into the SAME LLM chat</h3>
            <div class="preview-hint">The original prompt (persona / TM rules / glossary) is still in that chat's context. Paste this message, copy the new response, then apply it here again.</div>
            <textarea id="previewQaRetryText" class="preview-manual" rows="5" readonly></textarea>
            <div class="preview-apply-row">
                <button type="button" id="previewQaRetryCopyBtn">Copy retry message</button>
            </div>
        </div>
```

- [ ] **Step 7.2: ปุ่ม copy ใน `_ensureModal`**

Edit — anchor:
```javascript
    document.getElementById("previewApplyManualBtn").addEventListener("click", applyManualResponse);
```
แทนด้วย:
```javascript
    document.getElementById("previewApplyManualBtn").addEventListener("click", applyManualResponse);
    document.getElementById("previewQaRetryCopyBtn").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(document.getElementById("previewQaRetryText").value);
            _flashBtn(document.getElementById("previewQaRetryCopyBtn"), "Copied", 1500);
        } catch (_) {}
    });
```

- [ ] **Step 7.3: แสดง/ซ่อนกล่องใน `applyManualResponse`**

Edit — anchor:
```javascript
        status.textContent = parts.join(", ");
        if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
```
แทนด้วย:
```javascript
        status.textContent = parts.join(", ");
        const qaBox = document.getElementById("previewQaRetry");
        if (data.qa_retry_message) {
            document.getElementById("previewQaRetryText").value = data.qa_retry_message;
            qaBox.style.display = "";
        } else {
            qaBox.style.display = "none";
        }
        if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
```

- [ ] **Step 7.4: ตรวจ syntax JS**

Run: `node --check static\js\preview-prompt.js`
Expected: ไม่มี output, exit 0
(index.html ตรวจด้วยตาว่า tag ปิดครบ — เป็น template HTML ไม่มี checker ในโปรเจกต์)

---

### Task 8: Verification รวม

- [ ] **Step 8.1: เทสต์ integration ทั้งชุด**

Run: `.\venv\Scripts\python.exe tests\test_qa_integration.py`
Expected: ทุกบรรทัด PASS, `0 failures`, exit 0

- [ ] **Step 8.2: regression — qa self-tests + slot fill + compile**

```powershell
.\venv\Scripts\python.exe prompts\jp_th\qa_check.py
.\venv\Scripts\python.exe prompts\en_th\qa_check.py
.\venv\Scripts\python.exe prompts\en_vn\qa_check.py
.\venv\Scripts\python.exe -m py_compile translate.py app.py
```
Expected: PASS ทุกเคส / exit 0
และรันสคริปต์ slot-leak เดิม (scratchpad `check_slots.py`) → `0 failures`

- [ ] **Step 8.3: endpoint smoke ซ้ำ (Task 6 script) + สรุปผลให้ user**

รายงาน: ไฟล์ที่แก้, เทสต์ที่รัน+ผลจริง, วิธีทดลองบน UI (เปิด preview modal →
paste response ที่มี violation → เห็นกล่อง retry message)

---

## Self-Review (ทำแล้ว)

- **Spec coverage:** ข้อ 1→Task 1, ข้อ 2→Task 2+3, ข้อ 3→Task 5, ข้อ 4→Task 4+6+7, error handling→Task 1 (try/except), การทดสอบ→ทุก task + Task 8 ✓
- **Placeholder scan:** ไม่มี TBD/TODO — โค้ดเต็มทุก step ✓
- **Type consistency:** `_run_pair_qa(source, target, src_text, out_text, forbid_final_particles)` ตรงกันทุกจุดเรียก; `build_qa_retry_message(ids, errors, total)` ตรงกับ app.py; qa marker `"qa: "` ตรงกันระหว่าง Task 2 (เขียน) กับ Task 4 (อ่าน) และเป็น warning ตัวท้ายสุดเสมอ ✓
