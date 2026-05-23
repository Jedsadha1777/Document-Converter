// Visual Preview — canvas rendering + mouse interaction + edit toolbar
// อิงรูปแบบ Ketchup/tools/SelectTool — drag/marquee/resize handles
//
// window globals ที่ใช้:
//   window._previewWrap — wrap ปัจจุบัน, เปิดให้ history listener เรียก _redraw() ได้
//   window._previewDocMouseUp — document-level mouseup ที่ลงทะเบียนต่อ render
//   window.buildCompareTable — bridge เรียก rebuild Compare table หลัง undo/redo

import { measureTextInBox, TEXTBOX_PADDING, TEXTBOX_FONT_FAMILY } from "./text-layout.js";
import { state, toggleSelect, clearSelection } from "./state.js";
import { history } from "./history.js";
import { UpdateBboxCmd, SetSpeakerCmd, MergeBoxesCmd, CompositeCommand } from "./commands.js";
import { escapeHtml, diffChars, renderDiffSide } from "./diff.js";
import { getCharacters, renderSpeakerOptions, SPEAKER_SKIP } from "./characters.js";
import { COLORS } from "./colors.js";

// deep clone helper สำหรับ command snapshots
const _clone = (v) => v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));

const CATEGORY_COLOR = {
    texts: COLORS.categoryTexts,
    tables: COLORS.categoryTables,
    pictures: COLORS.categoryPictures,
};
const HANDLE_SIZE = 8;       // resize handle ขนาด px
const MIN_BOX = 12;          // bbox ขนาดต่ำสุดตอน resize
const DRAG_THRESHOLD = 4;    // ขยับน้อยกว่า px นี้ถือเป็น click (ไม่ใช่ drag)

// state shortcuts — sel = state.selection (object by ref), drag/marquee = scalars (need get/set)
const sel = state.selection;
const getDrag = () => state.drag;
const setDrag = (v) => { state.drag = v; };
const getMarquee = () => state.marquee;
const setMarquee = (v) => { state.marquee = v; };

// ─────────────────────────────────────────────────────────
// helpers — selection UI + hit testing
// ─────────────────────────────────────────────────────────

function _updateMergeButton() {
    const btn = document.getElementById("mergeSelectedBtn");
    const cnt = document.getElementById("mergeCount");
    if (!btn || !cnt) return;
    cnt.textContent = String(sel.refs.size);
    btn.style.display = sel.refs.size >= 2 ? "" : "none";
}

function _clearSelectionAndButton() {
    clearSelection();
    _updateMergeButton();
    _syncAlignToolbar();
}
// expose สำหรับ upload.js / index.html — ล้าง state + merge button UI ในก้าวเดียว
export const clearSelectionAndUI = _clearSelectionAndButton;

// sync ปุ่ม align/valign ให้ highlight ตาม override ของ sel.ref ปัจจุบัน
function _syncAlignToolbar() {
    const ids = ["alignLeftBtn", "alignCenterBtn", "alignRightBtn",
                 "valignTopBtn", "valignMiddleBtn", "valignBottomBtn"];
    const btns = ids.map(id => document.getElementById(id));
    btns.forEach(b => b?.classList.remove("active"));
    if (!sel.ref) return;
    const ov = state.bboxOverrides[sel.ref] || {};
    const hMap = { left: 0, center: 1, right: 2 };
    const vMap = { top: 3, middle: 4, bottom: 5 };
    if (ov.align in hMap) btns[hMap[ov.align]]?.classList.add("active");
    if (ov.valign in vMap) btns[vMap[ov.valign]]?.classList.add("active");
}

function _toggleSelectAndButton(ref, additive) {
    toggleSelect(ref, additive);
    _updateMergeButton();
    _syncAlignToolbar();
}

