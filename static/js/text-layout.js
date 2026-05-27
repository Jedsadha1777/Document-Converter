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

// Force-break บรรทัดที่ Pretext ปล่อยล้น (ภาษาที่ Intl.Segmenter ทำ isWordLike=false
// เช่น Thai run อักษรซ้ำๆ "ยาาาาาาาว" → Pretext break ไม่ได้) — ตัดที่ grapheme เพื่อ
// ไม่แยกตัวอักษรหลัก + สระบน/ล่าง/วรรณยุกต์ ของไทย ออกจากกัน
let _graphemeSegmenter = null;
function _graphemes(text) {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
        if (!_graphemeSegmenter) _graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        return [...(_graphemeSegmenter.segment(text))].map(s => s.segment);
    }
    return [...text];   // fallback: code-point iteration
}
function _forceBreakLine(ctx, text, maxWidth) {
    const out = [];
    let cur = "";
    for (const g of _graphemes(text)) {
        const tryStr = cur + g;
        if (cur && ctx.measureText(tryStr).width > maxWidth) {
            out.push({ text: cur, width: ctx.measureText(cur).width });
            cur = g;
        } else {
            cur = tryStr;
        }
    }
    if (cur) out.push({ text: cur, width: ctx.measureText(cur).width });
    return out;
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
            // post-fix: บรรทัดที่ยังกว้างเกิน maxWidth (Pretext ปล่อยล้น) → force-break ที่ grapheme
            const fitted = [];
            for (const l of out.lines) {
                if (l.width <= maxWidth) {
                    fitted.push({ text: l.text, width: l.width });
                } else {
                    for (const piece of _forceBreakLine(ctx, l.text, maxWidth)) fitted.push(piece);
                }
            }
            return fitted;
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
// ascent/descent: เริ่มจาก fontBoundingBox* แล้วขยายตาม actualBoundingBox* ของแต่ละบรรทัด
// (เผื่อ Thai สระบน/วรรณยุกต์ที่ fontBoundingBox ของ -apple-system รายงานไม่ครบ → glyph
// ถูก clip ที่ขอบบน) max ทุกบรรทัด → spacing สม่ำเสมอภายในกล่อง
export function measureTextInBox(ctx, text, w, opts) {
    opts = opts || {};
    const f = opts.fixedFontSize || opts.ocrFontSize || opts.fallbackFontSize;
    if (!f || f <= 0) return null;
    ctx.font = `${f}px ${TEXTBOX_FONT_FAMILY}`;
    const innerW = Math.max(w - TEXTBOX_PADDING * 2, 1);
    // collapse แค่ horizontal whitespace; เก็บ \n ไว้เพื่อให้ Pretext (whiteSpace:"pre-wrap")
    // จัดเป็น hard-break — ผู้ใช้พิมพ์ Enter ใน Translation textarea แล้วต้องขึ้นบรรทัดใหม่จริง
    const clean = String(text || "")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/^[ \t]+|[ \t]+$/gm, "");

    const probe = ctx.measureText("M");
    let ascent, descent;
    if (typeof probe.fontBoundingBoxAscent === "number" && typeof probe.fontBoundingBoxDescent === "number") {
        ascent = Math.ceil(probe.fontBoundingBoxAscent);
        descent = Math.ceil(probe.fontBoundingBoxDescent);
    } else {
        ascent = Math.ceil(f * 0.95);
        descent = Math.ceil(f * 0.35);
    }

    if (!clean.trim()) {
        return { fontSize: f, ascent, descent, lineHeight: ascent + descent, lines: [], requiredH: TEXTBOX_PADDING * 2 };
    }

    const lines = wrapTextSmart(ctx, clean, innerW, ascent + descent);

    // ขยาย ascent/descent ถ้า glyph จริงสูงกว่า fontBoundingBox
    // — Thai ไม้โท/ไม้ตรี/นิคหิต ฯลฯ อาจเกิน Latin metrics ของ -apple-system → ไม่ clip
    for (const line of lines) {
        const m = ctx.measureText(line.text);
        if (typeof m.actualBoundingBoxAscent === "number") {
            ascent = Math.max(ascent, Math.ceil(m.actualBoundingBoxAscent));
        }
        if (typeof m.actualBoundingBoxDescent === "number") {
            descent = Math.max(descent, Math.ceil(m.actualBoundingBoxDescent));
        }
    }
    const lineHeight = ascent + descent;
    const requiredH = Math.ceil(lines.length * lineHeight + TEXTBOX_PADDING * 2);
    return { fontSize: f, ascent, descent, lineHeight, lines, requiredH };
}
