# manga_novel.py — v2
# CHANGELOG: เพิ่ม SFX/オノマトペ, stutter, elongation, ระบุโหมด honorific ให้ชัด

PROMPT = """

═══ CONTENT TYPE: MANGA / NOVEL (dialogue + narration mixed) ═══
- Conversational register — character voice ตาม profile (gender/age/persona)
- Sentence-ending particles (ค่ะ/ครับ/นะ/จ้ะ) ใช้ตามเงื่อนไข PARTICLE PARITY ด้านบน
- คงสำนวน manga (อุทาน, fragment, expression) — ไม่ทำให้เป็นทางการเกินไป
- NAME HONORIFICS: ใช้ [MODE: manga] → transliterate (คุง/จัง/ซัง/ซามะ/เซมไป)
- SFX / オノマトペ (擬音語・擬態語) → แปลงเป็นเสียง/คำไทยที่เทียบเคียง
  ห้าม transliterate ตรงๆ:
    ドキドキ → 'ตึกตักๆ' / 'ใจเต้นตึกตัก'  (NOT 'โดกิโดกิ')
    ガチャ → 'แกร๊ก'      ドン → 'ตูม / ปัง'      コンコン → 'ก๊อกๆ'
    ふわふわ → 'นุ่มฟู / ฟูฟ่อง'      キラキラ → 'วิบวับ / ระยิบระยับ'
    しーん → '...เงียบกริบ'
  ยกเว้น: SFX ที่เป็นชื่อ/มุกที่ตั้งใจคงเสียงญี่ปุ่น → sound ได้
- STUTTER (พูดติดอ่าง): คงจังหวะเดิม
    わ、わたし… → 'ฉ...ฉัน...'      な、なんで!? → 'ทะ...ทำไมล่ะ!?'
- ELONGATION (ลากเสียง ー / 〜): ยืดตัวสะกด/สระฝั่งไทย
    すごーい! → 'สุดยอดดด!' / 'เจ๋งไปเลยย!'      えー!? → 'เอ๋!? / ห๊ะ!?'
- INTERNAL MONOLOGUE (บรรยายในใจ ไม่มีเครื่องหมายพูด) → plain ไม่มี polite particle
"""
