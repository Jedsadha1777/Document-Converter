# Pattern Memory (PM) — Auto-merge boxes by recurring region signature

> Design doc — ยังไม่ implement. เก็บไว้สำหรับ feature ในอนาคต.

## ปัญหา

OCR pipeline ปัจจุบัน ([pipelines.py:479](../pipelines.py#L479) `_merge_nearby_boxes`) merge กล่อง OCR ที่อยู่ใกล้กันด้วยเกณฑ์ geometric อย่างเดียว:
- vertical gap < 0.7 × median line height
- horizontal overlap > 30% ของกล่องที่แคบกว่า

ไม่ครอบคลุมเคสที่กล่อง 2 อันควรเป็นหน่วยเดียว แต่ห่างกว่า threshold เช่น:

```
┌──────────┐
│ Discount │   ← font เล็ก
└──────────┘
   (gap)
┌──────────┐
│   50%    │   ← font ใหญ่กว่ามาก, อาจห่างเกินเกณฑ์
└──────────┘
```

User ต้องการให้ระบบ "จำ" pattern นี้ → กดปุ่มแล้ว merge อัตโนมัติทุกหน้า

## แนวทางที่เลือก: Region signature + Domain (เหมือน TM)

หลังพิจารณา 3 แนวทาง:

1. ~~Regex บน text~~ — เปราะ (case, ภาษา, รูปแบบ)
2. ~~Embedding vector (text)~~ — ต้อง Ollama, มองไม่เห็น visual cues (สี, layout), debug ยาก
3. ✅ **Region signature** — features เชิงเรขาคณิตของ "พื้นที่ merged" — interpretable, ไม่ต้องเทรน, ไม่ต้อง dependency

Insight สำคัญ: **ป้ายราคา / promo box / form fields มี layout ที่ซ้ำในเอกสารเดียวกัน** — แทนที่จะวิเคราะห์ feature ของกล่องแต่ละคู่ ให้ดู "พื้นที่ merged (union bbox)" ว่ามี signature อะไรซ้ำๆ บนหน้า

## โครงสร้าง storage (ขนานกับ TM)

```
data_pm/
  ecommerce/      # ป้ายราคา, badge promo
    patterns.json
  infographic/    # big number + caption
    patterns.json
  form/           # label + value
    patterns.json
  manga/          # SFX text
    patterns.json
  general/
    patterns.json
```

User เลือก domain ก่อนกด apply (หรือ multi-select) — แบบเดียวกับเลือก language pair ของ TM

## Pattern schema

```json
{
  "name": "price-tag-vertical",
  "examples": [
    {
      "aspect_ratio": 1.4,
      "split_pos": 0.38,
      "split_axis": "horizontal",
      "size_ratio_internal": 1.7,
      "fill_ratio": 0.85,
      "rel_size_page": 0.04
    },
    { "...": "more examples added by user" }
  ],
  "threshold": 0.15,
  "hit_count": 0,
  "created_at": "2026-05-25T..."
}
```

### Feature fields (6 มิติ, ทุกอย่าง normalized)

| field | คำนวณ | คุมเรื่อง |
|---|---|---|
| `aspect_ratio` | (x_max − x_min) / (y_max − y_min) | รูปร่างพื้นที่ merged |
| `split_pos` | ตำแหน่งเส้นแบ่ง (% จากบน หรือ ซ้าย) | label อยู่ส่วนไหนของ region |
| `split_axis` | `horizontal` \| `vertical` | กล่องเรียงบน-ล่าง หรือ ซ้าย-ขวา |
| `size_ratio_internal` | h_bot/h_top หรือ w_right/w_left | สัดส่วน label vs value |
| `fill_ratio` | (area_top + area_bot) / area_merged | กันเคสกล่อง 2 อันห่างมีที่ว่างเยอะ (false positive) |
| `rel_size_page` | area_merged / area_page | กัน match ข้าม scale (badge เล็ก vs section ใหญ่) |

ไม่ต้องดึงสี ไม่ต้อง read image — feature ทั้งหมดคำนวณจาก bbox อย่างเดียว เร็วและไม่ต้อง pre-processing

## Algorithm 2 phase

### Phase 1 — Discovery (auto-find pattern จากเอกสารปัจจุบัน)

```
1. หา candidate pairs ทั้งหมด — gap < 5× median line height + horizontal/vertical alignment ผ่านเกณฑ์หลวม
2. คำนวณ region signature ของทุกคู่ → ได้ vector 6 มิติ N ตัว
3. cluster ด้วย DBSCAN (eps ~0.15) หรือ greedy nearest
4. cluster ที่มีสมาชิก ≥ 3 = "pattern ที่ซ้ำในเอกสารนี้"
5. highlight แต่ละ cluster ด้วยสีต่างกันบน preview
6. user คลิก cluster → "Merge ทั้งหมด + save เป็น pattern ใน domain X"
```

ข้อดี: **ไม่ต้องเริ่มจาก library ว่าง** — เปิดเอกสารป้ายราคา 12 ใบ ระบบ cluster เจอ 12 region คล้ายกันแล้วเสนอ merge ทันที

### Phase 2 — Apply (cross-doc จาก library)

```
1. user เลือก domain (หรือ multi-domain)
2. หา candidate pairs ในหน้าใหม่
3. คำนวณ signature → หา nearest pattern (Euclidean distance ใน 6D)
4. distance < pattern.threshold → merge
5. update hit_count
```

## Flow user-facing

หลัง OCR เสร็จ:

```
[ Apply TM ]  [ Apply Patterns ▼ ]  [ Discover Patterns ]  [ Translate ]
                      │
                      ├── ecommerce  ☑
                      ├── infographic  ☐
                      └── form  ☐
```

- **Apply Patterns** → match patterns จาก domain ที่ติ๊ก → preview match ก่อน confirm
- **Discover Patterns** → run phase 1 บนหน้าปัจจุบัน → แสดง cluster สีๆ → คลิก cluster ที่ใช่ → save + merge
- **Undo merge** → snapshot ก่อน merge (กดได้ครั้งล่าสุด)
- Toggle "Auto-apply after OCR" สำหรับคนที่มั่นใจแล้ว

## ทำไมง่ายกว่าทางเลือกอื่น

| | Embedding (text) | Per-pair features 20 มิติ | Region signature 6 มิติ |
|---|---|---|---|
| Dependency | Ollama | image (สำหรับสี) | ไม่มี — bbox อย่างเดียว |
| Cold start | 3-5 examples + threshold สูง | 1 example | Discovery หา pattern ได้เอง |
| Debuggable | "ทำไม sim 0.7?" ตอบไม่ได้ | per-feature ตอบได้ | 6 ตัวเลข อ่านออก |
| False positive | กลาง (text แท้แต่คนละบริบท) | สูง (weight ปรับไม่ดี) | ต่ำ (มีหลักฐานว่า pattern ซ้ำจริง) |
| Speed | embed call ทุกกล่อง | คำนวณสี + crop | pure math |
| Pattern เกิดเอง | ไม่ได้ | ไม่ได้ | ได้ (Phase 1) |

## จุดที่ต้องระวัง / open questions

1. **DBSCAN eps**: ต้อง slider "ความเข้มงวด" ใน UI เพราะแต่ละเอกสารต่างกัน — default 0.15 เริ่มต้น
2. **Candidate pair threshold**: เกณฑ์ geometric เริ่มต้นต้องกว้าง (gap < 5× line height) — ปล่อย signature distance ตัดสินใจสุดท้าย
3. **3+ box patterns** ("Limited / Time / Offer"): phase 1 ทำคู่ก่อน, ถ้า merged region 2 ก้อนเข้า cluster เดียวกันและซ้อนกัน → merge แบบ transitive
4. **Multi-domain conflict**: pattern จาก 2 domain match คู่เดียวกัน → เลือก distance ต่ำกว่า + log
5. **Page size variance**: `rel_size_page` normalize แล้ว, aspect_ratio + split_pos invariant อยู่แล้ว — น่าจะพอ
6. **Translate sync**: merge ที่ frontend ต้อง update `result` object ที่ส่งไป `/translate` ด้วย — จุด integration เดียวกับ manual edit
7. **Apply ที่ frontend หรือ backend?** — frontend (เร็ว, debug ง่าย, pattern signature คำนวณใน JS ได้) — backend แค่ CRUD patterns

## จุด integrate ใน codebase

- **Backend**: 
  - `pattern_memory.py` ใหม่ — CRUD + load patterns
  - `app.py` — endpoints `/api/patterns/{domain}` (GET/POST/PUT/DELETE), `/api/patterns/domains`
  - ไม่แตะ `pipelines.py` — merge ทำที่ frontend
- **Frontend**:
  - `static/js/pattern-memory.js` ใหม่ — signature calc + matching + clustering (DBSCAN เล็กๆ)
  - `static/js/preview.js` — hook hl/merge boxes
  - `templates/index.html` — UI panel + buttons
- **Storage**: `data_pm/{domain}/patterns.json` (single file ต่อ domain, จำนวน pattern น้อย)

## ไม่ทำในเวอร์ชันแรก

- ไม่ทำ embedding-based matching (text/visual)
- ไม่ทำ color feature (เพิ่มทีหลังได้เป็น optional field)
- ไม่ทำ pattern แบบ 3+ box โดยตรง (รอ cascade ของคู่)
- ไม่ทำ auto-detect domain จาก document type
