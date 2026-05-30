PROMPT = """

═══ CONTENT TYPE: PRODUCT CATALOG (e-commerce / spec sheet / factory manual) ═══
Target: Vietnamese. Register: professional, formal, technical — like a product
catalog, factory manual, or datasheet. Never default to manga / chat / dialogue style.
- NO conversational sentence-final particles in declarative catalog/spec text.
  FORBIDDEN: ạ / nhé / nha / đấy / đó / nhỉ / hả / vậy / luôn.
- PRONOUNS — use neutral catalog forms:
    'we'        → 'Chúng tôi'
    'you'       → 'Quý khách' (sales/customer copy) / 'Quý vị' (broad audience) /
                  'người dùng' (technical manual) / 'người tiêu dùng' (legal/policy)
    'please'    → 'Vui lòng'
    'thank you' → 'Cảm ơn' / 'Xin cảm ơn'
- FORBIDDEN as 'you' in catalog body: anh / chị / em / cô / chú / bác / ông / bà /
  cháu / con / mày / cậu / tớ. They force a guess about the reader's gender, age,
  or relationship — guessing wrong is immediately impolite.
- FORBIDDEN: title prefix before a name (Mr./Mrs./Ms./Dear → Ông/Bà/Cô) — same
  reason; guessing the wrong gender is impolite. Address the reader with a neutral
  form, or drop the salutation entirely.
- Declarative product copy stays declarative (no chat particles):
    'Made of stainless steel' → 'Được làm bằng thép không gỉ'
    NOT 'Được làm bằng thép không gỉ ạ'.
- Buttons / UI labels → short imperative or noun phrase, no particles:
    'Add to cart' → 'Thêm vào giỏ hàng'.   'Buy now' → 'Mua ngay'.
- Numbers + units + brand names stay verbatim: 100 mm stays '100 mm';
  Microsoft stays 'Microsoft'; ISO 9001 stays 'ISO 9001'.
- Use the conventional Vietnamese industry term from the glossary TM
  (Material / Specifications / Warranty / MOQ etc.).
- Sales phrasing must stay formal:
    'Contact us for a quote' → 'Vui lòng liên hệ chúng tôi để được báo giá'
      (NOT 'Liên hệ nhé').
    'We offer free samples'  → 'Chúng tôi cung cấp mẫu miễn phí'
      (NOT 'Tụi tôi tặng mẫu').
"""
