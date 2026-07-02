# Prompt Reorganization — Design

**Date:** 2026-07-02
**Status:** approved (user picked "ย้าย + รวมส่วน mechanical")

## Problem

Prompt text กระจายอยู่ 4 ที่: `prompts/` (จัดแล้ว), `translate.py` (~700 บรรทัด prompt ฝังใน code),
`correct.py` (~250 บรรทัด), `tm.py` (rules intro) — หายาก แก้ยาก และ batch JSON schema
ถูกสร้างซ้ำสองที่ (translate + correct)

## Non-negotiable constraints

1. **Byte-equality:** ข้อความ prompt ทุกก้อนต้องเหมือนเดิม 100% — งานนี้ย้ายที่อยู่เท่านั้น
   ห้ามแก้คำ ห้าม trim ห้าม "ปรับปรุง" ระหว่างทาง
2. **PARITY armor block** (PROJECT-SPECIFIC RULES wrapper ใน translate.py) = เกราะกัน TM noise —
   ย้ายทั้งก้อน ห้ามแตะเนื้อหา
3. **Thai particle rules ห้าม leak ข้ามคู่ภาษา** — target-dispatch (th vs non-th) คงเดิมทุกจุด
4. Assembly order ใน `_build_batch_system_prompt` คงเดิมเป๊ะ:
   base → style → narration → rules → chars → schema → protected → factual
5. Public API เดิมไม่เปลี่ยน: `app.py` import `_build_batch_system_prompt` จาก translate.py ต่อได้,
   `correct.py` import shared utils จาก translate.py ต่อได้

## Target structure

```
prompts/
  jp_th/  en_th/  en_vn/     (เดิม — ไม่แตะ)
  th_en/base.py              ← th→en prompt (inline ใน TRANSLATE_PROMPTS_BY_PAIR)
  universal.py               ← TRANSLATE_PROMPTS fallback dict (th/en/ja/vi)
  generic_styles.py          ← MANGA_NOVEL / TUTORIAL / PRODUCT_CATALOG generic overlays
  characters.py              ← _AGE_PRONOUN_MAP + _infer_persona_text_{th,generic} +
                               _infer_persona_text + _build_characters_section (ย้ายทั้ง function)
  sections.py                ← NARRATION_RULE_TH, NARRATION_RULE_GENERIC,
                               build_rules_section(custom_rules)  (PARITY armor wrapper),
                               PROTECTED_TOKENS_RULE, FACTUAL_BATCH, FACTUAL_SINGLE,
                               PROTECTED_HINT_SINGLE, TM_RULES_INTRO,
                               build_batch_schema(n, ids, mode)   (mechanical merge เดียว)
  correct_ocr.py             ← OCR_CONTEXT_INTRO, PROMPT_JA/TH/MIXED,
                               PROMPT_CONTEXT_BASE/TH/JA
```

## What stays put

- `_build_batch_system_prompt`, `_resolve_prompt`, `_resolve_style_block`, `_fill_prompt_slots`
  อยู่ translate.py (assembly logic)
- `pick_prompt` / `pick_context_prompt` logic อยู่ correct.py (import ข้อความจาก prompts/)
- retry glue strings ใน translate_text (refusal retry one-liner, stricter script retry,
  digit_strict) — ผูกกับ control flow, อยู่ที่เดิม

## Mechanical merge (จุดเดียว)

`build_batch_schema(n, ids, mode)` ใน sections.py แทน schema builder 2 ชุด:
- mode="translate": contiguous + sparse branch (จาก translate.py)
- mode="correct": ข้อความฝั่ง correct รวม "NEVER paraphrase" lines (จาก correct.py)
Output ต่อ caller byte-equal ของเดิม

## Verification

`tests/test_prompt_snapshots.py` (plain script style เหมือน test_qa_integration.py):
- สร้าง golden snapshot จาก **code ปัจจุบันก่อนย้าย** → `tests/prompt_snapshots.golden.json`
- ครอบ: `_build_batch_system_prompt` ทุก (source,target) pair × content_type ×
  custom_rules on/off × characters on/off (มี auto-persona ทั้ง th และ non-th) ×
  contiguous/sparse ids, `_build_correct_batch_system_prompt`, `pick_prompt` /
  `pick_context_prompt` ทั้ง 3 script, `tm._format_rules`, และ dict literal ทุกตัว
  (TRANSLATE_PROMPTS, TRANSLATE_PROMPTS_BY_PAIR, TRANSLATE_STYLE_PROMPTS)
- ทุก step ของการย้ายต้องรัน test ผ่าน 100% ก่อน commit

## Out of scope (ตัดสินใจแล้ว — ไม่ทำในงานนี้)

- รวมเนื้อหาซ้ำเชิง content (imperative endings 4 ที่, greetings, KATAKANA, NUMBERS
  ต่อ pair) — battle-tested แล้ว การรวมคำเสี่ยงเปลี่ยนพฤติกรรม LLM
- ลดการซ้ำใน assembled prompt runtime (PARTICLE PARITY โผล่หลาย section) —
  positional override เป็นของตั้งใจ
