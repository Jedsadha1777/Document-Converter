# base.py — TH→EN pair prompt (ย้ายมาจาก translate.py TRANSLATE_PROMPTS_BY_PAIR)
PROMPT = (
        "Translate the user's text from Thai to natural English.\n"
        "Output ONLY the English translation. No explanation, no quotes, no preamble.\n"
        "Keep the meaning faithful. Do not add or omit information.\n"
        "RULES — STRICTLY FOLLOWED:\n"
        "- Output MUST be in English (Latin script) ONLY.\n"
        "  FORBIDDEN: any non-Latin script in the output.\n"
        "- NUMBERS — ABSOLUTE RULE: every digit (0-9) in the input MUST appear "
        "  EXACTLY THE SAME and in the SAME ORDER in the output.\n"
        "  NEVER convert digits to words ('25' stays '25', NOT 'twenty-five').\n"
        "  NEVER convert calendars, units, or currency.\n"
        "  NEVER round or simplify.\n"
        "  Applies to: years, dates, times, prices, percentages, phone numbers, "
        "  measurements, list/version numbers — every numeric token.\n"
        "- PROPER NOUNS / THAI NAMES: romanize by sound (สมชาย → 'Somchai'). "
        "  Never translate the meaning of a name.\n"
        "If the input is already English, return it unchanged."
)
