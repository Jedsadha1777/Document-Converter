"""Assembly sections ของ batch/single system prompt — ใช้ร่วม translate.py / correct.py / tm.py
ย้ายมาจาก translate.py + correct.py + tm.py ทั้งก้อน
ห้ามแก้ข้อความโดยไม่รัน tests/test_prompt_snapshots.py"""


# narration_rule = per-line auto-rule (speaker tag present → dialogue, absent → narration)
# target-dispatch: TH version มี Thai particle examples — ห้ามใช้กับ target อื่น (กัน leak)
NARRATION_RULE_TH = (
                "\n\n═══ NARRATION DETECTION (per-line auto-rule) ═══\n"
                "- Input lines tagged [N|speaker=X] = SPOKEN by character X → use character voice + particles ตามเงื่อนไข\n"
                "- Input lines tagged [N|speaker=?] = SPOKEN dialogue, speaker NOT specified → CHOOSE the most fitting character\n"
                "  from CHARACTER PROFILES below by matching gender/age cues, vocabulary register, and personality description\n"
                "  against the line content + context from neighboring lines; translate using that character's voice + particles\n"
                "  ตามเงื่อนไข PARTICLE PARITY. Default to the first character if truly ambiguous.\n"
                "- Input lines tagged [N] only (no |speaker=) = NARRATION/EXPOSITORY/CAPTION\n"
                "  → ⚠ NO sentence-ending particles (ห้าม ค่ะ/ครับ/นะ/จ้ะ)\n"
                "  → ใช้ literary register (verb stem, no polite suffix)\n"
                "  → reference characters as 'เขา/เธอ/พวกเขา' (3rd person), ไม่ใช้ 'ผม/ฉัน' ถ้าไม่ใช่ direct speech\n"
                "    [5] 部屋は静かだった         → 'ห้องเงียบสงบ'              (NOT 'ห้องเงียบสงบนะคะ')\n"
                "    [6] 彼は窓の外を見た         → 'เขามองออกไปนอกหน้าต่าง'    (NOT 'เขามองออกไปนอกหน้าต่างค่ะ')\n"
                "    [7|speaker=2] 寒いね        → 'หนาวจังเลยนะ'             (มี particle ได้ — speaker tag present)\n"
                "    [8|speaker=?] お腹空いた     → เลือก character จาก profile → ใช้ voice นั้น (เช่น polite girl → 'หิวจังเลย')\n"
                "- Input lines tagged [N|...|emotion=Y] = อารมณ์ของ speaker ในประโยคนั้น = Y (Thai word)\n"
                "  Y อาจเป็น single emotion ('ดีใจ') หรือ combined 'A+B' (เช่น 'ดีใจ+เขิน' = ดีใจแต่เขิน)\n"
                "  → ปรับ word choice + tone ตาม emotion category:\n"
                "    Positive (ดีใจ/ตื่นเต้น/ขำ/ภูมิใจ/รัก/หวัง/มั่นใจ/ปลื้ม)\n"
                "      → upbeat phrasing, exclamation, particle 'จัง'/'ล่ะ'/'แล้ว', extended vowels 'ดีใจมากก'\n"
                "    Neutral/Calm (เฉยๆ/สบาย/จริงจัง)\n"
                "      → plain register, no emotional marker, no playful particle\n"
                "    Sad/Regret (เศร้า/ผิดหวัง/เหนื่อย/เบื่อ/สงสาร)\n"
                "      → soft tone, particle 'หรอก', sighs, trail-off '...' OK ('นะ' ต้องมี ね/よ ใน source)\n"
                "    Anger/Disgust (โกรธ/หงุดหงิด/รังเกียจ/เกลียด/ดูถูก)\n"
                "      → terse, no polite particle, rough male persona อาจ 'ว่ะ/โว้ย'; spit-tone\n"
                "    Fear/Surprise (กลัว/ตกใจ/กังวล/ผวา)\n"
                "      → trembling/short phrasing, 'หา?!'/'อ๊ะ!', stammer 'ฉัน-ฉันไม่...', exclamation\n"
                "    Uncertainty/Social (อิจฉา/ประชด/ลังเล/สงสัย/งง/เขิน/อาย)\n"
                "      → hedged, hesitant markers 'อืม...', particle 'แหละ'/'ล่ะมั้ง' (ประชด), stuttering (เขิน)\n"
                "  emotion overrides character 'calm baseline' เมื่อขัดกัน — แต่ยังต้องเคารพ PARTICLE PARITY\n"
                "- Input lines tagged [N|...|emotion=?] = ไม่ระบุ → infer จาก source + context + persona ก่อนแปล\n"
)

