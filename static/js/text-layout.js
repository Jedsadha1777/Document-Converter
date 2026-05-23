// Pure text layout — Pretext wrapping + font measurement (canvas-based)
// ไม่แตะ state, ไม่มี side effects — preview.js วาดเอง

export const TEXTBOX_PADDING = 4;
export const TEXTBOX_FONT_FAMILY = '-apple-system, "Helvetica Neue", "Sarabun", sans-serif';

// detect locale จาก script ที่เจอใน text — ส่งให้ Pretext เลือก line-break rules ที่ถูก
function detectLocale(text) {
    if (/[฀-๿]/.test(text)) return "th";
    if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja";  // hiragana/katakana
    if (/[가-힯]/.test(text)) return "ko";
    if (/[一-鿿]/.test(text)) return "zh";
    return undefined;
}

let _pretextLocale = null;
function ensurePretextLocale(text) {
    if (typeof Pretext === "undefined") return;
    const loc = detectLocale(text);
    if (loc !== _pretextLocale) {
        Pretext.setLocale(loc);
        _pretextLocale = loc;
    }
}

// Pretext: word/grapheme segmentation + Unicode line-break (Thai/JP/CJK ตัดถูก)
// คืน [{ text, width }, ...] — width มาจาก Pretext ไม่ต้อง measureText ซ้ำ
function wrapTextSmart(ctx, text, maxWidth, lineHeight) {
    if (!text) return [];
    if (typeof Pretext !== "undefined") {
        try {
            ensurePretextLocale(text);
            const prepared = Pretext.prepareWithSegments(text, ctx.font, { whiteSpace: "pre-wrap" });
            const out = Pretext.layoutWithLines(prepared, Math.max(maxWidth, 1), lineHeight || 1);
            return out.lines.map(l => ({ text: l.text, width: l.width }));
        } catch (e) {
            console.warn("[wrapTextSmart] Pretext failed, fallback:", e);
        }
    }
    // fallback: naive whitespace + char-break
    const tokens = text.split(/(\s+)/);
    const lines = [];
    let line = "";
    const breakByChar = (chunk) => {
        const out = [];
        let cur = "";
        for (const c of chunk) {
            if (cur && ctx.measureText(cur + c).width > maxWidth) {
                out.push(cur);
                cur = c;
            } else {
                cur += c;
            }
        }
        if (cur) out.push(cur);
        return out;
    };
    for (const tok of tokens) {
        const test = line + tok;
        if (ctx.measureText(test).width > maxWidth) {
            if (line.trim()) {
                lines.push(line.replace(/\s+$/, ""));  // trim trailing space ก่อน push
                line = "";
            }
            if (ctx.measureText(tok).width > maxWidth) {
                const broken = breakByChar(tok);
                lines.push(...broken.slice(0, -1));
                line = broken[broken.length - 1] || "";
            } else {
                line = tok.trimStart();
            }
        } else {
            line = test;
        }
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ""));
    return lines.map(t => ({ text: t, width: ctx.measureText(t).width }));
}

// คำนวณ layout — font size priority: user-fixed → OCR → fallback
// ascent/descent/lineHeight ใช้ FONT METRICS (ครอบคลุมสระไทยทุกบรรทัด สม่ำเสมอ)
// ไม่ใช้ actualBoundingBox* เพราะค่าผันแปรตามตัวอักษร — บรรทัดต่างกันจะ spacing ไม่เท่า
// + สระบน/ล่างไทยข้ามบรรทัดอาจชนกัน
export function measureTextInBox(ctx, text, w, opts) {
    opts = opts || {};
    const f = opts.fixedFontSize || opts.ocrFontSize || opts.fallbackFontSize;
    if (!f || f <= 0) return null;
    ctx.font = `${f}px ${TEXTBOX_FONT_FAMILY}`;
    const innerW = Math.max(w - TEXTBOX_PADDING * 2, 1);
    const clean = String(text || "").replace(/\s+/g, " ").trim();

    // ใช้ fontBoundingBox* ถ้า browser รองรับ (Chrome 87+/Safari 11.1+/FF 116+)
    // ครอบคลุม glyph สูงสุดของ font นี้ — ไม่ผันแปรตาม text content
    // Fallback: f * 1.3 (line-height ratio ที่เผื่อสระไทย/diacritics)
    const probe = ctx.measureText("M");  // probe character (ไม่สำคัญ — fontBoundingBox วัดจาก font ไม่ใช่ text)
    let ascent, descent;
    if (typeof probe.fontBoundingBoxAscent === "number" && typeof probe.fontBoundingBoxDescent === "number") {
        ascent = Math.ceil(probe.fontBoundingBoxAscent);
        descent = Math.ceil(probe.fontBoundingBoxDescent);
    } else {
        ascent = Math.ceil(f * 0.95);   // ~ascent ของ font ทั่วไป
        descent = Math.ceil(f * 0.35);  // ~descent + Thai สระล่าง (อู/อุ)
    }
    const lineHeight = ascent + descent;

    if (!clean) return { fontSize: f, ascent, descent, lineHeight, lines: [], requiredH: TEXTBOX_PADDING * 2 };

    const lines = wrapTextSmart(ctx, clean, innerW, lineHeight);
    const requiredH = Math.ceil(lines.length * lineHeight + TEXTBOX_PADDING * 2);
    return { fontSize: f, ascent, descent, lineHeight, lines, requiredH };
}
