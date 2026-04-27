# Document Converter

Web UI สำหรับสกัดข้อความจากเอกสาร (PDF, DOCX, PPTX, รูปภาพ, text แนวตั้ง novel/manga) ด้วย [docling](https://github.com/docling-project/docling) — พร้อมโมดูลเสริมสำหรับแก้คำหลัง OCR และแปลภาษา (ไทย/อังกฤษ) ด้วย LLM แบบ batch + persona-aware

## Features

| ฟีเจอร์ | รายละเอียด |
|---|---|
| **OCR หลายภาษา** | Apple Vision (macOS) / EasyOCR (cross-platform) — ไทย, อังกฤษ, ญี่ปุ่น, จีน, เกาหลี ฯลฯ |
| **⚡ Fast mode** | ข้าม docling layout/table — ใช้ Apple Vision ตรง ๆ + clustering กล่องใกล้เคียง (เร็ว ~10×) |
| **📖 Manga mode** | mokuro pipeline (`comic-text-detector` + `manga-ocr`) สำหรับข้อความญี่ปุ่นแนวตั้ง |
| **Visual Preview** | ภาพหน้าเอกสาร + กล่องครอบที่ OCR detect ได้ overlay บน canvas |
| **JSON output** | กรองตามประเภท (texts/tables/pictures/pages/...) |
| **LLM correction** | แก้ OCR errors แบบ batch — Qwen (local Ollama) / Gemini — มี guard เข้มกัน rewrite ผิด |
| **Translation (Batch)** | แปลผ่าน Apple Translate / Qwen / **Gemini 2.5 Flash** — รองรับไทย/อังกฤษ |
| **👥 Character / Persona** | ตั้งบุคคลิก (gender + personality) ของแต่ละตัวละคร เก็บใน LocalStorage — เลือก speaker ต่อแถวให้ LLM แปลตาม voice |
| **🚫 ไม่แปล** | dropdown ต่อแถวให้ข้ามการแปล (ประหยัด token) |
| **🔍 Preview prompt** | ดู raw JSON request body ที่ส่งให้ LLM ก่อนเรียกจริง (transparency) |
| **Manual edit** | คลิกแก้ทั้งช่อง corrected และ translation ได้เอง |
| **Compare table** | diff ระดับตัวอักษร OCR ↔ corrected พร้อมคำแปล + speaker dropdown |
| **Google Lens overlay** | ซ้อนคำแปลทับบนภาพต้นฉบับในตำแหน่งเดิม |

## ข้อกำหนด

- **macOS 14.4+** (ต้องการ Apple Vision OCR และ Apple Translate Shortcut)
  - ใช้บน Linux/Windows ได้ แต่ต้องใช้ EasyOCR แทน Apple Vision และ Apple Translate ใช้ไม่ได้
- **Python 3.12** (3.13 ยังไม่รองรับโดย docling)
- **Homebrew** (สำหรับติดตั้ง Ollama)
- พื้นที่ดิสก์ ~5GB (โมเดล ML)
- RAM ≥ 8GB ขณะรัน
- (ทางเลือก) **Gemini API key** — ฟรี tier `gemini-2.5-flash` รองรับ batch translation/correction

## ขั้นตอนติดตั้ง

### 1. Clone หรือดาวน์โหลดโปรเจกต์

```bash
cd ~/Documents/www
git clone <repo-url> docling
cd docling
```

### 2. สร้าง Python virtual environment

```bash
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv venv
source venv/bin/activate
pip install --upgrade pip
```

### 3. ติดตั้ง dependencies

```bash
pip install -r requirements.txt
```

ครั้งแรกจะใช้เวลา ~5-10 นาที เพราะมีโมเดลและ binary ขนาดใหญ่ (PyTorch, opencv, ฯลฯ)

### 4. ติดตั้ง Ollama + โหลดโมเดล (สำหรับ correction + translation แบบ local)

```bash
brew install ollama
ollama serve &              # รัน daemon
ollama pull qwen2.5:1.5b    # default model สำหรับ correction และ translation
```

### 5. (ทางเลือก) ตั้งค่า Apple Translate Shortcut

ถ้าต้องการใช้ Apple Translate แทน Qwen — สร้าง Shortcut บน macOS:

1. เปิดแอป **Shortcuts** (Spotlight: Cmd+Space → "Shortcuts")
2. กด **+** สร้าง Shortcut ใหม่
3. ค้นหา action **"Translate Text"** → ลากมาวาง
4. ตั้งค่า:
   - คลิก **"Text"** สีน้ำเงิน → เลือก **`Shortcut Input`** จาก variable picker
   - From: **Detect Language**
   - To: **Thai**
5. เพิ่ม action **"Stop and Output"** → output = **Translated Text**
6. ตั้งชื่อ: **`DoclingTranslateTH`** (ตรงเป๊ะ)
7. (ทางเลือก) ทำซ้ำชื่อ **`DoclingTranslateEN`** สำหรับแปลเป็นอังกฤษ
8. ดาวน์โหลด language pack: **System Settings → Translation → Languages**

ดูคำแนะนำพร้อมรูปได้ที่ http://127.0.0.1:5050/apple-translate-setup เมื่อรันแอปแล้ว

ทดสอบ:
```bash
echo "ブレザーとは" | shortcuts run "DoclingTranslateTH"
# ควรได้: เสื้อเบลเซอร์คืออะไร?
```

### 6. (ทางเลือก) ตั้งค่า Gemini API

สร้างไฟล์ `.env` ที่ root ของโปรเจกต์:

```bash
cat > .env <<'EOF'
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-2.5-flash
GEMINI_TIMEOUT=120
GEMINI_BATCH_DELAY_MS=12000
HF_HUB_DISABLE_XET=1
EOF
```

ขอ API key ฟรีได้ที่ [https://aistudio.google.com/](https://aistudio.google.com/) (ฟรี tier ~15 RPM, 250K TPM, 250 RPD สำหรับ flash)

### 7. รันแอป

```bash
source venv/bin/activate
python app.py
# หรือถ้าตั้ง .env แล้ว: variable จะ auto-load
```

เปิดเบราว์เซอร์ที่ http://127.0.0.1:5050

## วิธีใช้งาน

### แท็บ JSON

1. เลือกไฟล์ → ตั้ง **ประเภท** (`all`, `texts`, ...) → ตั้ง **OCR ภาษา**
2. (ทางเลือก) ติ๊ก **⚡ Fast** ถ้าต้องการเร็ว ๆ ข้าม layout detection
3. กด **แปลงเป็น JSON**

### แท็บ Visual Preview

- ภาพต้นฉบับ + กล่องครอบ:
  - 🔵 texts ・ 🔴 tables ・ 🟢 pictures
  - ✨ = ถูก correction แก้แล้ว ・ 🌐 = มีคำแปลแล้ว
- Hover ที่กล่อง → tooltip แสดง OCR / corrected / translated
- ติ๊ก **📝 ซ้อนคำแปลทับภาพ** → คำแปลวาดทับ region (Google Lens style)

### แท็บ Compare (LLM)

**คอลัมน์:** `#` | ผู้พูด | OCR ต้นฉบับ | หลังแก้ด้วย LLM | แปล

**เครื่องมือ:**
- **✨ แก้ทั้งหมด** — Qwen/Gemini ตรวจ OCR errors แบบ batch (พร้อม guard เข้ม)
- **🌐 แปลทั้งหมด** — เลือก engine `Qwen` / `Apple` / `Gemini`
- **👥 ตัวละคร** — ตั้งค่าตัวละคร (เปิด modal):
  - เพิ่ม/ลบตัวละคร, ตั้ง name / gender / personality
  - ตัวละครแรก = default สำหรับชิ้นที่ยังไม่ระบุ
  - บันทึกใน LocalStorage (ไม่หายแม้อัพไฟล์ใหม่)
- **🔍 Preview prompt** — ดู raw JSON ที่จะส่งให้ LLM (transparency, ไม่เรียก API)
- **↻ retry fail** — แปลซ้ำเฉพาะแถวที่ fail

**Speaker dropdown** ในแต่ละแถว:
- `🚫 ไม่แปล` — ข้ามแถวนี้ ไม่ส่ง LLM
- `1 — A, female`, `2 — B, male`, ... — เลือก persona
- เปลี่ยนเฉย ๆ ไม่ trigger LLM call จนกว่ากดปุ่มแปล

**Manual edit** — คลิกในเซลล์ corrected หรือ translation:
- พิมพ์แก้ → Enter บันทึก / Esc ยกเลิก
- เซลล์ที่แก้เองมี ✏ + พื้นเหลือง

## โครงสร้างโปรเจกต์

```
docling/
├── app.py                          # Flask backend หลัก
├── requirements.txt
├── README.md
├── .env                            # GEMINI_API_KEY และ env vars (gitignored)
├── .gitignore
├── templates/
│   ├── index.html                  # UI หลัก (Compare/JSON/Visual tabs)
│   └── apple_setup.html            # คำแนะนำตั้งค่า Apple Translate Shortcut
└── venv/                           # Python virtual env (gitignored)
```

## ตัวแปรในตั้งใน `.env` (ทั้งหมด optional)

| ตัวแปร | default | คำอธิบาย |
|---|---|---|
| `GEMINI_API_KEY` | (ไม่ตั้ง) | API key ของ Google Gemini — ถ้าไม่ตั้ง option Gemini จะ disabled |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model ที่ใช้ |
| `GEMINI_TIMEOUT` | `120` | timeout (วินาที) ต่อ Gemini call |
| `GEMINI_BATCH_DELAY_MS` | `12000` | delay (ms) ระหว่าง Gemini batch — กัน rate limit free tier |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama daemon URL |
| `TRANSLATE_BATCH_TIMEOUT` | `120` | timeout (วินาที) ของ Qwen batch |
| `TRANSLATE_BATCH_NUM_CTX` | `8192` | context window size ของ Qwen |
| `HF_HUB_DISABLE_XET` | (ไม่ตั้ง) | ตั้ง `1` เพื่อปิด HF Xet protocol (ถ้า download HuggingFace ค้าง) |

## คอนฟิกใน app.py

| ตัวแปร | ค่า default | คำอธิบาย |
|---|---|---|
| `OLLAMA_MODEL_CORRECT` | `qwen2.5:1.5b` | โมเดลสำหรับ correction |
| `OLLAMA_MODEL_TRANSLATE` | `qwen2.5:1.5b` | โมเดลสำหรับ translation |
| `MAX_INSERT_RUN` / `MAX_DELETE_RUN` / `MAX_REPLACE_RUN` | 0 / 2 / 1 | guard ความเข้มของ correction (per-op) |
| `APPLE_SHORTCUT_TH` / `APPLE_SHORTCUT_EN` | `DoclingTranslateTH` / `DoclingTranslateEN` | ชื่อ Apple Shortcut |
| `APPLE_MIN_INPUT_CHARS` | `3` | ข้าม Apple ถ้า input สั้นกว่านี้ |
| `SPEAKER_SKIP` | `__skip__` | sentinel ของ "🚫 ไม่แปล" dropdown |

## API Endpoints

| Method | Path | Use |
|---|---|---|
| `POST` | `/convert` | OCR + extract document → JSON |
| `POST` | `/correct` | Single text correction (legacy) |
| `POST` | `/correct-batch` | Batch correction — Qwen / Gemini |
| `POST` | `/translate` | Single text translation (legacy) |
| `POST` | `/translate-batch` | Batch translation — Qwen / Gemini / Apple |
| `POST` | `/translate-batch/preview` | ดู prompt ที่จะส่ง LLM (ไม่เรียก API) |
| `GET` | `/apple-translate-status` | ตรวจ Apple Shortcut พร้อมหรือยัง |
| `GET` | `/apple-translate-setup` | หน้าคำแนะนำสร้าง Shortcut |

## Troubleshooting

**ปัญหา:** `Decoded image exceeds size limit`
**แก้:** ปรับ `_docling_core_settings.max_image_decoded_size` ใน app.py (default: 500MB)

**ปัญหา:** OCR ภาษาญี่ปุ่นแนวตั้งจับไม่ได้
**แก้:** เลือก dropdown OCR ภาษา = **📖 Manga (mokuro)**

**ปัญหา:** `shortcuts run` คืน error "language not supported"
**แก้:** input สั้นเกิน 3 chars — ระบบ skip ให้อัตโนมัติ

**ปัญหา:** HuggingFace download ค้างที่ 0 bytes (Xet protocol)
**แก้:** เพิ่ม `HF_HUB_DISABLE_XET=1` ใน `.env` หรือรันด้วย:
```bash
HF_HUB_DISABLE_XET=1 python app.py
```

**ปัญหา:** Gemini ขึ้น `503 UNAVAILABLE` หรือ `429 RESOURCE_EXHAUSTED`
**แก้:**
- 503 = server overload, รอครู่แล้ว retry
- 429 = quota เต็ม free tier, รอตามเวลาที่ Gemini บอก (`retryDelay`)
- เพิ่ม `GEMINI_BATCH_DELAY_MS` ใน `.env` ให้สูงขึ้น (เช่น 20000) กัน rate-limit
- เปลี่ยนใช้ Qwen เป็น fallback

**ปัญหา:** Qwen ไม่ทำตามกฎใน prompt
**แก้:** ตอนนี้ใช้ `qwen2.5:1.5b` ซึ่งทำตาม prompt ดีกว่ารุ่นใหญ่ (3B/7B ฝืนกฎรัวกว่า) — ถ้ายังไม่พอ เปลี่ยนเป็น Gemini

**ปัญหา:** คำแปลถูก duplicate ข้ามแถว / hallucinate กับ punctuation-only input
**แก้:** เลือก dropdown ผู้พูด = `🚫 ไม่แปล` ใน Compare table สำหรับแถวที่ไม่ต้องการแปล

## License

โค้ดในโปรเจกต์นี้: ใช้งานได้อิสระ
Dependencies แต่ละตัวมี license ของตัวเอง:
- docling: MIT
- mokuro / manga-ocr: Apache-2.0
- Qwen2.5: Apache-2.0
- google-genai: Apache-2.0
