# เชื่อม qa_check เข้า translation pipeline — Design

วันที่: 2026-07-02
สถานะ: อนุมัติ design แล้ว (user: "เอาครบครับ" — ครบทั้ง 4 ข้อ)

## เป้าหมาย

เชื่อม deterministic validator `prompts/{jp_th,en_th,en_vn}/qa_check.py` (ตอนนี้เป็น dead code)
เข้าเส้นทางแปลจริงทั้งหมดของ Document-Converter โดยไม่ขัดสถาปัตยกรรมเดิม:

- batch guard เป็น **advisory** — ติด warning ให้ UI/ผู้ใช้ตัดสินใจ ห้ามแทนผลแปลโดยพลการ
  (comment ใน `_post_process_batch` ระบุชัด)
- workflow หลักของ user คือ copy prompt → วางใน Gemini web → paste ผลกลับ
  (`/translate-batch/apply-manual`) — retry ในตัวทำไม่ได้สำหรับเส้นทางนี้

## ขอบเขต

ทำ: translate.py, app.py (endpoint apply-manual), static/js/preview-prompt.js (+ template modal ใน index.html ถ้าจำเป็น)
ไม่ทำ: correct.py, Apple/NLLB paths (ไม่ใช้ prompt), คู่ภาษา th→en (ไม่มี validator), แก้ logic ภายใน qa_check เอง

## ส่วนประกอบ

### 1. ตัวเลือก validator ตามคู่ภาษา (translate.py)

- import ทั้ง 3 โมดูลระดับไฟล์ (ตาม pattern import prompts เดิม)
- helper `_run_pair_qa(source, target, src_text, out_text, forbid_final_particles=False) -> dict | None`
  - `("ja","th")` → `jp_th.qa_check.check(src, out)`
  - `("en","th")` → `en_th.qa_check.check(src, out, source_lang="en")`
  - `("en","vi")` → `en_vn.qa_check.check(src, out, source_lang="en", target_lang="vi", forbid_final_particles=...)`
  - คู่อื่น / source ไม่รู้ → `None` (ข้าม ไม่ตรวจ)
- retry message ใช้ `retry_message()` ของโมดูลที่ match คู่ภาษาเดียวกัน
- **กฎเหล็ก: qa_check ห้ามทำ pipeline พัง** — ครอบ try/except รอบการเรียก check;
  exception → log แล้วข้าม (ถือว่าไม่ตรวจ)

### 2. Batch ทุกเส้นทาง — advisory marker (จุดเดียว: `_post_process_batch`)

ครอบคลุม qwen API, Gemini API, และ paste มือ (ทั้งหมดวิ่งผ่านฟังก์ชันนี้)

- เพิ่มพารามิเตอร์ `source: str | None = None, content_type: str | None = None`
- ผู้เรียก 3 จุดส่งค่าเพิ่ม: `_translate_batch_qwen`, `_translate_batch_gemini`
  (มี texts + content_type อยู่แล้ว; source ได้จาก `_detect_source_language(texts)`),
  `apply_manual_batch` (เพิ่มพารามิเตอร์ `content_type` optional)
- ต่อ item ที่แปลสำเร็จ (raw ไม่ว่าง ไม่ exception): เรียก
  `_run_pair_qa(source, target, _join_lines(original), t, forbid_final_particles=(content_type == "product_catalog"))`
  แล้ว append error แต่ละตัวเป็น `qa: <ข้อความ>` เข้า warnings ของ item นั้น
- line parity เทียบหลัง `_join_lines` ทั้งสองฝั่ง เพราะ batch collapse บรรทัด output อยู่แล้ว
  (กัน false positive)
- ยอมรับว่า digit/script error จาก qa อาจซ้ำ marker เดิม (`digit_mismatch`, `foreign_script`) —
  เป็น advisory ซ้ำได้ ไม่อันตราย
- ไม่มี LLM call เพิ่มในเส้นทาง batch

### 3. Single path — retry อัตโนมัติ 1 รอบ (`translate_text`, ollama เท่านั้น)

- จุดตรวจ: หลัง `_normalize_numerals(out)` **ก่อน** `_restore_segments` —
  เทียบกับ `text_protected` เพื่อกัน false positive จาก URL/email ที่ถูก restore
  (digit ใน placeholder X9990X มีเท่ากันสองฝั่ง → parity ไม่พัง)
