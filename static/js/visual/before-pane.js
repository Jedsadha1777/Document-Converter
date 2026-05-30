// Before pane — original image + plain bbox outlines + red highlight ของ selected bbox
// (no overlay text, no diff highlights — แค่ช่วย user เห็นว่ากำลังโฟกัสกล่องไหน)
// Canvas + ctx.setTransform pattern (Ketchup-style) → sync กับ after pane ผ่าน Viewport.

import { state } from "../state.js";
import { COLORS } from "../colors.js";
import { SPEAKER_SKIP } from "../characters.js";
import * as viewport from "./viewport.js";
import { getImageSrc } from "./image-source.js";

let _unsubscribePrev = null;
let _resizeObserverPrev = null;

function _resolveBbox(item, sx, sy, pageW, pageH) {
    // bbox อยู่ใน page-units (PDF logical) — คูณ sx, sy เพื่อ map ไป image-pixel space
    // (PDF: pageW=612, imgW=1632 → sx≈2.67) — image-source pipelines (mokuro) จะ sx=sy=1
    const b = item.bbox || {};
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
    // override ใน image-pixel space อยู่แล้ว (จาก drag handler ที่ใช้ world coords) — ไม่ต้องคูณซ้ำ
    const ov = state.bboxOverrides[item.self_ref];
    if (ov) {
        if (typeof ov.x === "number") x = ov.x;
        if (typeof ov.y === "number") y = ov.y;
        if (typeof ov.w === "number") w = ov.w;
        if (typeof ov.h === "number") h = ov.h;
    }
    const rotation = (ov && typeof ov.rotation === "number") ? ov.rotation : 0;
    return { x, y, w, h, rotation };
}

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
        window._beforePaneRedraw = null;
        return;
    }
    const pageSelect = document.getElementById("pageSelect");
    const pageNo = parseInt(pageSelect?.value || pages[0].page_no, 10);
    const page = pages.find(p => p.page_no === pageNo) || pages[0];
    const imgW = page.img_width || page.width || 1;
    const imgH = page.img_height || page.height || 1;
    // page-unit → image-pixel scale (mirror right pane logic ใน preview.js:572-577)
    const pageW = page.width || imgW;
    const pageH = page.height || imgH;
    const sx = imgW / pageW;
    const sy = imgH / pageH;

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

    function _drawBboxes() {
        const items = (state.lastResult?.preview?.items || []).filter(it => it.page_no === pageNo);
        if (!items.length) return;
        const selRef = state.selection?.ref;
        const z = viewport.getZoom() || 1;
        items.forEach(it => {
            if (!it.self_ref) return;
            // กล่องที่ user กด Delete key (มัน mark SPEAKER_SKIP) → ซ่อนใน before pane
            if (state.speakerByRef[it.self_ref] === SPEAKER_SKIP) return;
            // หรือ user clear OCR text หมด (corrections === "") → ซ่อนด้วย
            if (state.corrections[it.self_ref] === "") return;
            const { x, y, w, h, rotation } = _resolveBbox(it, sx, sy, pageW, pageH);
            const isSel = it.self_ref === selRef;
            ctx.save();
            if (rotation) {
                const cx = x + w / 2, cy = y + h / 2;
                ctx.translate(cx, cy);
                ctx.rotate(rotation * Math.PI / 180);
                ctx.translate(-cx, -cy);
            }
            ctx.strokeStyle = isSel ? "#dc2626" : COLORS.categoryTexts;   // selected = red, else = blue (match right pane)
            ctx.lineWidth = (isSel ? 4 : 2) / z;
            ctx.strokeRect(x, y, w, h);
            ctx.restore();
        });
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
        _drawBboxes();
        ctx.restore();
    }

    _unsubscribePrev = viewport.onChange(requestRedraw);
    _resizeObserverPrev = new ResizeObserver(() => { _resize(); requestRedraw(); });
    _resizeObserverPrev.observe(pane);

    // expose สำหรับให้ preview.js trigger ตอน selection เปลี่ยน
    window._beforePaneRedraw = requestRedraw;

    render();
}
