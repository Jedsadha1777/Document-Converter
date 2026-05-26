// Before pane — clean image (no boxes, no overlay).
// Canvas + ctx.setTransform pattern (Ketchup-style) → sync กับ after pane ผ่าน Viewport.
// Tile-based rendering ผ่าน TileLoader (Phase 0 manifest) → รองรับ image 40000px+.

import { state } from "../state.js";
import * as viewport from "./viewport.js";
import { peekLevel, pickLevel } from "./wasm-tiles.js";

let _unsubscribePrev = null;
let _resizeObserverPrev = null;

export function renderBeforePane() {
    const pane = document.getElementById("beforePane");
    if (!pane) return;

    // cleanup previous listeners
    if (_unsubscribePrev) { _unsubscribePrev(); _unsubscribePrev = null; }
    if (_resizeObserverPrev) { _resizeObserverPrev.disconnect(); _resizeObserverPrev = null; }
    pane.innerHTML = "";

    const pages = state.lastResult?.preview?.pages || [];
    if (!pages.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Upload a file to see the original image.";
        pane.appendChild(empty);
        return;
    }
    const pageSelect = document.getElementById("pageSelect");
    const pageNo = parseInt(pageSelect?.value || pages[0].page_no, 10);
    const page = pages.find(p => p.page_no === pageNo) || pages[0];
    const tm = page.tile_manifest;
    const docId = page._doc_id || state.lastResult?.doc_id || null;
    // multi-file: tile stored at original page_no (= page index within source file)
    const tilePage = page._page_no_orig ?? page.page_no;
    const imgW = tm?.width || page.width || 1;
    const imgH = tm?.height || page.height || 1;

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute; top:0; left:0; display:block;";
    pane.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    // base64 = instant fallback ขณะรอ WASM level decode
    const fallbackImg = page.image ? new Image() : null;
    if (fallbackImg) fallbackImg.src = page.image;

    function _resize() {
        const r = pane.getBoundingClientRect();
        canvas.width = Math.max(1, Math.floor(r.width * dpr));
        canvas.height = Math.max(1, Math.floor(r.height * dpr));
        canvas.style.width = r.width + "px";
        canvas.style.height = r.height + "px";
        // viewport size = ของ previewArea (after pane) ใช้คลุม clamp;
        // before pane มี width เท่ากันใน split grid → ก็ใช้ค่าเดียวกันได้
        // (caller renderPreview จะเรียก setViewportSize หลัง mount; ตรงนี้ skip duplicate)
    }
    _resize();

    let _scheduled = false;
    function requestRedraw() {
        if (_scheduled) return;
        _scheduled = true;
        requestAnimationFrame(() => { _scheduled = false; render(); });
    }

    function render() {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        viewport.applyToCanvasCtx(ctx, dpr);

        let drew = false;
        if (tm && docId) {
            const lvl = pickLevel(viewport.getZoom(), tm.max_level);
            const handle = peekLevel(docId, tilePage, lvl, () => requestRedraw());
            if (handle?.bitmap) {
                ctx.drawImage(handle.bitmap, 0, 0, imgW, imgH);
                drew = true;
            }
        }
        if (!drew && fallbackImg && fallbackImg.complete && fallbackImg.naturalWidth) {
            ctx.drawImage(fallbackImg, 0, 0, imgW, imgH);
        } else if (!drew && fallbackImg) {
            fallbackImg.onload = requestRedraw;
        }
        ctx.restore();
    }

    _unsubscribePrev = viewport.onChange(requestRedraw);
    _resizeObserverPrev = new ResizeObserver(() => { _resize(); requestRedraw(); });
    _resizeObserverPrev.observe(pane);

    render();
}
