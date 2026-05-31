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
import { _aabbOfRotated } from "./visual/geometry.js";
import { SelectTool } from "./visual/tools/SelectTool.js";
import { EditTextTool } from "./visual/tools/EditTextTool.js";
import { ToolRegistry } from "./visual/tools/ToolRegistry.js";
import { renderBoxes } from "./visual/renderers/box-renderer.js";
import { drawResizeHandles, drawRotationHandle } from "./visual/renderers/handle-renderer.js";

const toolRegistry = new ToolRegistry();
toolRegistry.add(new SelectTool());
toolRegistry.add(new EditTextTool());
let currentToolId = "select";

// deep clone helper สำหรับ command snapshots
const _clone = (v) => v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));

const sel = state.selection;

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

function _getRotation(ref) {
    const ov = state.bboxOverrides[ref];
    return (ov && typeof ov.rotation === "number") ? ov.rotation : 0;
}


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

    _cleanupPreviewArea();
    previewArea.innerHTML = "";
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
            const items = (state.lastResult?.preview?.items || []).filter(it => it.page_no === pageNo);

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

            drawn = renderBoxes(ctx, {
                items, sx, sy, pageW, pageH, z,
                previewMode: state.previewMode,
            });

            const showSelectChrome = !state.previewMode && currentToolId === "select";
            if (showSelectChrome && sel.refs.size) {
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
            if (showSelectChrome && sel.ref) {
                const selDrawn = drawn.find(d => d.item.self_ref === sel.ref);
                if (selDrawn) {
                    const zNow = viewport.getZoom();
                    drawResizeHandles(ctx, selDrawn, zNow, selDrawn.rotation || 0);
                    drawRotationHandle(ctx, selDrawn, selDrawn.rotation || 0, zNow);
                }
            }

            const tool = toolRegistry.get(currentToolId);
            tool?.drawOverlay?.(ctx, { zoom: z });

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

        const toolCtx = {
            wrap, canvas, tooltip,
            get drawn() { return drawn; },
            sel, doDraw,
            useTool: (id, data) => _useTool(id, data),
            helpers: {
                toggleSelectAndButton: _toggleSelectAndButton,
                clearSelectionAndButton: _clearSelectionAndButton,
                updateMergeButton: _updateMergeButton,
                syncAlignToolbar: _syncAlignToolbar,
                updateInspector,
            },
        };
        const _pos = (ev) => viewport.clientToWorld(canvas, ev.clientX, ev.clientY);
        const _curTool = () => toolRegistry.get(currentToolId);

        function _useTool(id, data) {
            const cur = toolRegistry.get(currentToolId);
            cur?.deactivate?.(toolCtx);
            currentToolId = id;
            const next = toolRegistry.get(id);
            if (id === "edit-text" && data) next.begin(data.box, data.ref, toolCtx, data.clickPos);
            next?.activate?.(toolCtx);
            doDraw();
        }

        wrap.onmousemove = (ev) => {
            if (state.previewMode) {
                tooltip.style.display = "none";
                wrap.style.cursor = "default";
                return;
            }
            if (getTool() === "pan") {
                wrap.style.cursor = "grab";
                tooltip.style.display = "none";
                return;
            }
            _curTool().onPointerMove(ev, _pos(ev), toolCtx);
        };

        wrap.onmouseleave = () => tooltip.style.display = "none";

        wrap.onmousedown = (ev) => {
            if (state.previewMode) return;
            if (getTool() === "pan") return;
            _curTool().onPointerDown(ev, _pos(ev), toolCtx);
        };

        wrap.onmouseup = (ev) => {
            _curTool().onPointerUp(ev, _pos(ev), toolCtx);
        };

        wrap.ondblclick = (ev) => {
            if (state.previewMode) return;
            if (getTool() === "pan") return;
            _curTool().onDoubleClick(ev, _pos(ev), toolCtx);
        };

        wrap.oncontextmenu = (ev) => {
            if (state.previewMode) return;
            if (getTool() === "pan") return;
            _curTool().onContextMenu(ev, _pos(ev), toolCtx);
        };

        if (window._previewDocMouseUp) {
            document.removeEventListener("mouseup", window._previewDocMouseUp);
        }
        window._previewDocMouseUp = (e) => {
            if (state.drag || state.marquee) wrap.onmouseup(e);
        };
        document.addEventListener("mouseup", window._previewDocMouseUp);

        wrap._curTool = _curTool;
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
