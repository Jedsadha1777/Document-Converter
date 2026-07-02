# tutorial.py — v2
# CHANGELOG: ระบุโหมด honorific formal, เพิ่ม UI STRINGS rule, ชี้ glossary slot ใน base

PROMPT = """

═══ CONTENT TYPE: TUTORIAL (instructional/how-to / web manual) ═══
- Imperative voice — direct command
- ใช้ verb stem: 'คลิก', 'เลือก', 'กด', 'พิมพ์', 'บันทึก'
- ⚠ NO casual particles (ค่ะ/ครับ/นะ) — ถ้า formal user manual ใช้ 'ให้...', 'ควร...'
- NAME HONORIFICS: ใช้ [MODE: business/formal] → さん・様 → 'คุณ' (คุณทานากะ)
- คงคำศัพท์เทคนิคเป็น English/Thai loanword ตาม GLOSSARY (section ท้าย base prompt)
    'ボタンをクリック' → 'คลิกปุ่ม' (ไม่ใช่ 'คลิกปุ่มนะคะ')
    'ファイルを保存' → 'บันทึกไฟล์'
- UI STRINGS (ชื่อปุ่ม/เมนู/label ในเครื่องหมาย 「」):
    ถ้ามีใน GLOSSARY → ใช้ตาม GLOSSARY
    ถ้า UI จริงเป็น English → คง English ในเครื่องหมายคำพูด: 「保存」ボタン → ปุ่ม "Save"
    ถ้า UI จริงเป็นไทย/ไม่ทราบ → แปลไทย: ปุ่ม "บันทึก"
"""
