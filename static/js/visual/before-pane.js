// Before pane — clean image (no boxes, no overlay).
// Canvas + ctx.setTransform pattern (Ketchup-style) → sync กับ after pane ผ่าน Viewport.
// Image source = page.image (base64 data URL จาก server) หรือ blob URL (client-uploaded image).

import { state } from "../state.js";
import * as viewport from "./viewport.js";
import { getImageSrc } from "./image-source.js";

let _unsubscribePrev = null;
let _resizeObserverPrev = null;

export function renderBeforePane() {
    const pane = document.getElementById("beforePane");
    if (!pane) return;

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
    const imgW = page.img_width || page.width || 1;
    const imgH = page.img_height || page.height || 1;

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute; top:0; left:0; display:block;";
    pane.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const src = getImageSrc(page);
    const img = src ? new Image() : null;
    if (img) img.src = src;

    function _resize() {
        const r = pane.getBoundingClientRect();
        canvas.width = Math.max(1, Math.floor(r.width * dpr));
        canvas.height = Math.max(1, Math.floor(r.height * dpr));
        canvas.style.width = r.width + "px";
        canvas.style.height = r.height + "px";
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
        if (img && img.complete && img.naturalWidth) {
            ctx.drawImage(img, 0, 0, imgW, imgH);
        } else if (img) {
            img.onload = requestRedraw;
        }
        ctx.restore();
    }

    _unsubscribePrev = viewport.onChange(requestRedraw);
    _resizeObserverPrev = new ResizeObserver(() => { _resize(); requestRedraw(); });
    _resizeObserverPrev.observe(pane);

    render();
}
