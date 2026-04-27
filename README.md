# Document Converter

Web UI สำหรับสกัดข้อความจากเอกสาร (PDF, DOCX, PPTX, รูปภาพ, text แนวตั้ง (novel , manga) ) ด้วย [docling](https://github.com/docling-project/docling) — พร้อมโมดูลเสริมสำหรับแก้คำหลัง OCR และแปลภาษา (ไทย/อังกฤษ)

## Features

| ฟีเจอร์ | รายละเอียด |
|---|---|
| **OCR หลายภาษา** | ใช้ Apple Vision (macOS) — ไทย, อังกฤษ, ญี่ปุ่น, เกาหลี |
| **Manga mode** | mokuro pipeline (`comic-text-detector` + `manga-ocr`) สำหรับข้อความญี่ปุ่นแนวตั้ง |
| **Visual Preview** | แสดงภาพหน้าเอกสาร + กล่องครอบที่ OCR detect ได้ overlay บน canvas |
| **JSON output** | กรองตามประเภท (texts/tables/pictures/pages/...) |
| **LLM correction** | แก้ OCR errors ทีละคำด้วย Qwen2.5 (local Ollama) — มี guard เข้มกันโมเดล rewrite ผิด |
| **Translation** | แปลผ่าน Apple Translate (Shortcut CLI) หรือ Qwen — รองรับไทย/อังกฤษ |
| **Manual edit** | คลิกแก้ทั้งช่อง corrected และ translation ได้เอง |
| **Compare table** | เห็น diff ระดับตัวอักษรระหว่าง OCR ↔ corrected พร้อมคำแปล |
| **Google Lens overlay** | ซ้อนคำแปลทับบนภาพต้นฉบับในตำแหน่งเดิม |

## ข้อกำหนด

- **macOS 14.4+** (ต้องการ Apple Vision OCR และ Apple Translate Shortcut)
- **Python 3.12** (3.13 ยังไม่รองรับโดย docling)
- **Homebrew** (สำหรับติดตั้ง Ollama)
- พื้นที่ดิสก์ ~5GB (โมเดล ML)
- RAM ≥ 8GB ขณะรัน

## ขั้นตอนติดตั้ง

### 1. Clone หรือดาวน์โหลดโปรเจกต์

```bash
cd ~/Documents/www
git clone <repo-url> docling
cd docling
```

### 2. สร้าง Python virtual environment

```bash
# ใช้ Python 3.12 (จาก Homebrew)
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv venv
source venv/bin/activate
pip install --upgrade pip
```

### 3. ติดตั้ง dependencies

```bash
pip install -r requirements.txt
```

ครั้งแรกจะใช้เวลานาน (~5-10 นาที) เพราะมีโมเดลและ binary ขนาดใหญ่ (PyTorch, opencv, ฯลฯ)

### 4. ติดตั้ง Ollama + โหลดโมเดล

```bash
brew install ollama
ollama serve &              # รัน daemon
ollama pull qwen2.5:1.5b    # สำหรับ correction และ translation
```

### 5. ตั้งค่า Apple Translate (เลือกได้ — แนะนำสำหรับการแปล)

ถ้าต้องการให้คุณภาพการแปลดีกว่า Qwen — สร้าง Shortcut บน macOS ครั้งเดียว:

1. เปิดแอป **Shortcuts** (Spotlight: Cmd+Space → "Shortcuts")
2. กด **+** สร้าง Shortcut ใหม่
3. ค้นหา action **"Translate Text"** → ลากมาวาง
4. ตั้งค่า:
   - คลิกที่ **"Text"** สีน้ำเงิน → เลือก **`Shortcut Input`** จาก variable picker
   - From: **Detect Language** (หรือกำหนดเองได้)
   - To: **Thai**
5. เพิ่ม action **"Stop and Output"** → ตั้งให้ output เป็น **Translated Text**
6. ตั้งชื่อ Shortcut เป็น **`DoclingTranslateTH`** (ตรงเป๊ะ)
7. (ถ้าต้องการ) ทำซ้ำตั้งชื่อ **`DoclingTranslateEN`** สำหรับแปลเป็นอังกฤษ
8. ดาวน์โหลด language pack: **System Settings → Translation → Languages** เลือก Japanese, Thai, ฯลฯ

ดูคำแนะนำพร้อมรูปได้ที่ http://127.0.0.1:5050/apple-translate-setup เมื่อรันแอปแล้ว

ทดสอบจาก Terminal:
```bash
echo "ブレザーとは" | shortcuts run "DoclingTranslateTH"
# ควรได้: เสื้อเบลเซอร์คืออะไร?
```

### 6. รันแอป

```bash
source venv/bin/activate
python app.py
```

เปิดเบราว์เซอร์ที่ http://127.0.0.1:5050

## วิธีใช้งาน

### แท็บ JSON

1. เลือกไฟล์ → ตั้ง **ประเภท** (`all`, `texts`, `tables`, ...) → ตั้ง **OCR ภาษา**
2. กด **แปลงเป็น JSON**
3. ผลลัพธ์ JSON ปรากฏใน textarea — copy/download ได้

### แท็บ Visual Preview

- แสดงภาพต้นฉบับ + กล่องครอบ:
  - 🔵 texts ・ 🔴 tables ・ 🟢 pictures
  - ✨ = ถูก correction แก้แล้ว
  - 🌐 = มีคำแปลแล้ว
- Hover ที่กล่อง → tooltip แสดง OCR / corrected / translated
- ติ๊ก **📝 ซ้อนคำแปลทับภาพ** → คำแปลจะวาดทับ region (Google Lens style)

### แท็บ Compare (LLM)

- คอลัมน์ 4 ช่อง: `#` | OCR ต้นฉบับ | หลังแก้ด้วย LLM | แปล
- กด **✨ แก้ทั้งหมด** → Qwen ตรวจ OCR errors (ส่ง context ก่อน/หลัง)
- กด **🌐 แปลทั้งหมด** → เลือก engine `🤖 Qwen` หรือ `🍎 Apple Translate`
- คลิกในเซลล์ corrected หรือ translation เพื่อ **แก้เอง** (Enter = บันทึก, Esc = ยกเลิก)
- เซลล์ที่แก้เองจะมี ✏ + พื้นเหลือง

## โครงสร้างโปรเจกต์

```
docling/
├── app.py                          # Flask backend หลัก
├── requirements.txt
├── README.md
├── templates/
│   ├── index.html                  # UI หลัก (Compare/JSON/Visual tabs)
│   └── apple_setup.html            # คำแนะนำตั้งค่า Apple Translate Shortcut
└── venv/                           # Python virtual env (gitignore)
```

## คอนฟิกใน app.py

จุดที่ปรับแต่งได้บ่อย:

| ตัวแปร | บรรทัด | คำอธิบาย |
|---|---|---|
| `OLLAMA_MODEL_CORRECT` | ~24 | โมเดลสำหรับ correction (default: `qwen2.5:1.5b`) |
| `OLLAMA_MODEL_TRANSLATE` | ~25 | โมเดลสำหรับ translation (default: `qwen2.5:1.5b`) |
| `MAX_INSERT_RUN` / `MAX_DELETE_RUN` / `MAX_REPLACE_RUN` | ~250 | guard ความเข้มของ correction |
| `APPLE_SHORTCUT_TH` / `APPLE_SHORTCUT_EN` | ~510 | ชื่อ Shortcut บน macOS |
| `APPLE_MIN_INPUT_CHARS` | ~545 | ข้าม Apple ถ้า input สั้นกว่านี้ |

## Troubleshooting

**ปัญหา:** `Decoded image exceeds size limit`
**แก้:** ปรับ `_docling_core_settings.max_image_decoded_size` ใน app.py (default: 500MB)

**ปัญหา:** OCR ภาษาญี่ปุ่นแนวตั้งจับไม่ได้
**แก้:** เลือก dropdown OCR ภาษา = **📖 Manga (mokuro)** สำหรับมังงะ/หนังสือญี่ปุ่นแนวตั้ง

**ปัญหา:** `shortcuts run` คืน error "language not supported"
**แก้:** input สั้นเกินไป (Apple ต้องการ ≥ 3 chars ถึงจะ detect ภาษาได้) — ระบบ skip ให้อัตโนมัติ

**ปัญหา:** Qwen ไม่ทำตามกฎใน prompt
**แก้:** เป็นข้อจำกัดของโมเดล — แต่จากการทดสอบ `qwen2.5:1.5b` ทำตาม prompt ได้ดีกว่ารุ่นใหญ่ (3B/7B ฝืนกฎรัวกว่า) จึงเลือกใช้ 1.5B เป็นค่า default

## License

โค้ดในโปรเจกต์นี้: ใช้งานได้อิสระ
Dependencies แต่ละตัวมี license ของตัวเอง:
- docling: MIT
- mokuro / manga-ocr: Apache-2.0
- Qwen2.5: Apache-2.0
