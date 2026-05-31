import { state } from "../../state.js";
import { COLORS } from "../../colors.js";
import { SPEAKER_SKIP } from "../../characters.js";
import { measureTextInBox, TEXTBOX_PADDING, TEXTBOX_FONT_FAMILY } from "../../text-layout.js";

const CATEGORY_COLOR = {
    texts: COLORS.categoryTexts,
    tables: COLORS.categoryTables,
    pictures: COLORS.categoryPictures,
};

function getEffectiveBox(item, sx, sy, pageW, pageH) {
    const b = item.bbox;
    const isBL = (b.coord_origin || "").toUpperCase() === "BOTTOMLEFT";
    let x = b.l * sx;
    let w = (b.r - b.l) * sx;
    let y, h;
    if (isBL) {
        y = (pageH - b.t) * sy;
        h = (b.t - b.b) * sy;
    } else {
        y = b.t * sy;
        h = (b.b - b.t) * sy;
    }
    const ov = state.bboxOverrides[item.self_ref];
    if (ov) {
        if (typeof ov.x === "number") x = ov.x;
        if (typeof ov.y === "number") y = ov.y;
        if (typeof ov.w === "number") w = ov.w;
        if (typeof ov.h === "number") h = ov.h;
    }
    return { x, y, w, h };
}

function _applyRotation(ctx, x, y, w, h, rotDeg) {
    if (!rotDeg) return;
    const cx = x + w / 2, cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rotDeg * Math.PI / 180);
    ctx.translate(-cx, -cy);
}

