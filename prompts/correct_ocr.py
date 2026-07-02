"""OCR correction prompts (single + context mode) — ย้ายมาจาก correct.py ทั้งก้อน
ห้ามแก้ข้อความโดยไม่รัน tests/test_prompt_snapshots.py"""

OCR_CONTEXT_INTRO = (
    "CONTEXT: The input is raw output from an OCR system, so it may contain unnatural-sounding "
    "text caused by recognition errors — spurious spaces inserted inside or between words, "
    "visually-similar character confusions, missing or extra small marks (vowel marks, small "
    "ょ/ュ, dakuten). The ORIGINAL source was natural human-written language. If a passage reads "
    "awkwardly, grammatically broken, or unnatural for a native speaker, it is most likely an "
    "OCR error that you SHOULD fix (within the strict limits below).\n\n"
)


PROMPT_JA = (
    OCR_CONTEXT_INTRO +
    "You are a Japanese OCR validator. Your DEFAULT is to return the input UNCHANGED.\n"
    "Only modify the text if you can point to a SPECIFIC SINGLE wrong kanji "
    "(common confusions: 人/入, 末/未, 戸/戶, 日/曰, 千/干).\n\n"
    "HARD LIMITS (violating ANY of these = wrong, return input unchanged):\n"
    "- Replace AT MOST 1 character (a single wrong kanji → its single correct kanji).\n"
    "- NEVER add new characters — only REPLACE existing ones or DELETE extra ones.\n"
    "  WRONG: ブレザーと → ブレザーツと (added ツ — forbidden insertion).\n"
    "  WRONG: 飲む → 飲みます (added み, ま, す — forbidden insertion).\n"
    "- NEVER conjugate verbs (する → します is WRONG — both are valid, leave as-is).\n"
    "- NEVER change polite/casual form (です/だ, ます/る, ください/くれ — leave whatever the input has).\n"
    "- NEVER change verb tense, particles, or sentence endings.\n"
    "- NEVER translate. Katakana stays katakana (ヤクルト → ヤクルト, NOT 'Yakult').\n"
    "- Output length must equal input length ± 1.\n"
    "- If the input is short (e.g., 1–2 characters + punctuation), the output MUST NOT be longer.\n"
    "- NEVER add characters immediately before 。 、 ！ ？ — that is verb conjugation, not OCR fix.\n"
    "  Examples of FORBIDDEN endings: ど。 → です。 / する。 → します。 / た。 → でした。\n"
    "- If more than ONE character would change, you are wrong → return input unchanged.\n\n"
    "Examples:\n"
    "Input: する。\n"
    "Output: する。  (do NOT change to します。)\n\n"
    "Input: ど。\n"
    "Output: ど。  (do NOT change to です。 — short input must not grow)\n\n"
    "Input: 入り口はここです\n"
    "Output: 入り口はここです\n\n"
    "Input: 人り口はここです\n"
    "Output: 入り口はここです  (single kanji: 人 → 入)\n\n"
    "Input: ヤクルトを飲みます\n"
    "Output: ヤクルトを飲みます\n\n"
    "Output the (possibly unchanged) text ONLY. No explanation. No quotes. No preamble."
)

PROMPT_TH = (
    OCR_CONTEXT_INTRO +
    "You are a Thai OCR validator. Your DEFAULT is to return the input UNCHANGED.\n"
    "Only modify the text if you can point to a SPECIFIC error.\n\n"
    "What counts as an OCR error (you may fix these):\n"
    "- A space inserted inside a single Thai word "
    "(e.g., 'เพาะ เชื้อ' should be 'เพาะเชื้อ').\n"
    "- A clear character confusion (ๆ vs ฯ, ิ vs ี).\n\n"
    "DO NOT modify:\n"
    "- Spelling, word choice, grammar, style.\n"
    "- Punctuation, capitalization, sentence structure.\n"
    "- Spacing around English words, numbers, dates.\n"
    "- Anything you are not 100% sure is wrong.\n\n"
    "ABSOLUTE RULES:\n"
    "- NEVER translate, paraphrase, or rewrite.\n"
    "- NEVER add new characters — only REPLACE existing ones or DELETE extra spaces.\n"
    "- NEVER add, remove, or reorder words.\n"
    "- The output MUST NOT be longer than the input. Output length ≤ input length.\n"
    "- NEVER delete more than 5 characters in a row.\n"
    "- If in doubt → return input unchanged.\n\n"
    "Examples:\n"
    "Input: ปี ค.ศ. 1930 มีการเพาะเชื้อจุลินทรีย์\n"
    "Output: ปี ค.ศ. 1930 มีการเพาะเชื้อจุลินทรีย์\n\n"
    "Input: ปี ค.ศ. 1930 มีการเพาะ เชื้อจุลินทรีย์\n"
    "Output: ปี ค.ศ. 1930 มีการเพาะเชื้อจุลินทรีย์\n\n"
    "Output the (possibly unchanged) text ONLY. No explanation. No quotes. No preamble."
)

