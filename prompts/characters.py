"""CHARACTER PROFILES section + persona inference — voice/register ต่อ speaker
target='th' → Thai particle/pronoun rules (gate ห้าม leak เข้า en/vi output)
ย้ายมาจาก translate.py ทั้ง function — ห้ามแก้ข้อความโดยไม่รัน tests/test_prompt_snapshots.py"""


_AGE_PRONOUN_MAP = {
    "child":  "self pronoun: 'หนู' (F) / 'ผม' (M) / ชื่อเล่น; address others: 'พี่' / 'ลุง/ป้า'",
    "teen":   "self pronoun: 'เรา' / 'ผม' (M) / ชื่อเล่น ('หนู' (F) เฉพาะประโยคที่พูดกับผู้ใหญ่/คนสนิท — ห้ามใช้เป็น default); address others: 'พี่' / 'เพื่อน'",
    "adult":  "self pronoun: 'ผม' (M) / 'ฉัน' / 'ดิฉัน' (formal F); address others: 'คุณ' / 'พี่' / 'น้อง'",
    "middle": "self pronoun: 'น้า/อา/ลุง' (M) / 'ป้า' (F); address others: 'ลูก' / 'หลาน' / 'น้อง'",
    "senior": "self pronoun: 'ตา/ปู่' (M) / 'ยาย/ย่า' (F); address others: 'ลูก' / 'หลาน' / 'หนู'",
}


def _infer_persona_text_th(gender: str, age: str) -> str:
    """auto-infer persona สำหรับ target=th — explicit ตามเพศ+อายุ + age-gated suppression
    ของ ending ที่ TM ไทย (OpenSubtitles) ใช้มั่ว.
    Categories of imperative endings:
      (A) Neutral: สิ/ดิ/ซะ/หน่อย/น่า — ใช้ได้ทุก age/gender
      (B) Childish/whiny: ดิ๊/ดิ้/อิ๊ — ห้ามใช้กับ adult+ (TM ไทยใช้มั่ว ตัดทิ้งเสมอ)
      (C) Rough masculine: ว่ะ/โว้ย/นะโว้ย — male + casual persona เท่านั้น
    NOTE: 'นะ' / 'นะคะ' / 'นะครับ' ไม่ใช่ casual ending free-form — อยู่ใต้ PARTICLE PARITY
    (ต้องมี ね/だね ใน source) — ไม่ระบุที่นี่"""
    parts = []
    g = (gender or "").lower()
    a = (age or "").lower()

    if g == "female":
        parts.append("FEMININE voice")
        parts.append(
            "polite particles: 'ค่ะ' / 'นะคะ' / 'จ้ะ' (เลือกตาม PARTICLE PARITY); "
            "imperatives: 'สิ' / 'น่า' / 'หน่อย' / 'หน่อยน่า'; "
            "ห้ามใช้ rough masculine 'ว่ะ' / 'โว้ย' / 'นะโว้ย'"
        )
    elif g == "male":
        parts.append("MASCULINE voice")
        parts.append(
            "polite particles: 'ครับ' (เลือกตาม PARTICLE PARITY); "
            "imperatives: 'ซะ' / 'ดิ' / 'หน่อย' / no particle; "
            "rough 'ว่ะ' / 'โว้ย' เฉพาะ casual/rough persona; "
            "avoid feminine 'ค่ะ' / 'นะคะ' / 'จ้ะ'"
        )
    else:
        parts.append("neutral voice — เลือก particle ตาม context")

    # age-gated childish suppression — ใช้ได้ทุก gender (anti-OpenSubtitles contamination)
    if a in ("adult", "middle", "senior"):
        parts.append(
            "ห้ามใช้ childish endings 'ดิ๊' / 'ดิ้' / 'อิ๊' — TM ไทย (OpenSubtitles) "
            "ใช้มั่วกับตัวละครผู้ใหญ่ ห้าม inherit"
        )

    if a in _AGE_PRONOUN_MAP:
        parts.append(_AGE_PRONOUN_MAP[a])

    return "; ".join(parts)


def _infer_persona_text_generic(gender: str, age: str) -> str:
    """auto-infer persona สำหรับ target ที่ไม่ใช่ Thai — ไม่อ้างอิงสรรพนาม/อนุภาคของภาษาใด.
    ให้ LLM map gender + age เป็น register ที่เหมาะใน target language เอง"""
    g = (gender or "").lower().strip()
    a = (age or "").lower().strip()
    desc_parts = []
    if g in ("female", "male"):
        desc_parts.append(f"{g} voice")
    if a:
        desc_parts.append(f"age={a}")
    if not desc_parts:
        return "neutral voice"
    base = ", ".join(desc_parts)
    return (
        f"{base} — apply register (pronouns, particles, formality) natural to target language; "
        "do NOT import Japanese honorifics/particles or Thai sentence-final particles "
        "(ค่ะ/ครับ/หนู/ป้า) into the output"
    )