function getEffectiveBox(item, sx, sy, pageW, pageH) {
    // คืนกล่อง display (px) — รวม override ถ้ามี
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

function _hitHandle(box, px, py) {
    const hs = HANDLE_SIZE;
    const halves = [
        { name: "nw", cx: box.x,             cy: box.y },
        { name: "n",  cx: box.x + box.w / 2, cy: box.y },
        { name: "ne", cx: box.x + box.w,     cy: box.y },
        { name: "e",  cx: box.x + box.w,     cy: box.y + box.h / 2 },
        { name: "se", cx: box.x + box.w,     cy: box.y + box.h },
        { name: "s",  cx: box.x + box.w / 2, cy: box.y + box.h },
        { name: "sw", cx: box.x,             cy: box.y + box.h },
        { name: "w",  cx: box.x,             cy: box.y + box.h / 2 },
    ];
    for (const h of halves) {
        if (Math.abs(px - h.cx) <= hs && Math.abs(py - h.cy) <= hs) return h.name;
    }
    return null;
}

function _drawHandles(ctx, box) {
    const hs = HANDLE_SIZE;
    const pts = [
        [box.x,              box.y],
        [box.x + box.w / 2,  box.y],
        [box.x + box.w,      box.y],
        [box.x + box.w,      box.y + box.h / 2],
        [box.x + box.w,      box.y + box.h],
        [box.x + box.w / 2,  box.y + box.h],
        [box.x,              box.y + box.h],
        [box.x,              box.y + box.h / 2],
    ];
    ctx.fillStyle = COLORS.textInverse;
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = 2;
    for (const [px, py] of pts) {
        ctx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
        ctx.strokeRect(px - hs / 2, py - hs / 2, hs, hs);
    }
}

// ─────────────────────────────────────────────────────────
// Speaker popup
// ─────────────────────────────────────────────────────────

let _bboxPopup = null;

function _ensureBboxPopup() {
    if (_bboxPopup) return _bboxPopup;
    _bboxPopup = document.createElement("div");
    _bboxPopup.className = "bbox-popup";
    _bboxPopup.innerHTML = `
        <div class="label">Speaker:</div>
        <select class="speaker-select" data-bbox-popup="1"></select>
    `;
    document.body.appendChild(_bboxPopup);
    document.addEventListener("click", (e) => {
        if (_bboxPopup && _bboxPopup.style.display === "block"
            && !_bboxPopup.contains(e.target)) {
            _bboxPopup.style.display = "none";
        }
    });
    return _bboxPopup;
}

function showBboxSpeakerPopup(hit, clientX, clientY) {
    const pop = _ensureBboxPopup();
    const ref = hit.item.self_ref;
    if (!ref) return;
    const chars = getCharacters();
    const cur = state.speakerByRef[ref] || (chars[0] && chars[0].id) || "";
    const selEl = pop.querySelector("select");
    selEl.dataset.ref = ref;
    selEl.innerHTML = renderSpeakerOptions()(cur);

    selEl.onchange = () => {
        const before = state.speakerByRef[ref];
        history.exec(new SetSpeakerCmd(ref, before, selEl.value));
        redrawOnly();
        const compareArea = document.getElementById("compareArea");
        const compareSel = compareArea?.querySelector(
            `tr[data-ref="${CSS.escape(ref)}"] select.speaker-select`
        );
        if (compareSel && compareSel.value !== selEl.value) {
            compareSel.value = selEl.value;
        }
        pop.style.display = "none";
    };

    const popW = 200, popH = 80;
    let x = clientX + 8;
    let y = clientY + 8;
    if (x + popW > window.innerWidth) x = window.innerWidth - popW - 8;
    if (y + popH > window.innerHeight) y = clientY - popH - 8;
    pop.style.left = x + "px";
    pop.style.top = y + "px";
    pop.style.display = "block";
    selEl.focus();
}

// ─────────────────────────────────────────────────────────
// Merge boxes
// ─────────────────────────────────────────────────────────

// snapshot ทั้ง state ที่ merge อาจแตะ — ใช้สำหรับ MergeBoxesCmd before/after
function _mergeSnapshot() {
    const lr = state.lastResult || {};
    return {
        items: _clone(lr.preview?.items || []),
        texts: _clone(lr.texts || []),
        json_text: lr.json_text || "",
        corrections: _clone(state.corrections),
        translations: _clone(state.translations),
        speakerByRef: _clone(state.speakerByRef),
        bboxOverrides: _clone(state.bboxOverrides),
        manualEdits: [...state.manualEdits],
        manualTranslations: [...state.manualTranslations],
    };
}

export function mergeSelectedBoxes() {
    const lastResult = state.lastResult;
    if (!lastResult || sel.refs.size < 2) return;
    if (!lastResult.preview || !Array.isArray(lastResult.preview.items)) {
        console.warn("[merge] preview.items missing");
        return;
    }
    const before = _mergeSnapshot();

    const refs = [...sel.refs];
    const items = lastResult.preview.items;
    const texts = Array.isArray(lastResult.texts) ? lastResult.texts : [];

    const bboxOf = (x) => x?.bbox || (Array.isArray(x?.prov) && x.prov[0]?.bbox) || null;
    const clickOrder = new Map(refs.map((r, i) => [r, i]));
    const sortByClickOrder = (a, b) =>
        (clickOrder.get(a.self_ref) ?? 1e9) - (clickOrder.get(b.self_ref) ?? 1e9);

    const uniq = (arr) => {
        const seen = new Set();
        return arr.filter(x => {
            if (!x.self_ref || seen.has(x.self_ref)) return false;
            seen.add(x.self_ref); return true;
        });
    };
    const matchedItems = uniq(items.filter(it => refs.includes(it.self_ref))).sort(sortByClickOrder);
    const matchedTexts = uniq(texts.filter(t => refs.includes(t.self_ref))).sort(sortByClickOrder);
    if (matchedItems.length < 2 && matchedTexts.length < 2) {
        console.warn("[merge] fewer than 2 unique items matched");
        return;
    }

    const allBboxes = [...matchedItems, ...matchedTexts].map(bboxOf).filter(Boolean);
    const isBL = (allBboxes[0]?.coord_origin || "").toUpperCase() === "BOTTOMLEFT";
    const mergedBbox = allBboxes.length ? {
        l: Math.min(...allBboxes.map(b => b.l)),
        r: Math.max(...allBboxes.map(b => b.r)),
        t: isBL ? Math.max(...allBboxes.map(b => b.t)) : Math.min(...allBboxes.map(b => b.t)),
        b: isBL ? Math.min(...allBboxes.map(b => b.b)) : Math.max(...allBboxes.map(b => b.b)),
        coord_origin: allBboxes[0].coord_origin || "TOPLEFT",
    } : null;

    const textSource = matchedTexts.length ? matchedTexts : matchedItems;
    const mergedText = textSource.map(x => (x.text || "").trim()).filter(Boolean).join(" ");
    if (!mergedText) {
        console.warn("[merge] mergedText is empty — aborting", { refs, matchedItems, matchedTexts });
        return;
    }

    const keepRef = refs[0];
    const dropRefs = new Set(refs.slice(1));

    const newItems = items.filter(it => !dropRefs.has(it.self_ref));
    const newTexts = texts.filter(t => !dropRefs.has(t.self_ref));

    let keepItemFound = false;
    newItems.forEach(it => {
        if (it.self_ref !== keepRef) return;
        if (!keepItemFound) {
            if (it.bbox && !it._fontBbox) it._fontBbox = { ...it.bbox };
            it.bbox = mergedBbox;
            it.text = mergedText;
            keepItemFound = true;
        } else {
            it.text = mergedText;
        }
    });
    if (!keepItemFound) console.warn("[merge] keep item not found in newItems", { keepRef });

    newTexts.forEach(t => {
        if (t.self_ref !== keepRef) return;
        t.text = mergedText;
        if ("orig" in t) t.orig = mergedText;
        if (Array.isArray(t.prov) && t.prov.length && mergedBbox) {
            const p0 = t.prov[0];
            t.prov = [{
                page_no: p0.page_no || 1,
                bbox: { ...mergedBbox },
                charspan: [0, mergedText.length],
            }];
        } else if (mergedBbox) {
            t.bbox = mergedBbox;
        }
    });

    dropRefs.forEach(r => {
        delete state.corrections[r];
        delete state.translations[r];
        delete state.bboxOverrides[r];
        state.manualEdits.delete(r);
        state.manualTranslations.delete(r);
        delete state.speakerByRef[r];
    });
    delete state.corrections[keepRef];
    delete state.translations[keepRef];
    state.manualEdits.delete(keepRef);
    state.manualTranslations.delete(keepRef);
    if (state.bboxOverrides[keepRef]) {
        const ov = state.bboxOverrides[keepRef];
        delete ov.x; delete ov.y; delete ov.w; delete ov.h;
        if (!ov.fontSize && !ov.align) delete state.bboxOverrides[keepRef];
    }

    // Re-index self_ref ของ newTexts → #/texts/0..N ต่อเนื่อง
    const refMap = new Map();
    newTexts.forEach((t, idx) => {
        const oldRef = t.self_ref;
        const newRef = `#/texts/${idx}`;
        refMap.set(oldRef, newRef);
        t.self_ref = newRef;
    });
    newItems.forEach(it => {
        const nr = refMap.get(it.self_ref);
        if (nr) it.self_ref = nr;
    });

    const _remapDict = (d) => {
        const nd = {};
        Object.keys(d).forEach(k => {
            const nk = refMap.get(k);
            if (nk !== undefined) nd[nk] = d[k];
        });
        Object.keys(d).forEach(k => delete d[k]);
        Object.assign(d, nd);
    };
    const _remapSet = (s) => {
        const ns = new Set();
        s.forEach(k => { const nk = refMap.get(k); if (nk !== undefined) ns.add(nk); });
        s.clear();
        ns.forEach(v => s.add(v));
    };
    _remapDict(state.corrections);
    _remapDict(state.translations);
    _remapDict(state.bboxOverrides);
    _remapDict(state.speakerByRef);
    _remapSet(state.manualEdits);
    _remapSet(state.manualTranslations);

    lastResult.preview.items = newItems;
    lastResult.texts = newTexts;

    // Sync JSON output
    const output = document.getElementById("output");
    try {
        const j = JSON.parse(output.value);
        if (Array.isArray(j.texts)) {
            j.texts = newTexts.map(t => ({ ...t }));
        }
        const out = JSON.stringify(j, null, 2);
        output.value = out;
        lastResult.json_text = out;
    } catch (e) {
        console.warn("[merge] JSON sync failed", e);
    }

    // push history entry — do() reapply after (idempotent), undo() คืน before ทั้งก้อน
    const after = _mergeSnapshot();
    history.exec(new MergeBoxesCmd(before, after));

    _clearSelectionAndButton();
    renderPreview();
    window.buildCompareTable?.(true);
}

// ─────────────────────────────────────────────────────────
// renderPreview — สร้าง canvas + วาด + wire mouse handlers
// ─────────────────────────────────────────────────────────

export function renderPreview() {
    const previewArea = document.getElementById("previewArea");
    const pageSelect = document.getElementById("pageSelect");
    const lastResult = state.lastResult;

    if (!lastResult || !lastResult.preview || !lastResult.preview.pages.length) {
        previewArea.innerHTML = '<div class="empty">Upload a file to see the preview.</div>';
        return;
    }
    const pageNo = parseInt(pageSelect.value || lastResult.preview.pages[0].page_no, 10);
    const page = lastResult.preview.pages.find(p => p.page_no === pageNo);
    if (!page || !page.image) {
        previewArea.innerHTML = '<div class="empty">No image for this page.</div>';
        return;
    }

    const showTexts = document.getElementById("showTexts");
    const showTables = document.getElementById("showTables");
    const showPictures = document.getElementById("showPictures");
    const showLabels = document.getElementById("showLabels");

    previewArea.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap";
    const img = new Image();  // โหลดอย่างเดียว ไม่ append เข้า DOM — กัน native image drag
    const canvas = document.createElement("canvas");
    const tooltip = document.createElement("div");
    tooltip.className = "tooltip";
    wrap.appendChild(canvas); wrap.appendChild(tooltip);
    previewArea.appendChild(wrap);

    img.onload = () => {
        const containerW = previewArea.clientWidth || img.naturalWidth;
        const dispW = Math.min(containerW, img.naturalWidth);
        const dispH = Math.round(dispW * img.naturalHeight / img.naturalWidth);
        canvas.width = dispW;
        canvas.height = dispH;
        canvas.style.width = dispW + "px";
        canvas.style.height = dispH + "px";

        const pageW = page.width || img.naturalWidth;
        const pageH = page.height || img.naturalHeight;
        const sx = dispW / pageW;
        const sy = dispH / pageH;

        const ctx = canvas.getContext("2d");
        let drawn = [];

        // === closure ที่ redraw canvas เท่านั้น — ไม่ rebuild DOM (ลด flicker) ===
        const doDraw = () => {
            // re-filter items แต่ละ doDraw — รองรับ undo/redo ที่เปลี่ยน state.lastResult.preview.items
            const items = (state.lastResult?.preview?.items || []).filter(it => {
                if (it.page_no !== pageNo) return false;
                if (it.category === "texts" && !showTexts.checked) return false;
                if (it.category === "tables" && !showTables.checked) return false;
                if (it.category === "pictures" && !showPictures.checked) return false;
                return true;
            });
            ctx.drawImage(img, 0, 0, dispW, dispH);
            ctx.lineWidth = 2;
            ctx.font = "11px ui-monospace, Menlo, monospace";

            const overlayMode = document.getElementById("showOverlay").checked;
            drawn = [];

            const overlayRenders = [];
            const normalRenders = [];
            items.forEach(it => {
                if (!it.bbox) return;
                const eff = getEffectiveBox(it, sx, sy, pageW, pageH);
                const { x, y, w, h } = eff;
                const color = CATEGORY_COLOR[it.category] || COLORS.textMuted;
                const corr = it.self_ref ? state.corrections[it.self_ref] : undefined;
                const tr = it.self_ref ? state.translations[it.self_ref] : undefined;
                const wasCorrected = corr !== undefined && corr.trim() !== (it.text || "").trim();
                const ov = state.bboxOverrides[it.self_ref] || {};
                const isSkip = it.self_ref && state.speakerByRef[it.self_ref] === SPEAKER_SKIP;

                // effective font size — ตรงกับ priority ใน measureTextInBox (override > OCR > fallback)
                // เก็บลง drawn[] เพื่อให้ปุ่ม A+/A− เริ่ม inc/dec จากค่าที่แสดงจริง ไม่ใช่ค่าเดา
                const b = it._fontBbox || it.bbox || {};
                const origW = Math.abs((b.r || 0) - (b.l || 0)) * sx;
                const origH = Math.abs((b.b || 0) - (b.t || 0)) * sy;
                const fallbackFontSize = Math.min(48, Math.max(10, Math.round(Math.min(origH, origW) * 0.7)));
                const ocrFontSize = it.font_size ? it.font_size * sy : 0;
                const effectiveFontSize = ov.fontSize || ocrFontSize || fallbackFontSize;

                const overlayText = tr || corr || (it.text || "");
                if (overlayMode && (overlayText || isSkip)) {
                    // SKIP → white box คลุมต้นฉบับ ไม่วาด text (คำหายไป)
                    if (isSkip) {
                        overlayRenders.push({ x, y, w, h, layout: { lines: [] }, align: "left", isTranslated: false, isSkip: true, item: it });
                        drawn.push({ x, y, w, h, item: it, fontSize: effectiveFontSize });
                        return;
                    }
                    const layout = measureTextInBox(ctx, overlayText, w, {
                        fixedFontSize: ov.fontSize,
                        ocrFontSize,
                        fallbackFontSize,
                    });
                    if (!layout) {
                        normalRenders.push({ x, y, w, h, color, corr, tr, wasCorrected, item: it });
                        drawn.push({ x, y, w, h, item: it, fontSize: effectiveFontSize });
                        return;
                    }
                    overlayRenders.push({ x, y, w, h, tr: overlayText, layout, align: ov.align || "left", valign: ov.valign || "top", isTranslated: !!tr, item: it });
                    drawn.push({ x, y, w, h, item: it, fontSize: layout.fontSize });
                    return;
                }
                normalRenders.push({ x, y, w, h, color, corr, tr, wasCorrected, item: it });
                drawn.push({ x, y, w, h, item: it, fontSize: effectiveFontSize });
            });

            // Pass 1: overlay backgrounds + borders
            overlayRenders.forEach(r => {
                // SKIP → จาง (alpha 0.35) ทั้ง bg + border เหมือนกับ normal mode
                if (r.isSkip) ctx.save(), ctx.globalAlpha = 0.35;
                ctx.fillStyle = COLORS.overlayBg;
                ctx.fillRect(r.x, r.y, r.w, r.h);
                ctx.strokeStyle = r.isSkip ? COLORS.border : (r.isTranslated ? COLORS.primaryStrong : COLORS.borderMuted);
                ctx.lineWidth = 1;
                if (!r.isTranslated || r.isSkip) ctx.setLineDash([4, 3]);
                ctx.strokeRect(r.x, r.y, r.w, r.h);
                ctx.setLineDash([]);
                if (r.isSkip) ctx.restore();
            });

            // Pass 2: overlay text (รองรับ vertical align — อ้างอิง Ketchup TableTool)
            overlayRenders.forEach(r => {
                if (!r.layout.lines.length) return;
                ctx.save();
                ctx.beginPath();
                ctx.rect(r.x, r.y, r.w, r.h);
                ctx.clip();
                ctx.font = `${r.layout.fontSize}px ${TEXTBOX_FONT_FAMILY}`;
                ctx.fillStyle = COLORS.text;
                ctx.textBaseline = "alphabetic";
                ctx.textAlign = "left";
                // vertical align: top (default) / middle / bottom — clip ป้องกัน text ทะลุกล่อง
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

            // Pass 3: normal-mode bbox + label
            ctx.lineWidth = 2;
            ctx.font = "11px ui-monospace, Menlo, monospace";
            normalRenders.forEach(r => {
                const { x, y, w, h, color, tr, wasCorrected, item: it } = r;
                const sp = it.self_ref ? state.speakerByRef[it.self_ref] : null;
                const isSkip = sp === SPEAKER_SKIP;
                // SKIP → จาง (alpha 0.35) ทั้ง bbox + label เพื่อบอกว่ายกเว้น
                if (isSkip) ctx.save(), ctx.globalAlpha = 0.35;
                ctx.strokeStyle = color;
                ctx.lineWidth = wasCorrected ? 3 : 2;
                ctx.fillStyle = wasCorrected ? COLORS.warningBgAlpha : color + "22";
                ctx.fillRect(x, y, w, h);
                ctx.strokeRect(x, y, w, h);
                ctx.lineWidth = 2;
                if (showLabels.checked) {
                    let spTag = "";
                    if (isSkip) spTag = "🚫 ";
                    else if (sp) spTag = `👤${sp} `;
                    const tag = (tr ? "🌐 " : (wasCorrected ? "✨ " : "")) + spTag;
                    const lbl = tag + it.label;
                    ctx.fillStyle = tr ? COLORS.primaryStrong : (wasCorrected ? COLORS.warning : color);
                    ctx.fillRect(x, Math.max(0, y - 14), Math.min(160, w), 14);
                    ctx.fillStyle = COLORS.textInverse;
                    ctx.fillText(lbl, x + 4, Math.max(11, y - 3));
                }
                if (isSkip) ctx.restore();
            });

            // === Selection highlights + handles ===
            if (sel.refs.size) {
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 4]);
                sel.refs.forEach(ref => {
                    const sd = drawn.find(d => d.item.self_ref === ref);
                    if (!sd) return;
                    ctx.strokeStyle = ref === sel.ref ? COLORS.primary : COLORS.multiSelect;
                    ctx.strokeRect(sd.x, sd.y, sd.w, sd.h);
                });
                ctx.setLineDash([]);
            }
            if (sel.ref) {
                const selDrawn = drawn.find(d => d.item.self_ref === sel.ref);
                if (selDrawn) _drawHandles(ctx, selDrawn);
            }

            // === Marquee overlay ===
            const mq = state.marquee;
            if (mq) {
                const mx = Math.min(mq.startX, mq.endX);
                const my = Math.min(mq.startY, mq.endY);
                const mw = Math.abs(mq.endX - mq.startX);
                const mh = Math.abs(mq.endY - mq.startY);
                ctx.save();
                ctx.strokeStyle = COLORS.marquee;
                ctx.fillStyle = COLORS.marqueeFill;
                ctx.lineWidth = 1;
                ctx.setLineDash([5, 5]);
                ctx.fillRect(mx, my, mw, mh);
                ctx.strokeRect(mx, my, mw, mh);
                ctx.setLineDash([]);
                ctx.restore();
            }
            wrap._drawn = drawn;
            window._previewWrap = wrap;
        };
        wrap._redraw = doDraw;
        doDraw();

        wrap.style.cursor = "default";

        wrap.onmousemove = (ev) => {
            const rect = wrap.getBoundingClientRect();
            const px = ev.clientX - rect.left;
            const py = ev.clientY - rect.top;

            // === MARQUEE — live add/remove ตามลำดับโดน ===
            const mq = getMarquee();
            if (mq) {
                mq.endX = px;
                mq.endY = py;
                const dx = mq.endX - mq.startX;
                const dy = mq.endY - mq.startY;
                if (Math.abs(dx) >= DRAG_THRESHOLD || Math.abs(dy) >= DRAG_THRESHOLD) {
                    state.justDragged = true;
                }
                const x1 = Math.min(mq.startX, mq.endX);
                const y1 = Math.min(mq.startY, mq.endY);
                const x2 = Math.max(mq.startX, mq.endX);
                const y2 = Math.max(mq.startY, mq.endY);
                drawn.forEach(d => {
                    if (!d.item.self_ref) return;
                    const ref = d.item.self_ref;
                    const inside = d.x < x2 && d.x + d.w > x1 && d.y < y2 && d.y + d.h > y1;
                    const wasInitial = mq.initialSelection.has(ref);
                    if (inside && !sel.refs.has(ref)) {
                        sel.refs.add(ref);
                        sel.ref = ref;
                    } else if (!inside && sel.refs.has(ref) && !wasInitial) {
                        sel.refs.delete(ref);
                        if (sel.ref === ref) sel.ref = [...sel.refs].pop() || null;
                    }
                });
                _updateMergeButton();
                _syncAlignToolbar();
                tooltip.style.display = "none";
                doDraw();
                return;
            }

            // === DRAGGING ===
            const dr = getDrag();
            if (dr) {
                const dx = px - dr.startX;
                const dy = py - dr.startY;
                if (!dr.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
                dr.moved = true;
                state.justDragged = true;
                tooltip.style.display = "none";
                const sb = dr.startBox;
                const ov = state.bboxOverrides[dr.ref] = state.bboxOverrides[dr.ref] || {};
                if (dr.mode === "move") {
                    ov.x = sb.x + dx;
                    ov.y = sb.y + dy;
                    ov.w = sb.w;
                    ov.h = sb.h;
                } else {
                    let nx = sb.x, ny = sb.y, nw = sb.w, nh = sb.h;
                    if (dr.mode.includes("w")) { nx = sb.x + dx; nw = sb.w - dx; }
                    if (dr.mode.includes("e")) { nw = sb.w + dx; }
                    if (dr.mode.includes("n")) { ny = sb.y + dy; nh = sb.h - dy; }
                    if (dr.mode.includes("s")) { nh = sb.h + dy; }
                    if (nw < MIN_BOX) { nx = sb.x + sb.w - MIN_BOX; nw = MIN_BOX; }
                    if (nh < MIN_BOX) { ny = sb.y + sb.h - MIN_BOX; nh = MIN_BOX; }
                    ov.x = nx; ov.y = ny; ov.w = nw; ov.h = nh;
                }
                doDraw();
                return;
            }

            // === Hover cursor ===
            let cur = "default";
            if (sel.ref) {
                const selDrawn = drawn.find(d => d.item.self_ref === sel.ref);
                if (selDrawn) {
                    const handle = _hitHandle(selDrawn, px, py);
                    if (handle) {
                        const map = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
                                      nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" };
                        cur = map[handle] || "default";
                    }
                }
            }
            if (cur === "default") {
                const overItem = [...drawn].reverse().find(d =>
                    px >= d.x && px <= d.x + d.w && py >= d.y && py <= d.y + d.h
                );
                cur = overItem ? "move" : "default";
            }
            wrap.style.cursor = cur;

            // === Hover tooltip ===
            const overlayModeNow = document.getElementById("showOverlay").checked;
            const hit = [...drawn].reverse().find(d =>
                px >= d.x && px <= d.x + d.w && py >= d.y && py <= d.y + d.h
            );
            if (!hit) {
                tooltip.style.display = "none";
                return;
            }
            const ref = hit.item.self_ref;
            const corr = ref ? state.corrections[ref] : undefined;
            const tr = ref ? state.translations[ref] : undefined;
            const esc = escapeHtml;  // alias สั้น
            let html = "";

            if (overlayModeNow) {
                if (!tr) {
                    tooltip.style.display = "none";
                    return;
                }
                const origText = (corr !== undefined ? corr : hit.item.text) || "";
                html =
                    `<div style="color:${COLORS.primaryLight};">${esc(tr)}</div>` +
                    `<div style="border-top:1px solid ${COLORS.divider}; margin:6px 0;"></div>` +
                    `<div style="opacity:.85;">${esc(origText)}</div>`;
            } else {
                if (corr !== undefined && corr.trim() !== (hit.item.text || "").trim()) {
                    const ops = diffChars(hit.item.text || "", corr);
                    html =
                        `<div style="opacity:.7; font-size:11px; margin-bottom:4px;">[${esc(hit.item.label)}] OCR:</div>` +
                        `<div>${renderDiffSide(ops, "orig")}</div>` +
                        `<div style="opacity:.7; font-size:11px; margin:6px 0 4px;">✨ corrected:</div>` +
                        `<div>${renderDiffSide(ops, "corr")}</div>`;
                } else if (corr !== undefined) {
                    html = `<div style="opacity:.7; font-size:11px; margin-bottom:4px;">[${esc(hit.item.label)}] ✓ no change</div>` + esc(corr);
                } else {
                    html = `<div style="opacity:.7; font-size:11px; margin-bottom:4px;">[${esc(hit.item.label)}]</div>` + esc(hit.item.text || "");
                }
                if (tr) {
                    html +=
                        `<div style="opacity:.7; font-size:11px; margin:8px 0 4px;">🌐 translation:</div>` +
                        `<div style="color:${COLORS.primaryLight};">${esc(tr)}</div>`;
                }
            }
            tooltip.style.display = "block";
            tooltip.style.left = (px + 12) + "px";
            tooltip.style.top = (py + 12) + "px";
            tooltip.innerHTML = html;
        };

        wrap.onmouseleave = () => tooltip.style.display = "none";

        // === mousedown: เริ่ม drag/marquee ===
        wrap.onmousedown = (ev) => {
            if (ev.button !== 0) return;
            state.justDragged = false;
            const rect = wrap.getBoundingClientRect();
            const px = ev.clientX - rect.left;
            const py = ev.clientY - rect.top;
            // 1) handle ของกล่องที่ active อยู่ก่อน
            if (sel.ref && !ev.shiftKey) {
                const selDrawn = drawn.find(d => d.item.self_ref === sel.ref);
                if (selDrawn) {
                    const handle = _hitHandle(selDrawn, px, py);
                    if (handle) {
                        ev.preventDefault();
                        setDrag({
                            ref: sel.ref, mode: handle,
                            startX: px, startY: py,
                            startBox: { x: selDrawn.x, y: selDrawn.y, w: selDrawn.w, h: selDrawn.h },
                            beforeOv: _clone(state.bboxOverrides[sel.ref]),
                        });
                        wrap.classList.add("dragging");
                        return;
                    }
                }
            }
            // 2) คลิกในกล่อง
            const hit = [...drawn].reverse().find(d =>
                px >= d.x && px <= d.x + d.w && py >= d.y && py <= d.y + d.h
            );
            if (hit) {
                ev.preventDefault();
                ev.stopPropagation();
                _toggleSelectAndButton(hit.item.self_ref, ev.shiftKey);
                if (!ev.shiftKey && sel.ref) {
                    setDrag({
                        ref: sel.ref, mode: "move",
                        startX: px, startY: py,
                        startBox: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
                        beforeOv: _clone(state.bboxOverrides[sel.ref]),
                    });
                    wrap.classList.add("dragging");
                }
                doDraw();
            } else {
                // 3) คลิกที่ว่าง → เริ่ม marquee
                if (!ev.shiftKey && (sel.ref || sel.refs.size)) {
                    _clearSelectionAndButton();
                    doDraw();
                }
                setMarquee({
                    startX: px, startY: py,
                    endX: px, endY: py,
                    additive: ev.shiftKey,
                    initialSelection: new Set(sel.refs),
                });
            }
        };

        wrap.onmouseup = () => {
            if (getMarquee()) {
                setMarquee(null);
                doDraw();
                return;
            }
            const dr = getDrag();
            if (dr) {
                // ถ้า drag จริง → push UpdateBboxCmd ลง history (do() reapply เป็น no-op, undo() คืนค่า)
                if (dr.moved) {
                    const afterOv = _clone(state.bboxOverrides[dr.ref]);
                    const desc = dr.mode === "move" ? "Move bbox" : "Resize bbox";
                    history.exec(new UpdateBboxCmd(dr.ref, dr.beforeOv, afterOv, desc));
                }
                setDrag(null);
                wrap.classList.remove("dragging");
                doDraw();
            }
        };

        // safety net — ปล่อยเมาส์นอก wrap ก็ commit
        if (window._previewDocMouseUp) {
            document.removeEventListener("mouseup", window._previewDocMouseUp);
        }
        window._previewDocMouseUp = (e) => {
            if (getDrag() || getMarquee()) wrap.onmouseup(e);
        };
        document.addEventListener("mouseup", window._previewDocMouseUp);

        wrap.onclick = (ev) => {
            if (state.justDragged) {
                state.justDragged = false;
                return;
            }
            const rect = wrap.getBoundingClientRect();
            const px = ev.clientX - rect.left;
            const py = ev.clientY - rect.top;
            const hit = [...drawn].reverse().find(d =>
                px >= d.x && px <= d.x + d.w && py >= d.y && py <= d.y + d.h
            );
            if (hit && !ev.shiftKey) {
                ev.stopPropagation();
                showBboxSpeakerPopup(hit, ev.clientX, ev.clientY);
            }
        };
    };
    img.src = page.image;
}

// canvas-only redraw ผ่าน wrap closure — กัน flicker
export function redrawOnly() {
    return (window._previewWrap?._redraw || renderPreview)();
}

// ─────────────────────────────────────────────────────────
// Edit toolbar wiring (font, align, reset, merge)
// ─────────────────────────────────────────────────────────

export function setupEditMode() {
    const fontInc = document.getElementById("fontIncBtn");
    const fontDec = document.getElementById("fontDecBtn");
    const alignL  = document.getElementById("alignLeftBtn");
    const alignC  = document.getElementById("alignCenterBtn");
    const alignR  = document.getElementById("alignRightBtn");
    const valignT = document.getElementById("valignTopBtn");
    const valignM = document.getElementById("valignMiddleBtn");
    const valignB = document.getElementById("valignBottomBtn");
    const resetBtn = document.getElementById("resetBboxBtn");
    const mergeBtn = document.getElementById("mergeSelectedBtn");
    const undoBtn = document.getElementById("undoBtn");
    const redoBtn = document.getElementById("redoBtn");

    // undo/redo button state sync + canvas/table refresh หลัง history เปลี่ยน
    const _syncUndoButtons = () => {
        if (undoBtn) undoBtn.disabled = !history.canUndo();
        if (redoBtn) redoBtn.disabled = !history.canRedo();
    };
    history.onChange(() => {
        _syncUndoButtons();
        _syncAlignToolbar();
        // guard กับ history.clear() ตอน upload (lastResult เป็น null)
        if (!state.lastResult) return;
        if (document.querySelector(".tab.active")?.dataset.tab === "visual") redrawOnly();
        window.buildCompareTable?.(true);
    });
    _syncUndoButtons();

    undoBtn?.addEventListener("click", () => history.undo());
    redoBtn?.addEventListener("click", () => history.redo());

    // ⌘Z / Ctrl+Z = undo, ⌘⇧Z / Ctrl+Y = redo — skip ถ้า focus อยู่ใน input/textarea/cell
    document.addEventListener("keydown", (e) => {
        const tag = (e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
        const mod = e.metaKey || e.ctrlKey;
        if (!mod) return;
        if (e.key === "z" && !e.shiftKey) {
            e.preventDefault();
            history.undo();
        } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
            e.preventDefault();
            history.redo();
        }
    });

    mergeBtn?.addEventListener("click", mergeSelectedBoxes);

    // รวม UpdateBboxCmd หลายตัว (multi-bbox edit) → 1 history entry เมื่อ refs > 1
    function _execMultiBbox(refs, mapFn, desc) {
        const cmds = refs.map(mapFn).filter(Boolean);
        if (!cmds.length) return;
        const cmd = cmds.length === 1
            ? cmds[0]
            : new CompositeCommand(cmds, `${desc} (×${cmds.length})`);
        history.exec(cmd);
        redrawOnly();
    }

    function _adjustFont(delta) {
        const refs = [...sel.refs];
        if (!refs.length) return;
        _execMultiBbox(refs, (ref) => {
            const before = _clone(state.bboxOverrides[ref]);
            const cur = before || {};
            const selDrawn = (window._previewWrap?._drawn || []).find(d => d.item.self_ref === ref);
            // ลำดับความสำคัญ: override ปัจจุบัน > font ที่แสดงจริงใน drawn[] > เดาจาก h
            const curSize = cur.fontSize
                || selDrawn?.fontSize
                || (selDrawn ? Math.min(Math.max(Math.floor(selDrawn.h * 0.65), 7), 22) : 14);
            const after = { ...cur, fontSize: Math.max(7, Math.min(64, Math.round(curSize) + delta)) };
            return new UpdateBboxCmd(ref, before, after, "Adjust font");
        }, "Adjust font");
    }
    function _setAlign(a) {
        const refs = [...sel.refs];
        if (!refs.length) return;
        _execMultiBbox(refs, (ref) => {
            const before = _clone(state.bboxOverrides[ref]);
            const after = { ...(before || {}), align: a };
            return new UpdateBboxCmd(ref, before, after, "Align text");
        }, "Align text");
        _syncAlignToolbar();
    }
    function _setValign(v) {
        const refs = [...sel.refs];
        if (!refs.length) return;
        _execMultiBbox(refs, (ref) => {
            const before = _clone(state.bboxOverrides[ref]);
            const after = { ...(before || {}), valign: v };
            return new UpdateBboxCmd(ref, before, after, "Vertical align");
        }, "Vertical align");
        _syncAlignToolbar();
    }

    fontInc.addEventListener("click", () => _adjustFont(+2));
    fontDec.addEventListener("click", () => _adjustFont(-2));
    alignL.addEventListener("click",  () => _setAlign("left"));
    alignC.addEventListener("click",  () => _setAlign("center"));
    alignR.addEventListener("click",  () => _setAlign("right"));
    valignT.addEventListener("click", () => _setValign("top"));
    valignM.addEventListener("click", () => _setValign("middle"));
    valignB.addEventListener("click", () => _setValign("bottom"));
    resetBtn.addEventListener("click", () => {
        const refs = [...sel.refs];
        if (!refs.length) return;
        _execMultiBbox(refs, (ref) => {
            const before = _clone(state.bboxOverrides[ref]);
            if (before === undefined) return null;  // ไม่มี override → ไม่ต้อง push
            return new UpdateBboxCmd(ref, before, undefined, "Reset bbox");
        }, "Reset bbox");
        _syncAlignToolbar();
    });
}