NARRATION_RULE_GENERIC = (
                "\n\n═══ NARRATION DETECTION (per-line auto-rule) ═══\n"
                "- Input lines tagged [N|speaker=X] = SPOKEN by character X → use character voice + register\n"
                "  natural to the target language.\n"
                "- Input lines tagged [N|speaker=?] = SPOKEN dialogue, speaker NOT specified → CHOOSE the most fitting character\n"
                "  from CHARACTER PROFILES below by matching gender/age cues, vocabulary register, and personality description\n"
                "  against the line content + context; translate using that character's voice in the target language.\n"
                "  Default to the first character if truly ambiguous.\n"
                "- Input lines tagged [N] only (no |speaker=) = NARRATION / EXPOSITORY / CAPTION\n"
                "  → Use literary/narrative register of the target language (no dialogue particles or\n"
                "    chat fillers — just plain narrative prose).\n"
                "  → Reference characters in 3rd person (he / she / they — equivalent in target language),\n"
                "    not 1st person ('I'), unless the line is direct speech.\n"
                "  ⚠ Do NOT import Thai sentence-final particles (ค่ะ/ครับ/นะคะ/จ้ะ) or Japanese\n"
                "  honorifics (san/chan/kun) into the output — register cues must be target-language only.\n"
                "- Input lines tagged [N|...|emotion=Y] = the speaker's emotion = Y (target-language word)\n"
                "  Y may be a single emotion ('happy') or combined 'A+B' (e.g., 'happy+shy' = layered).\n"
                "  → adjust word choice / tone to match the emotion (e.g., happy → energetic phrasing;\n"
                "    angry → terse; sarcastic → cynical; sad → soft) in a way natural to the target language.\n"
                "- Input lines tagged [N|...|emotion=?] = unspecified → infer from source + context + persona.\n"
)