// fallback font size = binary search ขนาดใหญ่สุดที่ text fit ใน bbox
// (heuristic height/lines เดาผิดบ่อยตอน docling join text เป็น 1 บรรทัด → คิดว่า font ใหญ่)
function _fallbackFontSize(ctx, text, origW, origH) {
    const innerW = Math.max(origW - 8, 1);
    const innerH = Math.max(origH - 8, 1);
    if (origW <= 8 || origH <= 8 || !text.trim()) return 14;
    let lo = 8, hi = 36;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const probe = measureTextInBox(ctx, text, origW, { fixedFontSize: mid });
        if (probe && probe.requiredH <= innerH) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

export function renderBoxes(ctx, opts) {
    const { items, sx, sy, pageW, pageH, z, previewMode } = opts;
    const drawn = [];
    const overlayRenders = [];
    const normalRenders = [];

    items.forEach(it => {
        if (!it.bbox) return;
        const { x, y, w, h } = getEffectiveBox(it, sx, sy, pageW, pageH);
        const color = CATEGORY_COLOR[it.category] || COLORS.textMuted;
        const corr = it.self_ref ? state.corrections[it.self_ref] : undefined;
        const tr = it.self_ref ? state.translations[it.self_ref] : undefined;
        const wasCorrected = corr !== undefined && corr.trim() !== (it.text || "").trim();
        const ov = state.bboxOverrides[it.self_ref] || {};
        const isSkip = it.self_ref && state.speakerByRef[it.self_ref] === SPEAKER_SKIP;

        const b = it._fontBbox || it.bbox || {};
        const origW = Math.abs((b.r || 0) - (b.l || 0)) * sx;
        const origH = Math.abs((b.b || 0) - (b.t || 0)) * sy;
        const fallbackFontSize = _fallbackFontSize(ctx, it.text || "", origW, origH);
        const ocrFontSize = it.font_size ? it.font_size * sy : 0;
        const effectiveFontSize = ov.fontSize || ocrFontSize || fallbackFontSize;

        const isEditing = state.editing && state.editing.ref === it.self_ref;
        const overlayText = isEditing ? state.editing.text : (tr || corr || (it.text || ""));
        const rotation = (typeof ov.rotation === "number") ? ov.rotation : 0;
        if (isSkip && !isEditing) {
            drawn.push({ x, y, w, h, item: it, fontSize: effectiveFontSize, rotation });
            return;
        }
        if (overlayText || isEditing) {
            const measureText = overlayText || " ";
            const layout = measureTextInBox(ctx, measureText, w, {
                fixedFontSize: ov.fontSize,
                ocrFontSize,
                fallbackFontSize,
            });
            if (layout) {
                overlayRenders.push({ x, y, w, h, tr: overlayText, layout, align: ov.align || "left", valign: ov.valign || "top", isTranslated: !!tr, item: it, rotation, isEditing });
                drawn.push({ x, y, w, h, item: it, fontSize: layout.fontSize, rotation });
                return;
            }
        }
        normalRenders.push({ x, y, w, h, color, corr, tr, wasCorrected, item: it, rotation });
        drawn.push({ x, y, w, h, item: it, fontSize: effectiveFontSize, rotation });
    });

    overlayRenders.forEach(r => {
        const ov = state.bboxOverrides[r.item.self_ref] || {};
        ctx.save();
        _applyRotation(ctx, r.x, r.y, r.w, r.h, r.rotation);
        ctx.fillStyle = r.isEditing ? "#fff" : (ov.bgColor || r.item.bg_color || COLORS.overlayBg);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (!previewMode && !r.isEditing) {
            ctx.strokeStyle = r.isTranslated ? COLORS.primaryStrong : COLORS.borderMuted;
            ctx.lineWidth = 1 / z;
            if (!r.isTranslated) ctx.setLineDash([4 / z, 3 / z]);
            ctx.strokeRect(r.x, r.y, r.w, r.h);
            ctx.setLineDash([]);
        }
        ctx.restore();
    });

    overlayRenders.forEach(r => {
        if (!r.layout.lines.length) return;
        ctx.save();
        _applyRotation(ctx, r.x, r.y, r.w, r.h, r.rotation);
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.font = `${r.layout.fontSize}px ${TEXTBOX_FONT_FAMILY}`;
        const ov = state.bboxOverrides[r.item.self_ref] || {};
        ctx.fillStyle = ov.textColor || r.item.text_color || COLORS.text;
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        const totalTextH = r.layout.lines.length * r.layout.lineHeight;
        let topY;
        if (r.valign === "middle") {
            topY = r.y + TEXTBOX_PADDING + (r.h - TEXTBOX_PADDING * 2 - totalTextH) / 2;
        } else if (r.valign === "bottom") {
            topY = r.y + r.h - TEXTBOX_PADDING - totalTextH;
        } else {
            topY = r.y + TEXTBOX_PADDING;
        }
        const firstBaselineY = topY + r.layout.ascent;
        r.layout.lines.forEach((ln, i) => {
            let lineX;
            if (r.align === "center") lineX = r.x + (r.w - ln.width) / 2;
            else if (r.align === "right") lineX = r.x + r.w - TEXTBOX_PADDING - ln.width;
            else lineX = r.x + TEXTBOX_PADDING;
            ctx.fillText(ln.text, lineX, firstBaselineY + i * r.layout.lineHeight);
        });
        ctx.restore();
    });

    if (!previewMode) {
        ctx.lineWidth = 2 / z;
        ctx.font = `${11 / z}px ui-monospace, Menlo, monospace`;
        normalRenders.forEach(r => {
            const { x, y, w, h, color, tr, wasCorrected, item: it } = r;
            const sp = it.self_ref ? state.speakerByRef[it.self_ref] : null;
            const isSkip = sp === SPEAKER_SKIP;
            ctx.save();
            _applyRotation(ctx, x, y, w, h, r.rotation);
            if (isSkip) ctx.globalAlpha = 0.35;
            ctx.strokeStyle = color;
            ctx.lineWidth = (wasCorrected ? 3 : 2) / z;
            ctx.fillStyle = wasCorrected ? COLORS.warningBgAlpha : color + "22";
            ctx.fillRect(x, y, w, h);
            ctx.strokeRect(x, y, w, h);
            let spTag = "";
            if (isSkip) spTag = "🚫 ";
            else if (sp) spTag = `👤${sp} `;
            const lbl = ((tr ? "🌐 " : (wasCorrected ? "✨ " : "")) + spTag).trim();
            if (lbl) {
                const lh = 14 / z;
                const lpad = 4 / z;
                const lbase = 3 / z;
                const lmaxw = 160 / z;
                ctx.fillStyle = tr ? COLORS.primaryStrong : (wasCorrected ? COLORS.warning : color);
                ctx.fillRect(x, Math.max(0, y - lh), Math.min(lmaxw, w), lh);
                ctx.fillStyle = COLORS.textInverse;
                ctx.fillText(lbl, x + lpad, Math.max(11 / z, y - lbase));
            }
            ctx.restore();
        });
    }

    return drawn;
}