def _infer_persona_text(gender: str, age: str, target: str = "th") -> str:
    """dispatch ตาม target — Thai มี TM-aware suppression, ภาษาอื่นใช้ generic"""
    if target == "th":
        return _infer_persona_text_th(gender, age)
    return _infer_persona_text_generic(gender, age)


def _build_characters_section(characters: list[dict] | None, target: str = "th") -> str:
    """character profiles section. ส่งข้อมูลตรง ๆ ไม่ตีความ ไม่ map.
    target='th' → emit Thai-specific particle/pronoun guidance (ค่ะ/ครับ/หนู/ป้า...)
    target อื่น  → emit เฉพาะ priority + metadata, ไม่ leak Thai rules เข้า output ภาษาอื่น
                  (เช่น th→en, en→vi อย่าให้ LLM โดน Thai particle rules)"""
    if not characters:
        return ""
    lines = []
    lines.append("\n\n═══ CHARACTER PROFILES (FINAL AUTHORITY for voice/register) ═══")
    lines.append("This section overrides earlier rules (including PROJECT-SPECIFIC RULES) whenever")
    lines.append("they conflict on REGISTER (gender particles, age-based pronouns, persona tone).")
    lines.append("Glossary spellings from rules still apply verbatim — only voice is overridden here.")
    lines.append("⚠ NOT overridden: the source's politeness level is a CEILING — a polite persona")
    lines.append("NEVER makes a line more polite than its source (plain source → no polite particle).")
    lines.append("")
    lines.append("Each input line tagged [N|speaker=X] MUST be translated using speaker X's profile.")
    lines.append("Lines tagged [N|speaker=?] = speaker not specified → pick the most fitting profile from the list below")
    lines.append("based on the line content (gender/age cues, vocabulary register, personality match) + neighboring lines.")
    lines.append("Two different speakers MUST produce visibly different translation styles.")
    lines.append("A line without a speaker tag → neutral voice (use default style rules).")
    lines.append("A profile that IS the narrator (name/persona says Narrator/ผู้บรรยาย) → NARRATION register:")
    lines.append("plain literary prose, NO sentence-final politeness particles, even if the source is polite.")
    lines.append("")
    lines.append("PRECEDENCE: character voice OVERRIDES default greeting/expression patterns above.")
    lines.append("If a character's persona indicates rough/casual/dialect speech, use their voice.")

    if target == "th":
        # Thai-specific particle + pronoun system (use only when target language is Thai)
        lines.append("(e.g., a rough character may say 'ขอบใจ' / 'บาย' / 'ว่าไง' even when default rules")
        lines.append("suggest 'ขอบคุณ' / 'ลาก่อน' / 'สวัสดี' — follow the persona, not the default).")
        lines.append("")
        lines.append("VOICE INFERENCE — ถ้าไม่มี personality ระบุ ให้อนุมานจาก gender + age + name:")
        lines.append("")
        lines.append("⚠ CRITICAL: คนไทยจริงไม่ลงท้ายทุกประโยค — particle ใส่เฉพาะตอนเหมาะสมเท่านั้น")
        lines.append("  ตัวอย่างประโยคที่ไม่ต้องมี particle (natural Thai):")
        lines.append("    'ทำอะไรอยู่' / 'ไปไหนมา' / 'อิ่มแล้ว' / 'หิวจัง' / 'ไม่รู้' / 'ไปก่อน'")
        lines.append("    คำสั่ง/อุทาน/internal thought ไม่ต้องลงท้าย")
        lines.append("  ใส่ particle เฉพาะ:")
        lines.append("    - จบประโยคแบบสุภาพ (ตอบ/ถาม ผู้ใหญ่/ลูกค้า) → ค่ะ/ครับ — เฉพาะเมื่อ source สุภาพ (です/ます) ด้วย")
        lines.append("      มารยาทสังคมอย่างเดียวไม่ใช่ใบอนุญาต: ตอบผู้ใหญ่แต่ source ห้วน → ไทยก็ห้วน")
        lines.append("    - ขอความเห็นใจ/ทำให้นุ่ม → นะ/นะคะ/นะครับ (เฉพาะเมื่อ source มี ね/だね)")
        lines.append("    - ยืนยัน/เน้นความรู้สึก → จ้ะ/จ๊ะ/ล่ะ")
        lines.append("  คงไว้ตามต้นฉบับ: ถ้า JP source ไม่มีท้าย (だ/ตัดเปล่า) → TH ก็ไม่ต้องเติม")
        lines.append("                ถ้า JP มี ですね/ますね → TH ค่อยใส่ นะคะ/นะครับ")
        lines.append("")
        lines.append("GENDER → particle ลงท้ายประโยค (เมื่อเหมาะสมเท่านั้น ไม่ใช่ทุก line):")
        lines.append("  female → 'ค่ะ' (polite) / 'จ้ะ' (casual)")
        lines.append("           'นะคะ' ใส่ได้เฉพาะเมื่อ source มี ね/だね (PARTICLE PARITY)")
        lines.append("  male   → 'ครับ' (polite) / ไม่มีท้าย")
        lines.append("           'นะครับ' / 'นะ' ใส่ได้เฉพาะเมื่อ source มี ね/だね (PARTICLE PARITY)")
        lines.append("  other/unspecified → neutral ตาม context")
        lines.append("")
        lines.append("IMPERATIVE ENDINGS (กลุ่ม สิ/ดิ/ซะ/หน่อย/น่า — แยก 3 categories):")
        lines.append("  (A) Neutral: 'สิ' / 'ดิ' / 'ซะ' / 'หน่อย' / 'น่า' — ใช้ได้ทุก age/gender")
        lines.append("  (B) Childish/whiny: 'ดิ๊' / 'ดิ้' / 'อิ๊' — TM ไทย (OpenSubtitles) ใช้มั่ว")
        lines.append("      → ห้ามใช้กับ adult/middle/senior ทุก gender (จะดูเหมือนเด็กแอ๊บ)")
        lines.append("      → child/teen ใช้ได้เมื่อ persona เด็ก/แอ๊บแบ๊ว")
        lines.append("  (C) Rough masculine: 'ว่ะ' / 'โว้ย' / 'นะโว้ย'")
        lines.append("      → ห้ามใช้กับ female ทุก age")
        lines.append("      → male + persona casual/rough เท่านั้น")
        lines.append("")
        lines.append("AGE RANGE → สรรพนามแทนตัวเอง + เรียกคนอื่น (อ้างอิงระบบไทย 5 ช่วง):")
        lines.append("  age=child (0-12): self = 'หนู' / 'ผม' / ชื่อเล่น; เรียกคนอื่น = 'พี่' / 'ลุง/ป้า/น้า/อา'")
        lines.append("  age=teen (13-22): self = 'เรา' / 'เค้า' / 'ผม' / 'กู' (สนิทมาก) / 'ข้า' (เพื่อนสนิท/ภาษาถิ่น) / ชื่อเล่น; 'หนู' เฉพาะคนสนิท/ผู้ใหญ่บ้าน")
        lines.append("    เรียกคนอื่น = 'พี่' / 'เพื่อน' / 'แก' / 'ตัวเอง' / 'เธอ' / 'นาย' / 'เค้า' (น่ารัก/แฟน/สนิท) / 'มึง' (สนิทมาก) / 'เอ็ง' (เพื่อนสนิท/ภาษาถิ่น)")
        lines.append("  age=adult (23-39): self = 'ผม' (M) / 'ดิฉัน' (formal F) / 'ฉัน' / 'เรา' / 'พี่' (กับคนเด็กกว่า) / 'กู' (สนิทมาก) / 'ข้า' (เพื่อนสนิท/ภาษาถิ่น) / 'หนู' (F + บริบทนอบน้อม คุยกับเจ้านาย/ลูกค้า/ผู้ใหญ่)")
        lines.append("    เรียกคนอื่น = 'คุณ' / 'พี่' / 'น้อง' / 'เธอ' / 'เค้า' (น่ารัก/แฟน/สนิท) / 'มึง' (สนิทมาก) / 'เอ็ง' (เพื่อนสนิท/ภาษาถิ่น)")
        lines.append("  age=middle (40-59): self = 'น้า' / 'อา' / 'ลุง' (M) / 'ป้า' (F) / 'พี่' (เป็นกันเอง) / 'ข้า' (เวลาคุยกับเด็ก/ภาษาถิ่น) / 'หนู' (F + บริบทนอบน้อม คุยกับผู้ใหญ่อายุมากกว่ามาก)")
        lines.append("    เรียกคนอื่น = 'ลูก' / 'หลาน' / 'น้อง' / 'คุณ'")
        lines.append("  age=senior (60+): self = 'ตา' / 'ปู่' (M) / 'ยาย' / 'ย่า' (F) / 'ลุง' / 'ป้า' / 'ข้า' (เวลาคุยกับเด็ก/หลาน/ภาษาถิ่น)")
        lines.append("    เรียกคนอื่น = 'ลูก' / 'หลาน' / 'หนู'")
        lines.append("  age=unspecified: default safe = 'ฉัน' (F) / 'ผม' (M)")
        lines.append("")
        lines.append("WARNINGS — สรรพนามที่เลือกผิดบ่อย:")
        lines.append("  'หนู' = default เฉพาะเด็ก (child); teen ใช้เฉพาะประโยคที่พูดกับผู้ใหญ่/คนสนิท — ไม่ใช่ default ของ teen; adult/middle (female) เฉพาะบริบทนอบน้อม (เจ้านาย/ลูกค้า/ผู้ใหญ่อายุมากกว่ามาก)")
        lines.append("  'กู/มึง' = สนิทมาก (เพื่อนสนิท ห้องนอน เพื่อนเก่า) ใช้ได้ทั้ง teen/adult — ห้ามใช้กับคนแปลกหน้า/บริบทเป็นทางการ/ผู้อาวุโส")
        lines.append("  'เธอ/นาย' = casual กันเอง (เพื่อนหรือแฟน) — 'เธอ' มักคู่กับ 'เค้า' (self), 'นาย' มักคู่กับ 'เรา' (self)")
        lines.append("  'ป้า/ยาย/ลุง/ตา' = middle/senior เท่านั้น — ห้ามใช้กับ child/teen/adult")
        lines.append("  Persona override: ถ้า persona ระบุ 'พระสงฆ์' → 'อาตมา'; 'ราชา/ขุนนาง' → 'ข้า/เรา'; 'ยากุซ่า' → 'กู'")
        lines.append("")
        lines.append("NAME hint เสริม: 'พระ' = พระสงฆ์ + 'อาตมา'; 'ป้า/ยาย/ลุง/ปู่' prefix = senior;")
        lines.append("  'น้อง' prefix = teen; ชื่อโบราณ/ขุนนาง = formal + 'ข้า/เรา'")
        lines.append("")
        lines.append("CONSISTENCY: ห้ามใช้ 'ค่ะ/ครับ' ปนกันในตัวละครเดียว เลือกตาม gender ตลอด.")
        lines.append("Two characters with different gender MUST sound different.")
        lines.append("")
    else:
        # non-Thai target — ไม่ emit Thai particle/pronoun guidance (กัน leak สาดเข้าภาษาอื่น)
        lines.append("(e.g., a rough character may use slang or shortened greetings; follow the persona.)")
        lines.append("")
        lines.append("VOICE INFERENCE — ถ้าไม่มี personality ระบุ ให้อนุมานจาก gender + age + name")
        lines.append("ใช้สำนวน/register ที่เหมาะกับ gender + age ในภาษาเป้าหมายเอง.")
        lines.append("⚠ DO NOT import Thai sentence-final particles (ค่ะ/ครับ/นะคะ/หนู/ป้า/ลุง)")
        lines.append("  หรือ Japanese honorifics (san/chan/kun) เข้า output — register ทุกอย่าง")
        lines.append("  ต้องเป็นของภาษาเป้าหมายเท่านั้น")
        lines.append("")
        lines.append("CONSISTENCY: ตัวละครต่าง gender ต้องฟังต่างกันด้วยวิธีของภาษาเป้าหมาย.")
        lines.append("")

    for c in characters:
        cid = c.get("id", "")
        if not cid:
            continue
        name = (c.get("name") or "").strip()
        gender = (c.get("gender") or "").strip()
        age = (c.get("age") or "").strip()
        persona = (c.get("persona") or "").strip()
        lines.append(f"speaker={cid}:")
        if name:
            lines.append(f"   name: {name}")
        if gender:
            lines.append(f"   gender: {gender}")
        if age:
            lines.append(f"   age: {age}")
        if persona:
            lines.append(f"   personality: {persona}")
        else:
            # auto-inferred persona — concrete + deterministic, ไม่ปล่อยให้ LLM เดาเอง
            lines.append(f"   personality (auto): {_infer_persona_text(gender, age, target)}")
        lines.append("")
    return "\n".join(lines)