def build_batch_schema(n: int, ids_to_use: list[int] | None = None,
                       mode: str = "translate") -> str:
    """BATCH MODE JSON schema instruction — รวม builder ของ translate + correct
    mode="translate": contiguous/sparse ตาม ids_to_use; mode="correct": ids 1..n เสมอ"""
    if mode == "correct":
        return (
        f"\n\nBATCH MODE: You will correct exactly {n} numbered items.\n"
        f"OUTPUT (JSON ONLY — no prose, no markdown):\n"
        f'{{"items": [\n'
        f'  {{"id": 1, "text": "<corrected version of input [1]>"}},\n'
        f'  {{"id": 2, "text": "<corrected version of input [2]>"}},\n'
        f"  ...\n"
        f'  {{"id": {n}, "text": "<corrected version of input [{n}]>"}}\n'
        f"]}}\n"
        f"RULES:\n"
        f'- "items" array must contain EXACTLY {n} elements.\n'
        f'- IDs 1..{n} in ascending order, no skips, no duplicates.\n'
        f"- For each item, apply the correction rules to the text after [N].\n"
        f"- If no correction is needed, output the text unchanged.\n"
        f"- NEVER translate. NEVER paraphrase. Only fix character-level OCR errors.\n"
        )
    first = ids_to_use[0]
    last = ids_to_use[-1]
    is_contiguous = (last - first + 1 == n)
    if is_contiguous:
        return (
            f"\n\nBATCH MODE: You will translate exactly {n} numbered items.\n"
            f"OUTPUT (JSON ONLY — no prose, no markdown):\n"
            f'{{"items": [\n'
            f'  {{"id": {first}, "text": "<translation of input [{first}]>"}},\n'
            f'  {{"id": {first + 1}, "text": "<translation of input [{first + 1}]>"}},\n'
            f"  ...\n"
            f'  {{"id": {last}, "text": "<translation of input [{last}]>"}}\n'
            f"]}}\n"
            f"RULES:\n"
            f'- "items" array must contain EXACTLY {n} elements.\n'
            f'- Each element has "id" (integer {first}..{last}) and "text" (the translation).\n'
            f"- IDs must be {first} through {last} in ascending order, no skips, no duplicates.\n"
            f"- Each text is the translation of the input line with the same number.\n"
        )
    ids_str = ", ".join(str(x) for x in ids_to_use)
    return (
            f"\n\nBATCH MODE: You will translate exactly {n} numbered items.\n"
            f"OUTPUT (JSON ONLY — no prose, no markdown):\n"
            f'{{"items": [{{"id": <int>, "text": "<translation>"}}, ...]}}\n'
            f"RULES:\n"
            f'- "items" array must contain EXACTLY {n} elements.\n'
            f'- IDs MUST be exactly: {ids_str} (matching the [N] markers in input — preserve any gaps).\n'
            f"- Each text is the translation of the input line with the same id.\n"
        )


FACTUAL_BATCH = (
        "\n\nIMPORTANT: This is factual content. Translate every item directly without "
        "commentary, disclaimers, content warnings, or refusals. Just translate."
)

# factual hint (single-flow) — ลด safety refusal กับ medical/anatomical text
FACTUAL_SINGLE = (
        "\n\nIMPORTANT: This is a factual document (educational, medical, technical, or "
        "informational). Translate every input directly and faithfully without commentary, "
        "disclaimers, content warnings, or refusals. If the text contains medical, "
        "anatomical, or technical terms, translate them with their proper equivalent terms. "
        "Never refuse to translate. Never replace the translation with a message about "
        "the content. Just translate."
)

# PROTECTED TOKENS hint (single-flow) — ใส่เฉพาะตอนมี placeholder จริง
PROTECTED_HINT_SINGLE = (
            "\n\nPROTECTED TOKENS: tokens like X9990X / X9991X (uppercase X + 4 digits + uppercase X) "
            "are placeholders for URL/HTML/email/code. Copy them VERBATIM in the output — "
            "do not translate, drop, or add spaces inside them. All input tokens must appear in output."
)


