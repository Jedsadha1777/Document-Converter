# Prompt Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ย้าย prompt text ทั้งหมดจาก translate.py / correct.py / tm.py เข้า `prompts/` โดย byte-equal 100% + รวม batch schema builder เป็นตัวเดียว

**Architecture:** Golden-snapshot-first — capture prompt output ของ code ปัจจุบันก่อนแตะอะไร แล้วย้ายทีละโมดูล รัน snapshot test หลังทุก task ต้องผ่านเต็มก่อน commit

**Tech Stack:** Python stdlib เท่านั้น (plain test script ตาม pattern tests/test_qa_integration.py — ไม่มี pytest ใน venv)

**Spec:** docs/superpowers/specs/2026-07-02-prompt-reorg-design.md

**Byte-equality rule ทุก task:** ย้าย literal ด้วยการ cut-paste ทั้งก้อนจาก line range ที่ระบุ — ห้ามพิมพ์ใหม่ ห้าม reformat ห้ามแก้ escape

---

### Task 1: Golden snapshot test (สร้างจาก code ปัจจุบัน — ก่อนย้ายทุกอย่าง)

**Files:**
- Create: `tests/test_prompt_snapshots.py`
- Create (generated): `tests/prompt_snapshots.golden.json`

- [ ] **Step 1: เขียน test script**

Script มี 2 โหมด: `--write` สร้าง golden จาก code ปัจจุบัน / ไม่มี arg เทียบกับ golden
เคสครอบ (ดูโค้ดเต็มใน task execution — สร้างครั้งเดียว):
- `_build_batch_system_prompt`: ทุก (source,target) ∈ {(ja,th),(en,th),(en,vi),(th,en),(None,th),(None,en),(None,ja),(None,vi)} × content_type ∈ {None,manga_novel,tutorial,product_catalog} × custom_rules {None,sample} × characters {None,sample(auto-persona F/adult + M/teen + persona explicit)} × ids {contiguous(id_start=5,n=3), sparse[2,7,9]}
  (ลด combinatorial: full cross ของ (pair×content_type) โดย rules+chars เปิด, ids contiguous; บวก edge cases: rules/chars ปิดทีละตัว, sparse ids, id_start=1)
- `correct._build_correct_batch_system_prompt`: (thai text, ja text, mixed) × custom_rules {None,sample}
- `correct.pick_prompt` / `correct.pick_context_prompt`: thai / ja / mixed
- `tm._format_rules`: [] และ 2 sample hits
- literal dicts: `TRANSLATE_PROMPTS`, `TRANSLATE_PROMPTS_BY_PAIR`, `TRANSLATE_STYLE_PROMPTS` (key → value string)

- [ ] **Step 2: สร้าง golden + verify ตัวเอง**

Run: `venv/bin/python tests/test_prompt_snapshots.py --write`
Expected: เขียน golden JSON, พิมพ์จำนวนเคส
Run: `venv/bin/python tests/test_prompt_snapshots.py`
Expected: `PASS all N cases`

- [ ] **Step 3: Commit**

```bash
git add tests/test_prompt_snapshots.py tests/prompt_snapshots.golden.json docs/superpowers/
git commit -m "test: golden prompt snapshots ก่อน reorg + spec/plan"
```

### Task 2: prompts/universal.py + prompts/th_en/base.py

**Files:**
- Create: `prompts/universal.py` ← ย้าย `TRANSLATE_PROMPTS` dict ทั้งก้อน (translate.py:254-433)
- Create: `prompts/th_en/__init__.py` (ว่าง), `prompts/th_en/base.py` ← ย้าย th→en string (translate.py:443-460) เป็น `PROMPT = (...)`
- Modify: `translate.py` — ลบ literal, import `from prompts import universal as _universal`, `from prompts.th_en import base as _th_en_base`; `TRANSLATE_PROMPTS = _universal.TRANSLATE_PROMPTS`; ใน `TRANSLATE_PROMPTS_BY_PAIR` ใช้ `("th","en"): _th_en_base.PROMPT`

- [ ] **Step 1: ย้าย + แก้ import**
- [ ] **Step 2: Run `venv/bin/python tests/test_prompt_snapshots.py` → PASS ทุกเคส**
- [ ] **Step 3: Run `venv/bin/python tests/test_qa_integration.py` → ผ่านเท่าเดิม**
- [ ] **Step 4: Commit** `refactor: ย้าย universal + th_en prompts เข้า prompts/`

### Task 3: prompts/generic_styles.py

**Files:**
- Create: `prompts/generic_styles.py` ← ย้าย 3 generic overlay strings จาก `TRANSLATE_STYLE_PROMPTS` (translate.py:519-548: manga_novel_generic, tutorial_generic, product_catalog_generic) เป็น `MANGA_NOVEL`, `TUTORIAL`, `PRODUCT_CATALOG`
- Modify: `translate.py` — dict ชี้ไป constants ใหม่ (key เดิมคงไว้ — `_resolve_style_block` ใช้ key string)

- [ ] **Step 1: ย้าย + แก้ import**
- [ ] **Step 2: snapshot test → PASS**
- [ ] **Step 3: Commit** `refactor: ย้าย generic style overlays เข้า prompts/`

