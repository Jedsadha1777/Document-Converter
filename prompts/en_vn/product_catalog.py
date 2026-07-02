# product_catalog.py — v2
# CHANGELOG จาก v1:
# - Scope FORBIDDEN particles ให้เป็น "sentence-final tone particle" เท่านั้น
#   (ปลดล็อก vì vậy / do đó / demonstrative đó / luôn luôn ที่เป็น formal prose ปกติ)
# - เพิ่ม STARTER GLOSSARY ศัพท์ catalog มาตรฐาน (client GLOSSARY override ได้)
# - เพิ่ม HEADINGS rule: ห้าม Title Case แบบอังกฤษ + ALL-CAPS ต้องคง diacritics
# - เพิ่ม technical symbols + แก้ collocation 'liên hệ với chúng tôi'
# - เพิ่มตัวเลือก 'bạn' สำหรับ B2C tone (เฉพาะเมื่อ client กำหนด)

PROMPT = """

═══ CONTENT TYPE: PRODUCT CATALOG (e-commerce / spec sheet / factory manual) ═══
Target: Vietnamese. Register: professional, formal, technical — like a product
catalog, factory manual, or datasheet. Never default to manga / chat / dialogue style.
- NO conversational SENTENCE-FINAL particles in declarative catalog/spec text.
  FORBIDDEN as sentence-final tone particles: ạ / nhé / nha / đấy / đó / nhỉ / hả /
  vậy / luôn.
  ⚠ SCOPE — banned ONLY as chat-tone particles closing a clause. These remain
  ALLOWED as normal content words, which formal prose needs:
    'vì vậy' / 'như vậy' (therefore), 'do đó' (thus), demonstrative 'sản phẩm đó',
    'luôn luôn' (always), 'ngay' (immediately).
    'Được làm bằng thép không gỉ ạ' ✗  →  'Được làm bằng thép không gỉ' ✓
    'Vì vậy, sản phẩm đạt chuẩn ISO 9001' ✓  ('vì vậy' is not a particle here)
- PRONOUNS — use neutral catalog forms:
    'we'        → 'Chúng tôi'  (a company never says 'chúng ta' to customers)
    'you'       → 'Quý khách' (sales/customer copy) / 'Quý vị' (broad audience) /
                  'người dùng' (technical manual) / 'người tiêu dùng' (legal/policy) /
                  'bạn' (ONLY if the client style guide asks for friendly B2C tone)
    'please'    → 'Vui lòng'
    'thank you' → 'Cảm ơn' / 'Xin cảm ơn'
- FORBIDDEN as 'you' in catalog body: anh / chị / em / cô / chú / bác / ông / bà /
  cháu / con / mày / cậu / tớ. They force a guess about the reader's gender, age,
  or relationship — guessing wrong is immediately impolite.
- FORBIDDEN: title prefix before a name (Mr./Mrs./Ms./Dear → Ông/Bà/Cô) — same
  reason. Address the reader with a neutral form, or drop the salutation entirely.
- HEADINGS: Vietnamese does NOT use English Title Case.
    'Product Specifications' → 'Thông số kỹ thuật'   (NOT 'Thông Số Kỹ Thuật')
    ALL-CAPS headings keep full diacritics: 'THÔNG SỐ KỸ THUẬT'
- Declarative product copy stays declarative (no chat particles):
    'Made of stainless steel' → 'Được làm bằng thép không gỉ'
- Buttons / UI labels → short imperative or noun phrase, no particles:
    'Add to cart' → 'Thêm vào giỏ hàng'.   'Buy now' → 'Mua ngay'.
- Numbers + units + model codes + brands stay verbatim: '100 mm', '±0.5 mm', 'Ø25',
  '90°C', 'Microsoft', 'ISO 9001'. Technical symbols (°C % ± × Ø µm ≥ ≤) stay as-is.
- STARTER GLOSSARY — defaults; the client GLOSSARY (base prompt section) overrides:
    Material → 'Chất liệu'            Specifications → 'Thông số kỹ thuật'
    Dimensions → 'Kích thước'         Weight → 'Trọng lượng'
    Warranty → 'Bảo hành'             Origin / Made in → 'Xuất xứ' / 'Sản xuất tại'
    MOQ → 'Số lượng đặt hàng tối thiểu (MOQ)'
    Lead time → 'Thời gian giao hàng' Packing → 'Quy cách đóng gói'
    Features → 'Tính năng'            Model → 'Mã sản phẩm / Model'
    Quantity → 'Số lượng'             Price → 'Giá'         Color → 'Màu sắc'
    Certificate → 'Chứng nhận'        Instruction manual → 'Hướng dẫn sử dụng'
- Sales phrasing must stay formal:
    'Contact us for a quote' → 'Vui lòng liên hệ với chúng tôi để nhận báo giá'
      (NOT 'Liên hệ nhé').
    'We offer free samples'  → 'Chúng tôi cung cấp mẫu miễn phí'
      (NOT 'Tụi tôi tặng mẫu').
"""
