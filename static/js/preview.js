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
import { getCharacters, renderSpeakerOptions, SPEAKER_SKIP, SPEAKER_AUTO } from "./characters.js";
import { COLORS } from "./colors.js";
import * as viewport from "./visual/viewport.js";
import { getImageSrc } from "./visual/image-source.js";
import { SpatialGrid } from "./visual/spatial-grid.js";
import { getTool } from "./visual/tool-mode.js";
import { updateInspector } from "./visual/inspector.js";

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
    updateInspector();
    window._beforePaneRedraw?.();   // sync red highlight on left pane
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
    updateInspector();
    window._beforePaneRedraw?.();   // sync red highlight on left pane
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

function _getRotation(ref) {
    const ov = state.bboxOverrides[ref];
    return (ov && typeof ov.rotation === "number") ? ov.rotation : 0;
}

// inverse-rotate world point → box-local frame (axis-aligned) รอบ center
function _worldToBoxLocal(box, rotDeg, px, py) {
    if (!rotDeg) return { x: px, y: py };
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const rad = -rotDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = px - cx, dy = py - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// forward-rotate local point → world (รอบ center)
function _boxLocalToWorld(box, rotDeg, lx, ly) {
    if (!rotDeg) return { x: lx, y: ly };
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const rad = rotDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = lx - cx, dy = ly - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// AABB ของ rotated box — ใช้ใน SpatialGrid + marquee
function _aabbOfRotated(box, rotDeg) {
    if (!rotDeg) return { x: box.x, y: box.y, w: box.w, h: box.h };
    const corners = [
        [box.x, box.y], [box.x + box.w, box.y],
        [box.x + box.w, box.y + box.h], [box.x, box.y + box.h],
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lx, ly] of corners) {
        const w = _boxLocalToWorld(box, rotDeg, lx, ly);
        if (w.x < minX) minX = w.x;
        if (w.y < minY) minY = w.y;
        if (w.x > maxX) maxX = w.x;
        if (w.y > maxY) maxY = w.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function _hitRotatedBox(box, rotDeg, px, py) {
    const lp = _worldToBoxLocal(box, rotDeg, px, py);
    return lp.x >= box.x && lp.x <= box.x + box.w &&
           lp.y >= box.y && lp.y <= box.y + box.h;
}

function _hitHandle(box, px, py, zoom = 1, rotDeg = 0) {
    // hit-test ทำใน local frame — inverse-rotate point ก่อน
    const hs = HANDLE_SIZE / Math.max(0.01, zoom);
    const lp = _worldToBoxLocal(box, rotDeg, px, py);
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
        if (Math.abs(lp.x - h.cx) <= hs && Math.abs(lp.y - h.cy) <= hs) return h.name;
    }
    return null;
}

function _drawHandles(ctx, box, zoom = 1, rotDeg = 0) {
    // ctx มี setTransform(zoom*dpr,...) อยู่ → handle ต้องคง HANDLE_SIZE screen px
    const z = Math.max(0.01, zoom);
    const hs = HANDLE_SIZE / z;
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
    ctx.save();
    if (rotDeg) {
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        ctx.translate(cx, cy);
        ctx.rotate(rotDeg * Math.PI / 180);
        ctx.translate(-cx, -cy);
    }
    ctx.fillStyle = COLORS.textInverse;
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = 2 / z;
    for (const [px, py] of pts) {
        ctx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
        ctx.strokeRect(px - hs / 2, py - hs / 2, hs, hs);
    }
    ctx.restore();
}

// rotation handle อยู่ใต้ box (local frame) — offset 28 screen px
function _rotationHandleLocalPos(box, zoom) {
    const offset = 28 / Math.max(0.01, zoom);
    return { x: box.x + box.w / 2, y: box.y + box.h + offset };
}

function _rotationHandleWorldPos(box, rotDeg, zoom) {
    const local = _rotationHandleLocalPos(box, zoom);
    return _boxLocalToWorld(box, rotDeg, local.x, local.y);
}

function _hitRotationHandle(box, rotDeg, px, py, zoom) {
    const z = Math.max(0.01, zoom);
    const pos = _rotationHandleWorldPos(box, rotDeg, z);
    const r = 11 / z;     // hit area larger กว่า visual radius
    return Math.hypot(px - pos.x, py - pos.y) <= r;
}

// Material Symbols "rotate_right" SVG path (24x24 viewBox) — เข้ากันกับ
// Material Symbols Outlined ที่ใช้ใน HTML toolbar icons (loaded via Google Fonts)
const _ROTATE_ICON_SVG_D = "M15.55,5.55L11,1v3.07C7.06,4.56,4,7.92,4,12s3.05,7.44,7,7.93v-2.02c-2.84-0.48-5-2.94-5-5.91s2.16-5.43,5-5.91V10l4.55-4.45z M19.93,11c-0.17-1.39-0.72-2.73-1.62-3.89l-1.42,1.42c0.54,0.75,0.88,1.6,1.02,2.47H19.93z M13,17.9v2.02c1.39-0.17,2.74-0.71,3.9-1.61l-1.44-1.44C14.71,17.4,13.87,17.74,13,17.9z M16.89,15.48l1.42,1.41c0.9-1.16,1.45-2.5,1.62-3.89h-2.02C17.77,13.88,17.43,14.73,16.89,15.48z";
let _rotateIconPath = null;
function _getRotateIconPath() {
    if (!_rotateIconPath) _rotateIconPath = new Path2D(_ROTATE_ICON_SVG_D);
    return _rotateIconPath;
}

function _drawRotationHandle(ctx, box, rotDeg, zoom) {
    const z = Math.max(0.01, zoom);
    const local = _rotationHandleLocalPos(box, z);
    const r = 7 / z;
    const lw = 1.5 / z;
    ctx.save();
    if (rotDeg) {
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        ctx.translate(cx, cy);
        ctx.rotate(rotDeg * Math.PI / 180);
        ctx.translate(-cx, -cy);
    }
    // connector line จากขอบล่างของ box → handle
    ctx.beginPath();
    ctx.moveTo(local.x, box.y + box.h);
    ctx.lineTo(local.x, local.y - r);
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = lw;
    ctx.stroke();
    // วงกลม handle (background ขาว)
    ctx.beginPath();
    ctx.arc(local.x, local.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.textInverse;
    ctx.fill();
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = lw;
    ctx.stroke();
    // SVG icon — Material Symbols rotate_right path (24x24) scaled ลง 80% ของ handle
    const iconSize = r * 1.55;
    const scale = iconSize / 24;
    ctx.save();
    ctx.translate(local.x - iconSize / 2, local.y - iconSize / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle = COLORS.primary;
    ctx.fill(_getRotateIconPath());
    ctx.restore();
    ctx.restore();
}

// snap องศาตอนหมุน: 0° dead zone ±3° (= แม่นยำตอน reset orientation),
// shift = snap ทุก 15° (ทำตอน user holding shift)
const ROT_ZERO_SNAP_DEG = 3;
const ROT_SHIFT_STEP_DEG = 15;
function _snapRotation(deg, shiftHeld) {
    // normalize → -180..180
    let d = ((deg % 360) + 540) % 360 - 180;
    if (shiftHeld) {
        d = Math.round(d / ROT_SHIFT_STEP_DEG) * ROT_SHIFT_STEP_DEG;
    } else if (Math.abs(d) <= ROT_ZERO_SNAP_DEG) {
        d = 0;
    }
    return d;
}

// ── floating angle badge ── แสดงองศาตอนหมุน (Canva-style)
let _rotateBadge = null;
function _showRotateBadge(clientX, clientY, deg, snapped) {
    if (!_rotateBadge) {
        _rotateBadge = document.createElement("div");
        _rotateBadge.style.cssText =
            "position:fixed; z-index:9999; pointer-events:none; " +
            "background:rgba(17,24,39,.92); color:#fff; " +
            "padding:4px 8px; border-radius:6px; font:600 12px ui-monospace,Menlo,monospace; " +
            "white-space:nowrap;";
        document.body.appendChild(_rotateBadge);
    }
    const rounded = Math.round(deg);
    _rotateBadge.textContent = `${rounded}°${snapped ? "  ⌖" : ""}`;
    _rotateBadge.style.background = snapped ? "rgba(37,99,235,.95)" : "rgba(17,24,39,.92)";
    _rotateBadge.style.left = (clientX + 16) + "px";
    _rotateBadge.style.top = (clientY + 16) + "px";
    _rotateBadge.style.display = "block";
}
function _hideRotateBadge() {
    if (_rotateBadge) _rotateBadge.style.display = "none";
}

// ─────────────────────────────────────────────────────────
// Speaker popup
// ─────────────────────────────────────────────────────────

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

// cleanup ของ wrap รอบที่แล้ว — เรียกก่อน mount ใหม่ ไม่งั้น ResizeObserver,
// viewport.onChange unsubscribe, document mouseup listener สะสมทุก re-render
function _cleanupPreviewArea() {
    const oldWrap = window._previewWrap;
    if (oldWrap) {
        oldWrap._unsubscribeViewport?.();
        oldWrap._resizeObserver?.disconnect?.();
        oldWrap.onmousemove = null;
        oldWrap.onmousedown = null;
        oldWrap.onmouseup   = null;
        oldWrap.onmouseleave = null;
        oldWrap.onclick     = null;
        oldWrap._unsubscribeViewport = null;
        oldWrap._resizeObserver = null;
        oldWrap._redraw = null;
    }
    if (window._previewDocMouseUp) {
        document.removeEventListener("mouseup", window._previewDocMouseUp);
        window._previewDocMouseUp = null;
    }
    window._previewWrap = null;
    // bounds เก่าใช้กับ page ปัจจุบันไม่ได้แล้ว — clear เพื่อ panBy/zoomAt no-op จนกว่า render รอบใหม่ติด bounds
    viewport.clearBounds();
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
    const imgSrc = page ? getImageSrc(page) : null;
    if (!page || !imgSrc) {
        _cleanupPreviewArea();
        previewArea.innerHTML = '<div class="empty">No image for this page.</div>';
        return;
    }

    const showTexts = document.getElementById("showTexts");
    const showTables = document.getElementById("showTables");
    const showPictures = document.getElementById("showPictures");
    const showLabels = document.getElementById("showLabels");

    // cleanup ของ wrap รอบที่แล้ว (กัน ResizeObserver + viewport listener + mouseup listener leak)
    _cleanupPreviewArea();
    previewArea.innerHTML = "";
    // Ketchup-style canvas — fill pane (CSS size), DPR-aware backing store.
    // World transform applied per-frame via ctx.setTransform — no CSS transform.
    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap";
    wrap.style.position = "absolute";
    wrap.style.top = "0"; wrap.style.left = "0";
    wrap.style.width = "100%"; wrap.style.height = "100%";
    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.top = "0"; canvas.style.left = "0";
    canvas.style.display = "block";
    const tooltip = document.createElement("div");
    tooltip.className = "tooltip";
    wrap.appendChild(canvas); wrap.appendChild(tooltip);
    previewArea.appendChild(wrap);

    const imgW = page.img_width || page.width || 1;
    const imgH = page.img_height || page.height || 1;
    const pageW = page.width || imgW;
    const pageH = page.height || imgH;
    const sx = imgW / pageW;
    const sy = imgH / pageH;
    const dispW = imgW;
    const dispH = imgH;

    const bgImg = new Image();
    bgImg.src = imgSrc;

    const dpr = window.devicePixelRatio || 1;
    function _resizeCanvas() {
        const r = previewArea.getBoundingClientRect();
        canvas.width = Math.max(1, Math.floor(r.width * dpr));
        canvas.height = Math.max(1, Math.floor(r.height * dpr));
        canvas.style.width = r.width + "px";
        canvas.style.height = r.height + "px";
        viewport.setViewportSize(r.width, r.height);
    }
    viewport.setContentSize(imgW, imgH);
    _resizeCanvas();

    // setup viewport-driven redraw (rAF coalesced)
    let _redrawScheduled = false;
    const requestRedraw = () => {
        if (_redrawScheduled) return;
        _redrawScheduled = true;
        requestAnimationFrame(() => {
            _redrawScheduled = false;
            if (wrap._redraw) wrap._redraw();
        });
    };
    const unsubscribeViewport = viewport.onChange(requestRedraw);
    wrap._unsubscribeViewport = unsubscribeViewport;

    // ResizeObserver — pane size changes → resize canvas + redraw
    const ro = new ResizeObserver(() => { _resizeCanvas(); requestRedraw(); });
    ro.observe(previewArea);
    wrap._resizeObserver = ro;

    // ── main render: run synchronously (no img.onload await) ──
    {

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

            // === clear + apply viewport transform (Ketchup pattern) ===
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            // world → device pixel: scale = zoom * dpr; pan = pan * dpr
            viewport.applyToCanvasCtx(ctx, dpr);

            if (bgImg.complete && bgImg.naturalWidth) {
                ctx.drawImage(bgImg, 0, 0, imgW, imgH);
            } else {
                bgImg.onload = requestRedraw;
            }

            // bbox stroke width — keep constant on screen (= 2 px) ผ่าน /zoom adjust
            const z = viewport.getZoom() || 1;
            ctx.lineWidth = 2 / z;
            ctx.font = `${11 / z}px ui-monospace, Menlo, monospace`;

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
                // fallback = binary-search หาขนาดใหญ่สุดที่ "text ทั้งหมด fit ใน bbox"
                // — heuristic เดิม (height/lines × 0.7) เดาผิดบ่อย เพราะ docling ส่ง text บางที
                // join เป็นบรรทัดเดียว (ไม่มี \n) ทำให้คิดว่าเป็น 1 บรรทัดและคำนวณเป็น font ใหญ่
                // binary search กับ Pretext layout (C-fast) → 5-7 iterations, ~1ms ต่อ item
                const innerW = Math.max(origW - 8, 1);
                const innerH = Math.max(origH - 8, 1);
                let fallbackFontSize = 14;
                if (origW > 8 && origH > 8 && (it.text || "").trim()) {
                    let lo = 8, hi = 36;
                    while (lo < hi) {
                        const mid = Math.ceil((lo + hi) / 2);
                        const probe = measureTextInBox(ctx, it.text, origW, { fixedFontSize: mid });
                        if (probe && probe.requiredH <= innerH) lo = mid;
                        else hi = mid - 1;
                    }
                    fallbackFontSize = lo;
                }
                const ocrFontSize = it.font_size ? it.font_size * sy : 0;
                const effectiveFontSize = ov.fontSize || ocrFontSize || fallbackFontSize;

                const overlayText = tr || corr || (it.text || "");
                const rotation = (typeof ov.rotation === "number") ? ov.rotation : 0;
                if (overlayMode && isSkip) {
                    // SKIP ใน overlay mode → ไม่วาดอะไรเลย (ไม่มี bbox, ไม่มี fade)
                    // เหลือแต่ภาพต้นฉบับด้านล่างให้เห็น — เก็บ drawn ไว้สำหรับ hit-test เผื่อ user คลิก
                    drawn.push({ x, y, w, h, item: it, fontSize: effectiveFontSize, rotation });
                    return;
                }
                if (overlayMode && overlayText) {
                    const layout = measureTextInBox(ctx, overlayText, w, {
                        fixedFontSize: ov.fontSize,
                        ocrFontSize,
                        fallbackFontSize,
                    });
                    if (!layout) {
                        normalRenders.push({ x, y, w, h, color, corr, tr, wasCorrected, item: it, rotation });
                        drawn.push({ x, y, w, h, item: it, fontSize: effectiveFontSize, rotation });
                        return;
                    }
                    overlayRenders.push({ x, y, w, h, tr: overlayText, layout, align: ov.align || "left", valign: ov.valign || "top", isTranslated: !!tr, item: it, rotation });
                    drawn.push({ x, y, w, h, item: it, fontSize: layout.fontSize, rotation });
                    return;
                }
                normalRenders.push({ x, y, w, h, color, corr, tr, wasCorrected, item: it, rotation });
                drawn.push({ x, y, w, h, item: it, fontSize: effectiveFontSize, rotation });
            });

            // Pass 1: overlay backgrounds + borders (rotation transform per-box)
            overlayRenders.forEach(r => {
                const ov = state.bboxOverrides[r.item.self_ref] || {};
                ctx.save();
                if (r.rotation) {
                    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
                    ctx.translate(cx, cy);
                    ctx.rotate(r.rotation * Math.PI / 180);
                    ctx.translate(-cx, -cy);
                }
                ctx.fillStyle = ov.bgColor || r.item.bg_color || COLORS.overlayBg;
                ctx.fillRect(r.x, r.y, r.w, r.h);
                if (!state.previewMode) {
                    ctx.strokeStyle = r.isTranslated ? COLORS.primaryStrong : COLORS.borderMuted;
                    ctx.lineWidth = 1 / z;
                    if (!r.isTranslated) ctx.setLineDash([4 / z, 3 / z]);
                    ctx.strokeRect(r.x, r.y, r.w, r.h);
                    ctx.setLineDash([]);
                }
                ctx.restore();
            });

            // Pass 2: overlay text (รองรับ vertical align — อ้างอิง Ketchup TableTool)
            overlayRenders.forEach(r => {
                if (!r.layout.lines.length) return;
                ctx.save();
                if (r.rotation) {
                    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
                    ctx.translate(cx, cy);
                    ctx.rotate(r.rotation * Math.PI / 180);
                    ctx.translate(-cx, -cy);
                }
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

            // Pass 3: normal-mode bbox + label (rotation transform per-box)
            // preview mode = หน้าที่วางคำแปลแล้ว — ซ่อน debug bbox/label ของ region ที่ไม่ได้แปล
            ctx.lineWidth = 2 / z;
            ctx.font = `${11 / z}px ui-monospace, Menlo, monospace`;
            if (!state.previewMode) normalRenders.forEach(r => {
                const { x, y, w, h, color, tr, wasCorrected, item: it } = r;
                const sp = it.self_ref ? state.speakerByRef[it.self_ref] : null;
                const isSkip = sp === SPEAKER_SKIP;
                ctx.save();
                if (r.rotation) {
                    const cx = x + w / 2, cy = y + h / 2;
                    ctx.translate(cx, cy);
                    ctx.rotate(r.rotation * Math.PI / 180);
                    ctx.translate(-cx, -cy);
                }
                if (isSkip) ctx.globalAlpha = 0.35;
                ctx.strokeStyle = color;
                ctx.lineWidth = (wasCorrected ? 3 : 2) / z;
                ctx.fillStyle = wasCorrected ? COLORS.warningBgAlpha : color + "22";
                ctx.fillRect(x, y, w, h);
                ctx.strokeRect(x, y, w, h);
                if (showLabels.checked) {
                    let spTag = "";
                    if (isSkip) spTag = "🚫 ";
                    else if (sp) spTag = `👤${sp} `;
                    // เก็บแค่ status icons (🌐/✨/🚫/👤) — ตัด it.label ออก ("text" ไม่มีประโยชน์)
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
                }
                ctx.restore();
            });

            // === Selection highlights + handles (rotation-aware) ===
            if (!state.previewMode && sel.refs.size) {
                sel.refs.forEach(ref => {
                    const sd = drawn.find(d => d.item.self_ref === ref);
                    if (!sd) return;
                    ctx.save();
                    if (sd.rotation) {
                        const cx = sd.x + sd.w / 2, cy = sd.y + sd.h / 2;
                        ctx.translate(cx, cy);
                        ctx.rotate(sd.rotation * Math.PI / 180);
                        ctx.translate(-cx, -cy);
                    }
                    ctx.lineWidth = 2 / z;
                    ctx.setLineDash([6 / z, 4 / z]);
                    ctx.strokeStyle = ref === sel.ref ? COLORS.primary : COLORS.multiSelect;
                    ctx.strokeRect(sd.x, sd.y, sd.w, sd.h);
                    ctx.setLineDash([]);
                    ctx.restore();
                });
            }
            if (!state.previewMode && sel.ref) {
                const selDrawn = drawn.find(d => d.item.self_ref === sel.ref);
                if (selDrawn) {
                    const zNow = viewport.getZoom();
                    _drawHandles(ctx, selDrawn, zNow, selDrawn.rotation || 0);
                    _drawRotationHandle(ctx, selDrawn, selDrawn.rotation || 0, zNow);
                }
            }

            // === Marquee overlay ===
            const mq = state.marquee;
            if (mq && !state.previewMode) {
                const mx = Math.min(mq.startX, mq.endX);
                const my = Math.min(mq.startY, mq.endY);
                const mw = Math.abs(mq.endX - mq.startX);
                const mh = Math.abs(mq.endY - mq.startY);
                ctx.save();
                ctx.strokeStyle = COLORS.marquee;
                ctx.fillStyle = COLORS.marqueeFill;
                ctx.lineWidth = 1 / z;
                ctx.setLineDash([5 / z, 5 / z]);
                ctx.fillRect(mx, my, mw, mh);
                ctx.strokeRect(mx, my, mw, mh);
                ctx.setLineDash([]);
                ctx.restore();
            }
            wrap._drawn = drawn;
            // SpatialGrid — rebuild ทุก doDraw. Insert AABB ของ rotated box (กว้างกว่า local box)
            // ทำให้ queryAt คืน candidates ครบ — ค่อย confirm ผ่าน _hitRotatedBox ที่ตอน hit-test
            if (!wrap._grid) wrap._grid = new SpatialGrid(200);
            wrap._grid.clear();
            drawn.forEach((d, idx) => {
                const aabb = _aabbOfRotated({ x: d.x, y: d.y, w: d.w, h: d.h }, d.rotation || 0);
                wrap._grid.insert(idx, aabb.x, aabb.y, aabb.w, aabb.h);
            });
            window._previewWrap = wrap;
            ctx.restore();   // matches ctx.save() ที่เริ่มต้น doDraw
            // sync left pane ทุกครั้งที่ right pane redraw — ครอบ drag/rotate/resize/selection
            // requestRedraw ฝั่ง before-pane เป็น rAF-debounced → safe เรียกถี่ไม่กระทบ performance
            window._beforePaneRedraw?.();
        };
        wrap._redraw = doDraw;

        // fit-to-viewport — pane CSS size, image natural size
        const _paneRect = previewArea.getBoundingClientRect();
        viewport.fitToViewport(imgW, imgH, _paneRect.width, _paneRect.height);
        // initial render (viewport.onChange listener ก็ trigger requestRedraw ตอน fitToViewport)
        doDraw();

        wrap.style.cursor = "default";

        wrap.onmousemove = (ev) => {
            // preview mode = หน้าที่วางคำแปลแล้ว — ห้าม hover/tooltip/hit-test/drag tracking
            if (state.previewMode) {
                tooltip.style.display = "none";
                wrap.style.cursor = "default";
                return;
            }
            // pan tool active → ไม่ต้อง hit-test/hover; pan-zoom จัดการ drag เอง
            if (getTool() === "pan") {
                wrap.style.cursor = "grab";
                tooltip.style.display = "none";
                return;
            }
            // canvas-no-transform model: world = (client - canvasRect - pan) / zoom
            const { x: px, y: py } = viewport.clientToWorld(canvas, ev.clientX, ev.clientY);
            // tooltip ใช้ screen-local coords (wrap = absolute container, ไม่ใช่ world)
            const _wrapRect = wrap.getBoundingClientRect();
            const tipX = ev.clientX - _wrapRect.left;
            const tipY = ev.clientY - _wrapRect.top;

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
                    // rotated → ใช้ AABB ของ rotated box เทียบ overlap (loose match)
                    const aabb = _aabbOfRotated({ x: d.x, y: d.y, w: d.w, h: d.h }, d.rotation || 0);
                    const inside = aabb.x < x2 && aabb.x + aabb.w > x1 && aabb.y < y2 && aabb.y + aabb.h > y1;
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
                updateInspector();
                tooltip.style.display = "none";
                doDraw();
                return;
            }

            // === DRAGGING ===
            const dr = getDrag();
            if (dr) {
                const dx = px - dr.startX;
                const dy = py - dr.startY;
                if (!dr.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD
                    && dr.mode !== "rotate") return;
                dr.moved = true;
                state.justDragged = true;
                tooltip.style.display = "none";
                const sb = dr.startBox;
                const ov = state.bboxOverrides[dr.ref] = state.bboxOverrides[dr.ref] || {};

                if (dr.mode === "rotate") {
                    // หมุนรอบ box center: angle = atan2(p - center)
                    const cx = sb.x + sb.w / 2, cy = sb.y + sb.h / 2;
                    const startAngle = Math.atan2(dr.startY - cy, dr.startX - cx);
                    const curAngle = Math.atan2(py - cy, px - cx);
                    const rawDeg = dr.startRotation + (curAngle - startAngle) * 180 / Math.PI;
                    const snapped = _snapRotation(rawDeg, ev.shiftKey);
                    ov.rotation = snapped;
                    const isAtZero = snapped === 0 || (ev.shiftKey && (snapped % ROT_SHIFT_STEP_DEG === 0));
                    _showRotateBadge(ev.clientX, ev.clientY, snapped, isAtZero);
                    doDraw();
                    return;
                }

                if (dr.mode === "move") {
                    // translate ใน world space — rotation ไม่กระทบ
                    ov.x = sb.x + dx;
                    ov.y = sb.y + dy;
                    ov.w = sb.w;
                    ov.h = sb.h;
                } else {
                    // rotation-aware resize — อ้างอิง Ketchup _sideResize/_cornerResize.
                    // เก่า apply local delta + implicit top-left anchor → center drift (box rotate รอบ center)
                    const rot = dr.rotation || 0;
                    const rad = rot * Math.PI / 180;
                    const ex = { x: Math.cos(rad), y: Math.sin(rad) };
                    const ey = { x: -Math.sin(rad), y: Math.cos(rad) };
                    const sCx = sb.x + sb.w / 2, sCy = sb.y + sb.h / 2;

                    const LEFT = dr.mode.includes("w"), RIGHT = dr.mode.includes("e");
                    const TOP = dr.mode.includes("n"), BOTTOM = dr.mode.includes("s");
                    const aox = LEFT ? +1 : (RIGHT ? -1 : 0);
                    const aoy = TOP ? +1 : (BOTTOM ? -1 : 0);

                    const anchorX = sCx + aox * (sb.w / 2) * ex.x + aoy * (sb.h / 2) * ey.x;
                    const anchorY = sCy + aox * (sb.w / 2) * ex.y + aoy * (sb.h / 2) * ey.y;

                    const moX = (px - anchorX) * ex.x + (py - anchorY) * ex.y;
                    const moY = (px - anchorX) * ey.x + (py - anchorY) * ey.y;

                    let nw = sb.w, nh = sb.h;
                    if (LEFT || RIGHT) nw = Math.max(-aox * moX, MIN_BOX);
                    if (TOP || BOTTOM) nh = Math.max(-aoy * moY, MIN_BOX);

                    const ncX = anchorX + (-aox) * (nw / 2) * ex.x + (-aoy) * (nh / 2) * ey.x;
                    const ncY = anchorY + (-aox) * (nw / 2) * ex.y + (-aoy) * (nh / 2) * ey.y;

                    ov.x = ncX - nw / 2;
                    ov.y = ncY - nh / 2;
                    ov.w = nw;
                    ov.h = nh;
                }
                doDraw();
                return;
            }

            // === Hover cursor ===
            let cur = "default";
            if (sel.ref) {
                const selDrawn = drawn.find(d => d.item.self_ref === sel.ref);
                if (selDrawn) {
                    const zNow = viewport.getZoom();
                    const rot = selDrawn.rotation || 0;
                    if (_hitRotationHandle(selDrawn, rot, px, py, zNow)) {
                        cur = "grab";
                    } else {
                        const handle = _hitHandle(selDrawn, px, py, zNow, rot);
                        if (handle) {
                            const map = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
                                          nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" };
                            cur = map[handle] || "default";
                        }
                    }
                }
            }
            // SpatialGrid → AABB candidates; refine ผ่าน _hitRotatedBox สำหรับ rotated items
            const _hitIds = wrap._grid ? wrap._grid.queryAt(px, py) : [];
            let _topHit = null;
            for (let i = _hitIds.length - 1; i >= 0; i--) {
                const d = drawn[_hitIds[i]];
                if (_hitRotatedBox({ x: d.x, y: d.y, w: d.w, h: d.h }, d.rotation || 0, px, py)) {
                    _topHit = d;
                    break;
                }
            }

            if (cur === "default") {
                cur = _topHit ? "move" : "default";
            }
            wrap.style.cursor = cur;

            // Hover tooltip ถูกปิดถาวร — OCR/corrected/translation แสดงใน right panel inspector
            // (ก่อนหน้านี้เป็น duplicate ที่ 3: left pane bbox + right panel + hover)
            tooltip.style.display = "none";
        };

        wrap.onmouseleave = () => tooltip.style.display = "none";

        // === mousedown: เริ่ม drag/marquee ===
        wrap.onmousedown = (ev) => {
            if (ev.button !== 0) return;
            // preview mode = view-only — ห้ามเริ่ม drag/selection/marquee
            if (state.previewMode) return;
            // pan tool: ปล่อยให้ pan-zoom.js handler ทำงาน (shouldPan = true)
            if (getTool() === "pan") return;
            state.justDragged = false;
            // canvas-no-transform model: world = (client - canvasRect - pan) / zoom
            const { x: px, y: py } = viewport.clientToWorld(canvas, ev.clientX, ev.clientY);
            // 1) handle ของกล่องที่ active อยู่ก่อน — rotation handle มาก่อน, แล้ว resize handles
            if (sel.ref && !ev.shiftKey) {
                const selDrawn = drawn.find(d => d.item.self_ref === sel.ref);
                if (selDrawn) {
                    const zNow = viewport.getZoom();
                    const rot = selDrawn.rotation || 0;
                    if (_hitRotationHandle(selDrawn, rot, px, py, zNow)) {
                        ev.preventDefault();
                        setDrag({
                            ref: sel.ref, mode: "rotate",
                            startX: px, startY: py,
                            startBox: { x: selDrawn.x, y: selDrawn.y, w: selDrawn.w, h: selDrawn.h },
                            rotation: rot,
                            startRotation: rot,
                            beforeOv: _clone(state.bboxOverrides[sel.ref]),
                        });
                        wrap.classList.add("dragging");
                        return;
                    }
                    const handle = _hitHandle(selDrawn, px, py, zNow, rot);
                    if (handle) {
                        ev.preventDefault();
                        setDrag({
                            ref: sel.ref, mode: handle,
                            startX: px, startY: py,
                            startBox: { x: selDrawn.x, y: selDrawn.y, w: selDrawn.w, h: selDrawn.h },
                            rotation: rot,
                            beforeOv: _clone(state.bboxOverrides[sel.ref]),
                        });
                        wrap.classList.add("dragging");
                        return;
                    }
                }
            }
            // 2) คลิกในกล่อง (rotation-aware hit-test)
            const _ids = wrap._grid ? wrap._grid.queryAt(px, py) : [];
            let hit = null;
            for (let i = _ids.length - 1; i >= 0; i--) {
                const d = drawn[_ids[i]];
                if (_hitRotatedBox({ x: d.x, y: d.y, w: d.w, h: d.h }, d.rotation || 0, px, py)) {
                    hit = d;
                    break;
                }
            }
            if (hit) {
                ev.preventDefault();
                ev.stopPropagation();
                _toggleSelectAndButton(hit.item.self_ref, ev.shiftKey);
                if (!ev.shiftKey && sel.ref) {
                    setDrag({
                        ref: sel.ref, mode: "move",
                        startX: px, startY: py,
                        startBox: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
                        rotation: hit.rotation || 0,
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
                    const desc = dr.mode === "rotate" ? "Rotate bbox"
                        : (dr.mode === "move" ? "Move bbox" : "Resize bbox");
                    history.exec(new UpdateBboxCmd(dr.ref, dr.beforeOv, afterOv, desc));
                }
                if (dr.mode === "rotate") _hideRotateBadge();
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

        // wrap.onclick = ลบออกแล้ว — speaker/emotion popup ย้ายไปทำใน right panel (inspector.js)
        // selection / drag / marquee ยังทำที่ wrap.onmousedown — ไม่ต้องใช้ onclick
    }
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
        updateInspector();
        // guard กับ history.clear() ตอน upload (lastResult เป็น null)
        if (!state.lastResult) return;
        if (document.querySelector(".tab.active")?.dataset.tab === "visual") redrawOnly();
        window.buildCompareTable?.(true);
    });
    _syncUndoButtons();

    undoBtn?.addEventListener("click", () => history.undo());
    redoBtn?.addEventListener("click", () => history.redo());

    // ⌘Z / Ctrl+Z = undo, ⌘⇧Z / Ctrl+Y = redo
    // Delete / Backspace = mark selected bbox(es) as "Don't translate" (SPEAKER_SKIP)
    // Skip ถ้า focus อยู่ใน input/textarea/cell — เพื่อไม่ชนกับ text editing
    document.addEventListener("keydown", (e) => {
        const tag = (e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

        // Delete / Backspace → SPEAKER_SKIP (no mod key — เฉพาะตอน tab visual)
        if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey && !e.altKey) {
            if (document.querySelector(".tab.active")?.dataset.tab !== "visual") return;
            const refs = [...sel.refs].filter(r => state.speakerByRef[r] !== SPEAKER_SKIP);
            if (!refs.length) return;
            e.preventDefault();
            const cmds = refs.map(ref => new SetSpeakerCmd(ref, state.speakerByRef[ref], SPEAKER_SKIP));
            const cmd = cmds.length === 1
                ? cmds[0]
                : new CompositeCommand(cmds, `Skip ${cmds.length} boxes`);
            history.exec(cmd);
            return;
        }

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

    // A+/A- — delta = ±2 screen px. Base = rendered fontSize (= ที่ user เห็น) เสมอ,
    // ไม่ใช้ override เก่าซึ่งอาจ stale. step ใน screen-space → render ใน world (หาร zoom).
    // Bounds: min absolute 3 world (ไม่ติด zoom กัน clamp clash min>max), max = 70% bbox h.
    function _adjustFont(delta) {
        const refs = [...sel.refs];
        if (!refs.length) return;
        const z = viewport.getZoom() || 1;
        const worldDelta = delta / z;
        _execMultiBbox(refs, (ref) => {
            const before = _clone(state.bboxOverrides[ref]);
            const cur = before || {};
            const selDrawn = (window._previewWrap?._drawn || []).find(d => d.item.self_ref === ref);
            // base = ขนาด font ที่ user เห็นจริง (selDrawn.fontSize = render result)
            // — ใช้แทน override เก่า เพื่อให้ +/- เริ่มจาก "what's focused" ตลอด
            const curSize = selDrawn?.fontSize
                || cur.fontSize
                || 14;
            const bboxMax = selDrawn ? Math.max(8, selDrawn.h * 0.7) : 200;
            const next = Math.max(3, Math.min(bboxMax, curSize + worldDelta));
            const after = { ...cur, fontSize: Math.round(next * 100) / 100 };
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