### Task 4: prompts/characters.py

**Files:**
- Create: `prompts/characters.py` ← ย้ายทั้ง function ไม่แก้ body: `_AGE_PRONOUN_MAP` (translate.py:990-996), `_infer_persona_text_th` (999-1040), `_infer_persona_text_generic` (1043-1060), `_infer_persona_text` (1063-1067), `_build_characters_section` (1070-1185) — export ชื่อ public: `build_characters_section`, `infer_persona_text`
- Modify: `translate.py` — ลบของเดิม, import + alias ชื่อ private เดิม (กัน caller ภายใน/ tests ที่อ้าง `translate._build_characters_section`)

- [ ] **Step 1: ย้าย + alias**
- [ ] **Step 2: snapshot test → PASS**
- [ ] **Step 3: Commit** `refactor: ย้าย characters/persona section เข้า prompts/`

### Task 5: prompts/sections.py (รวม batch schema — mechanical merge จุดเดียว)

**Files:**
- Create: `prompts/sections.py`:
  - `NARRATION_RULE_TH` (translate.py:1208-1240), `NARRATION_RULE_GENERIC` (1242-1262)
  - `build_rules_section(custom_rules) -> str` — PARITY armor wrapper (translate.py:1300-1334) ย้ายทั้งก้อน **ห้าม trim**
  - `PROTECTED_TOKENS_RULE` (1336-1347)
  - `FACTUAL_BATCH` (1294-1297), `FACTUAL_SINGLE` + `PROTECTED_HINT_SINGLE` (จาก translate_text:604-617 — ย้ายเป็น module constant ก่อนใน translate.py แล้วค่อยย้ายไฟล์ ถ้า diff ไม่สะอาด)
  - `build_batch_schema(n, ids_to_use, mode)` — mode="translate" (contiguous/sparse จาก translate.py:1263-1293), mode="correct" (จาก correct.py:432-447)
  - `TM_RULES_INTRO` (tm.py:665-669 — intro strings ใน `_format_rules`)
- Modify: `translate.py` — `_build_batch_system_prompt` เรียก sections.*; `translate_text` ใช้ constants
- Modify: `correct.py` — `_build_correct_batch_system_prompt` เรียก `build_batch_schema(n, ..., mode="correct")`
- Modify: `tm.py` — `_format_rules` ใช้ `TM_RULES_INTRO`

- [ ] **Step 1: ย้าย narration + armor + protected + factual → snapshot test → PASS**
- [ ] **Step 2: รวม schema builder → snapshot test → PASS (ทั้ง translate และ correct cases)**
- [ ] **Step 3: ย้าย TM intro → snapshot test → PASS**
- [ ] **Step 4: Commit** `refactor: ย้าย assembly sections เข้า prompts/ + รวม batch schema builder`

### Task 6: prompts/correct_ocr.py

**Files:**
- Create: `prompts/correct_ocr.py` ← ย้าย `OCR_CONTEXT_INTRO` (correct.py:23-30), `PROMPT_JA` (33-64), `PROMPT_TH` (66-92), `PROMPT_MIXED` (94-112), `PROMPT_CONTEXT_BASE` (214-225), `PROMPT_CONTEXT_TH` (227-240), `PROMPT_CONTEXT_JA` (242-248)
- Modify: `correct.py` — import + alias ชื่อเดิม (`PROMPT_JA = correct_ocr.PROMPT_JA` ฯลฯ — pick_prompt/pick_context_prompt ใช้ต่อ)

- [ ] **Step 1: ย้าย + alias**
- [ ] **Step 2: snapshot test → PASS + `tests/test_qa_integration.py` ผ่านเท่าเดิม**
- [ ] **Step 3: Commit** `refactor: ย้าย OCR correction prompts เข้า prompts/`

### Task 7: Final verification

- [ ] **Step 1: snapshot test เต็ม → PASS ทุกเคส**
- [ ] **Step 2: `venv/bin/python tests/test_qa_integration.py` → ผลเท่า baseline ก่อนเริ่ม**
- [ ] **Step 3: `venv/bin/python -c "import app"` → import chain ทั้งหมดไม่พัง**
- [ ] **Step 4: grep ยืนยันไม่มี prompt literal ตกค้างใน translate.py/correct.py นอกเหนือ retry glue ที่ตกลงไว้**
- [ ] **Step 5: Commit สุดท้าย (ถ้ามีแก้เพิ่ม) + สรุปให้ user (ห้าม push — user push เอง)**

## Self-review notes

- Spec coverage: universal ✔ th_en ✔ generic ✔ characters ✔ sections+schema merge ✔ correct_ocr ✔ TM intro ✔ snapshot ✔
- ชื่อ import ที่ตั้ง: `_universal`, `_th_en_base`, `sections`, `correct_ocr` — สอดคล้อง pattern `_jp_th_base` เดิม
- Baseline ของ test_qa_integration.py ต้องจดผลก่อนเริ่ม (มันมี expected fail อยู่แล้วหรือไม่ — เช็คใน Task 1)
