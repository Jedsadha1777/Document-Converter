"""env vars + constants ใช้ร่วมระหว่าง modules"""
import os

from dotenv import load_dotenv
load_dotenv()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL_CORRECT = os.getenv("OLLAMA_MODEL_CORRECT", "qwen2.5:1.5b")
OLLAMA_MODEL_TRANSLATE = os.getenv("OLLAMA_MODEL_TRANSLATE", "qwen2.5:1.5b")
OLLAMA_MODEL_EMBED = os.getenv("OLLAMA_MODEL_EMBED", "nomic-embed-text")

TM_DIR = os.getenv("TM_DIR", "data_tm")
TM_TOP_K_PER_QUERY = int(os.getenv("TM_TOP_K_PER_QUERY", "30"))
TM_FINAL_K = int(os.getenv("TM_FINAL_K", "20"))
TM_BONUS_ALPHA = float(os.getenv("TM_BONUS_ALPHA", "0.1"))
TM_EMBED_BATCH_SIZE = int(os.getenv("TM_EMBED_BATCH_SIZE", "32"))
TM_EMBED_TIMEOUT = float(os.getenv("TM_EMBED_TIMEOUT", "120"))

TRANSLATE_BATCH_SIZE_DEFAULT = int(os.getenv("TRANSLATE_BATCH_SIZE", "5"))
TRANSLATE_BATCH_TIMEOUT = float(os.getenv("TRANSLATE_BATCH_TIMEOUT", "120"))
TRANSLATE_BATCH_NUM_CTX = int(os.getenv("TRANSLATE_BATCH_NUM_CTX", "8192"))

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
GEMINI_TIMEOUT = float(os.getenv("GEMINI_TIMEOUT", "120"))
GEMINI_BATCH_DELAY_MS = int(os.getenv("GEMINI_BATCH_DELAY_MS", "12000"))
GEMINI_AVAILABLE = bool(GEMINI_API_KEY)

# sentinel — ผู้ใช้เลือก dropdown "ไม่แปล"
SPEAKER_SKIP = "__skip__"

# EasyOCR ใช้ 2-letter, ocrmac ใช้ BCP-47
LANG_PRESETS = {
    "auto":  ["th", "en"],
    "en":    ["en"],
    "th_en": ["th", "en"],
    "ja_en": ["ja", "en"],
}
OCRMAC_LANG_PRESETS = {
    "auto":  ["en-US", "th-TH", "ja-JP"],
    "en":    ["en-US"],
    "th_en": ["th-TH", "en-US"],
    "ja_en": ["ja-JP", "en-US"],
}

OCR_ENGINES = ("easyocr", "ocrmac")
ELEMENT_KEYS = ["texts", "tables", "pictures", "groups", "pages", "key_value_items", "form_items"]

APPLE_SHORTCUT_TH = "DoclingTranslateTH"
APPLE_SHORTCUT_EN = "DoclingTranslateEN"
APPLE_SHORTCUT_JA = "DoclingTranslateJA"
APPLE_SHORTCUT_VI = "DoclingTranslateVI"
APPLE_MIN_INPUT_CHARS = 3  # < threshold นี้ Apple จับภาษาไม่ได้