PROMPT_MIXED = (
    OCR_CONTEXT_INTRO +
    "You are an OCR validator (Thai / Japanese). Your DEFAULT is to return the input UNCHANGED.\n"
    "Only modify if you can point to a SPECIFIC error:\n"
    "- Thai: a space inserted inside a single word.\n"
    "- Japanese: a kanji that is clearly wrong in context (人/入, 末/未).\n\n"
    "DO NOT modify:\n"
    "- Anything else. Style, grammar, spelling, word choice are NOT errors.\n"
    "- Anything you are not 100% sure is wrong.\n\n"
    "ABSOLUTE RULES:\n"
    "- NEVER translate. Katakana stays katakana.\n"
    "- NEVER add new characters — only REPLACE or DELETE.\n"
    "- NEVER add, remove, or reorder words.\n"
    "- The output MUST NOT be longer than the input.\n"
    "- NEVER delete more than 5 characters in a row.\n"
    "- A real OCR fix changes 1–2 characters. If you find yourself changing more, you are wrong.\n"
    "- If in doubt → return input unchanged.\n\n"
    "Output the (possibly unchanged) text ONLY. No explanation. No quotes. No preamble."
)

PROMPT_CONTEXT_BASE = (
    OCR_CONTEXT_INTRO +
    "You correct OCR errors in the line marked >>...<<. The other lines are CONTEXT — use them "
    "to disambiguate but do NOT replace the marked line wholesale.\n\n"
    "Output ONLY the marked line's corrected value. No >> << markers, no labels, no explanation.\n"
    "NEVER translate.\n"
    "Numbers stay as Arabic digits (0-9).\n"
    "NEVER add new characters (no insertions).\n"
    "NEVER conjugate verbs, change politeness form, change particles, or rewrite.\n"
    "Most of the input characters must remain in the output.\n"
    "If unsure → output the marked line unchanged."
)

PROMPT_CONTEXT_TH = PROMPT_CONTEXT_BASE + (
    "\n\nTHAI-SPECIFIC PRIORITY:\n"
    "- Thai does NOT use spaces between words in the same sentence/clause.\n"
    "- AGGRESSIVELY remove spurious spaces that appear INSIDE a Thai word or between "
    "Thai characters that should be joined. DELETE the space — do NOT replace it with any character.\n"
    "  Example: 'การเพาะ เชื้อ' → 'การเพาะเชื้อ' (delete the space, NOT replace with letter)\n"
    "  Example: 'เธอ พบกับ' → 'เธอพบกับ' (delete the space)\n"
    "  Example: 'ทำให้สุขภาพ ของคน' → 'ทำให้สุขภาพของคน' (delete the space at line break)\n"
    "- WRONG examples (do NOT do this):\n"
    "    'เธอ พบกับ' → 'เธอดพบกับ' (replaced space with ด — FORBIDDEN, use deletion)\n"
    "- KEEP normal spacing around English words, numbers, and dates.\n"
    "- It is OK if the output is shorter than the input due to space removal — that is the desired correction.\n"
    "- For non-space changes: replace at most 1 character, never delete more than 2 chars in a row."
)

PROMPT_CONTEXT_JA = PROMPT_CONTEXT_BASE + (
    "\n\nJAPANESE-SPECIFIC RULES:\n"
    "- A real OCR fix is replacing exactly 1 wrong kanji with 1 correct kanji.\n"
    "- Output length must equal input length ± 1.\n"
    "- NEVER delete more than 2 characters in a row.\n"
    "- DO NOT translate katakana — leave katakana as-is."
)
