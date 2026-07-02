"""Content-type overlay (generic) — ใช้เมื่อคู่ภาษาไม่มีไฟล์ overlay เฉพาะ
(pair-specific อยู่ prompts/{jp_th,en_vn}/ — dispatch ใน translate._resolve_style_block)
ย้ายมาจาก translate.py — ห้ามแก้ข้อความโดยไม่รัน tests/test_prompt_snapshots.py"""

MANGA_NOVEL = (
        "\n\n═══ CONTENT TYPE: MANGA / NOVEL (dialogue + narration mixed) ═══\n"
        "- Conversational register — character voice follows the speaker's profile (gender/age/persona)\n"
        "- Use sentence-final particles/register that are natural to the TARGET language only.\n"
        "  ⚠ Do NOT import Thai particles (ค่ะ/ครับ/นะ/จ้ะ) or Japanese honorifics (san/chan/kun)\n"
        "  into the output — every register cue must belong to the target language.\n"
        "- Preserve manga prosody: exclamations, sentence fragments, expressive phrasing —\n"
        "  do NOT formalize the text into prose.\n"
)


TUTORIAL = (
        "\n\n═══ CONTENT TYPE: TUTORIAL (instructional / how-to / manual) ═══\n"
        "- Imperative voice — direct commands in the target language ('Click', 'Select', 'Save').\n"
        "- NO casual/chat particles or softeners — formal manual register only.\n"
        "- Keep technical terms, brand and product names per the GLOSSARY; do not invent translations.\n"
        "- UI STRINGS (button/menu/label names, often quoted):\n"
        "  if listed in GLOSSARY → copy the GLOSSARY spelling verbatim\n"
        "  if the real UI is in English → keep English in quotes: the \"Save\" button\n"
        "  otherwise → translate into the target language\n"
        "- Keep step numbering exactly as the source — never merge or reorder steps.\n"
)


PRODUCT_CATALOG = (
        "\n\n═══ CONTENT TYPE: PRODUCT CATALOG (e-commerce / spec sheet) ═══\n"
        "- Concise noun-phrase style — no chat particles, no conversational fillers.\n"
        "- Keep brand names, model numbers, SKUs, and units EXACTLY as in the source.\n"
        "- Specs/dimensions: copy every number and unit verbatim.\n"
        "- Marketing copy: translate persuasively but factually — do not add claims.\n"
        "- Keep technical terms per the GLOSSARY.\n"
)