- ถ้า errors ไม่ว่าง: เรียก ollama ซ้ำ 1 ครั้งด้วย system prompt เดิม + `retry_message(errors)`
  แล้ว normalize ผลใหม่แบบเดียวกัน ตรวจซ้ำ
- เกณฑ์รับผล retry: จำนวน error ใหม่ **น้อยกว่า** เดิม (อุดมคติ = 0) มิฉะนั้นคงผลแรก
- log ทั้งสองกรณีตาม pattern `print(f"[translate] ...", flush=True)` เดิม
- content_type ไม่มีในเส้นทางนี้ → `forbid_final_particles=False` เสมอ
- ขั้นตอนเดิมที่เหลือ (restore, digit check) ทำงานต่อจากผลที่เลือกแล้วตามลำดับเดิม

### 4. Manual Gemini flow — qa_retry_message ให้ copy วางต่อในแชทเดิม

- helper ใหม่ใน translate.py: `build_qa_retry_message(ids, errors, n) -> str | None`
  - ดึงเฉพาะ error ที่ขึ้นต้น `qa: ` จาก errors รายบรรทัด จับคู่กับ id
  - ไม่มีสัก item → คืน `None`
  - เนื้อหาข้อความ (ภาษาอังกฤษ ให้ LLM อ่าน):
    1. ระบุรายการ `id N: <error>` ที่ผิดกฎ
    2. สั่งให้ตอบ **JSON ครบทุก item (ทั้ง n ตัว, id/schema เดิม)** ไม่ใช่เฉพาะข้อที่แก้ —
       เพราะระบบ parse ทั้ง chunk ตอน paste กลับ ถ้าไม่ครบ บรรทัดดีจะกลายเป็น missing
    3. ย้ำว่ากฎทั้งหมดจากข้อความแรก (character profiles / TM rules / glossary) ยังมีผล
- app.py `/translate-batch/apply-manual`: รับ `content_type` จาก payload (optional),
  ส่งต่อให้ `apply_manual_batch`; ใส่ `"qa_retry_message"` ใน JSON response
- preview-prompt.js `applyManualResponse`: ส่ง `content_type` ใน POST body (ค่าเดียวกับที่
  preview ใช้) และถ้า response มี `qa_retry_message` → แสดงกล่องข้อความ + ปุ่ม copy
  ใน modal เดิม (เพิ่ม element ใน `previewModalTpl` ของ index.html ตามจำเป็น)
- ข้อจำกัดที่ยอมรับ: ใช้ได้เฉพาะวางต่อในแชท Gemini เดิม ถ้าเปิดแชทใหม่ต้อง copy prompt เต็มก่อน
  (เรื่อง workflow ไม่ใช่โค้ด)

## Error handling รวม

- ทุกการเรียก qa_check ครอบ try/except — validator พัง ≠ การแปลพัง
- แปลว่าง/missing/exception ของ item → ข้ามการตรวจ item นั้น

## การทดสอบ

1. self-test เดิมของ qa_check ทั้ง 3 ต้องยังผ่าน (ไม่แตะไฟล์ validator)
2. สคริปต์ทดสอบ (ไม่ต้องมี ollama):
   - `_run_pair_qa` mapping ถูกคู่ / คู่แปลกคืน None / exception ไม่หลุด
   - `_post_process_batch` กับ parsed ปลอมที่มี violation → มี `qa: ` marker ถูกบรรทัด
     และ item ดีไม่มี marker
   - `build_qa_retry_message` — มี/ไม่มี qa error, id ไม่ติดกัน
   - `translate_text` retry: monkeypatch `_call_ollama_translate` คืนผลแย่→ดี และ แย่→แย่
     ตรวจเกณฑ์รับ/ไม่รับ
3. import app.py สำเร็จ + endpoint smoke ผ่าน flask test client กับ `apply_manual_batch` จริง

## ธรรมเนียมโปรเจกต์

- backup ไฟล์ที่แก้ทุกไฟล์ไป `Document-Converter/backup/` ก่อนแก้ (timestamp เดียวกัน)
- ไม่เพิ่ม comment ที่ restate โค้ด — เฉพาะ WHY ที่ไม่ชัดจากโค้ด
- โมเดลแปลยังเป็น 1.5B ผ่าน ollama — ไม่แตะ config โมเดล