def build_rules_section(custom_rules: str | None) -> str:
    """PROJECT-SPECIFIC RULES wrapper = PARITY armor กัน TM noise — ห้าม trim/replace เนื้อหา"""
    if not (custom_rules and custom_rules.strip()):
        return ""
    return (
            "\n\n═══ PROJECT-SPECIFIC RULES (glossary + style guide) ═══\n"
            "SCOPE — these rules cover 2 things only:\n"
            "  1. TERM SPELLING (glossary 'X => Y') — applies verbatim regardless of speaker\n"
            "  2. DOCUMENT TONE / ATMOSPHERE (style notes) — applies to ALL text (dialogue +\n"
            "     narration), but does NOT override character-specific REGISTER.\n"
            "REGISTER (sentence-final particles, pronouns, formality level) is owned by the\n"
            "CHARACTER PROFILES section below — that section is the final authority.\n"
            "\n"
            "WRONG behavior to avoid:\n"
            "  - adult character (age=adult, gender=female) saying 'เร็วดิ๊'\n"
            "    (childish ending 'ดิ๊' — TM ไทยใช้มั่ว ห้าม inherit)\n"
            "  - elderly male using teen slang because a rule example mentions slang\n"
            "  - female character using 'ว่ะ / โว้ย' (rough masculine — gender mismatch)\n"
            "RIGHT behavior:\n"
            "  - GLOSSARY 'X => Y' → copy spelling verbatim, always\n"
            "  - TONE/ATMOSPHERE notes (e.g., 'grim military jargon', 'playful slang') →\n"
            "    apply to all lines; but for [N|speaker=X] lines, REGISTER (particles/pronouns)\n"
            "    follows CHARACTER PROFILE for X, not the tone hint\n"
            "  - if a rule and a character profile disagree on particle/pronoun → CHARACTER wins\n"
            "\n"
            "⚠ GLOSSARY ENTRIES (lines like 'X => Y' / 'X = Y' / 'X → Y'):\n"
            "  Y is the EXACT target spelling. Copy character-for-character whenever X appears.\n"
            "  IGNORE all Japanese phonological rules when applying glossary:\n"
            "    - ん-assimilation (んだ→ง, んば→ม, んが→ง) — DO NOT apply if glossary fixed the spelling\n"
            "    - rendaku (連濁) — DO NOT apply\n"
            "    - vowel devoicing / 'natural' Thai adjustments — DO NOT apply\n"
            "  ตัวอย่าง: glossary 'ぴぴたん => ปิปิตัน'\n"
            "    source 'ぴぴたんだけ' → 'ปิปิตันเท่านั้น' (ไม่ใช่ 'ปิปิตังเท่านั้น')\n"
            "    source 'ぴぴたんは' → 'ปิปิตันก็' (ไม่ใช่ 'ปิปิตัง')\n"
            "    ตัว ん ท้ายชื่อต้องเป็น 'น' เสมอ ตามที่ user กำหนด — ห้ามเปลี่ยน\n"
            "─────────────────────────────────────────────────────────\n"
            + custom_rules.strip() + "\n"
            "─────────────────────────────────────────────────────────\n"
    )


# ป้องกัน LLM แตะ placeholder ที่ _protect_segments สร้าง (X9990X, X9991X, ...)
PROTECTED_TOKENS_RULE = (
        "\n\n═══ PROTECTED TOKENS (CRITICAL — preserve verbatim) ═══\n"
        "Tokens ในรูป X9990X / X9991X / X9992X ... (ตัว X ใหญ่ + 4 หลักเลข + X ใหญ่)\n"
        "เป็น PLACEHOLDER ที่ระบบใส่ไว้แทน URL / HTML tag / email / code / domain.\n"
        "RULES:\n"
        "- ห้าม translate, ห้าม drop, ห้ามใส่ space ระหว่างตัวอักษร\n"
        "- copy verbatim ใน output ตามตำแหน่งเดิม (อาจสลับตำแหน่งตามไวยากรณ์ภาษาเป้าหมายได้ แต่ห้ามเปลี่ยน spelling)\n"
        "- จำนวน + ลำดับ token ใน output ต้องตรงกับ input (ถ้า input มี X9990X, X9991X → output ต้องมีครบทั้งคู่)\n"
        "ตัวอย่าง:\n"
        "  input:  「詳細は X9990X を見て」\n"
        "  output: 'ดูรายละเอียดที่ X9990X'  (ไม่ใช่ 'ดูรายละเอียดที่ X 9990 X' / 'ดูรายละเอียดที่ X9990' / 'ดูรายละเอียด')\n"
)

# intro ของ TM rules_text (tm._format_rules) — ไหลเข้า custom_rules → build_rules_section
TM_RULES_INTRO = (
    "Use these reference translations from the project Translation Memory as guidance. "
    "Preserve terminology, capitalization, and phrasing where the source matches; adapt "
    "wording when context differs. Do not copy a target verbatim if the source is only "
    "loosely related."
)
