// Viewport — shared zoom/pan state ระหว่าง 2 panes (before + after).
// Apply ผ่าน CSS transform บน .zoom-wrap div ที่ register ไว้.
// Math pattern อิงจาก Ketchup CanvasEngine: pan ใน screen pixels,
// zoom around cursor (newPan = mouse - (mouse - oldPan) * (newZoom / oldZoom)).

const state = { zoom: 1, panX: 0, panY: 0 };
const targets = new Set();
const listeners = new Set();

// Strict pan bounds + adaptive zoom range อิง fit zoom ของ image ปัจจุบัน:
//   minZoom = fit zoom → zoom out ต่ำกว่า fit ไม่ได้ (image ครอบ viewport เสมอ — เหมือน Preview.app)
//   maxZoom = clamp(fit × 8, 1, 4) → ดู detail ระดับ pixel ได้แต่ไม่เกิน 400% native
const bounds = {
    contentW: 0, contentH: 0, viewportW: 0, viewportH: 0,
    minZoom: 0.01, maxZoom: 4,
};
const ABS_MIN_ZOOM = 0.01;
const ABS_MAX_ZOOM = 4;
export const MIN_ZOOM = ABS_MIN_ZOOM;
export const MAX_ZOOM = ABS_MAX_ZOOM;

function _computeZoomRange() {
    const { contentW, contentH, viewportW, viewportH } = bounds;
    if (contentW <= 0 || viewportW <= 0) {
        bounds.minZoom = ABS_MIN_ZOOM; bounds.maxZoom = ABS_MAX_ZOOM; return;
    }
    const fit = Math.min(viewportW / contentW, viewportH / contentH);
    bounds.minZoom = Math.max(ABS_MIN_ZOOM, fit);
    bounds.maxZoom = Math.min(ABS_MAX_ZOOM, Math.max(1, fit * 8));
}

/** ระบุขนาด content (image natural pixel) + viewport (pane CSS pixel) — caller จาก preview.js
 *  setContentSize ก่อน setViewportSize → fit + clamp ใช้ค่า bounds ปัจจุบัน */
export function setContentSize(w, h) {
    bounds.contentW = w > 0 ? w : 0;
    bounds.contentH = h > 0 ? h : 0;
}
/** Clear bounds (= no content state). ใช้ตอน tab switch / page change ที่ pane ว่าง — กัน clamp
 *  อิง stale bounds + กัน panBy/zoomAt mutate (ทั้งคู่ early-return เมื่อ no bounds) */
export function clearBounds() {
    bounds.contentW = 0; bounds.contentH = 0;
    bounds.viewportW = 0; bounds.viewportH = 0;
}
export function setViewportSize(w, h) {
    bounds.viewportW = w > 0 ? w : 0;
    bounds.viewportH = h > 0 ? h : 0;
    _computeZoomRange();
    if (_clamp()) _notify();
}

export function getZoom() { return state.zoom; }
export function getPan() { return { x: state.panX, y: state.panY }; }
export function getState() { return { ...state }; }

export function registerTarget(el) {
    if (!el) return;
    targets.add(el);
    _applyOne(el);
}
export function unregisterTarget(el) { targets.delete(el); }
export function clearTargets() { targets.clear(); }

export function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function reset() {
    state.zoom = 1; state.panX = 0; state.panY = 0;
    _clamp();
    _notify();
}

// Strict: image ≤ viewport → force center; image > viewport → image edges flush at viewport edges.
function _clamp() {
    const { contentW, contentH, viewportW, viewportH } = bounds;
    if (contentW <= 0 || contentH <= 0 || viewportW <= 0 || viewportH <= 0) {
        return false;
    }
    const imgW = contentW * state.zoom;
    const imgH = contentH * state.zoom;
    let nx, ny;
    if (imgW <= viewportW) {
        nx = (viewportW - imgW) / 2;
    } else {
        nx = Math.max(viewportW - imgW, Math.min(0, state.panX));
    }
    if (imgH <= viewportH) {
        ny = (viewportH - imgH) / 2;
    } else {
        ny = Math.max(viewportH - imgH, Math.min(0, state.panY));
    }
    const changed = state.panX !== nx || state.panY !== ny;
    state.panX = nx; state.panY = ny;
    return changed;
}

/** fit content (naturalW × naturalH) into a viewport box, centered */
export function fitToViewport(naturalW, naturalH, viewportW, viewportH) {
    if (naturalW <= 0 || naturalH <= 0 || viewportW <= 0 || viewportH <= 0) {
        return reset();
    }
    bounds.contentW = naturalW;
    bounds.contentH = naturalH;
    bounds.viewportW = viewportW;
    bounds.viewportH = viewportH;
    _computeZoomRange();
    state.zoom = bounds.minZoom;            // fit = min zoom by definition
    state.panX = (viewportW - naturalW * state.zoom) / 2;
    state.panY = (viewportH - naturalH * state.zoom) / 2;
    _clamp();
    _notify();
}

/** zoom around a cursor point (screen-coord relative to container) */
export function zoomAt(cursorX, cursorY, factor) {
    if (bounds.contentW <= 0 || bounds.viewportW <= 0) return;
    const newZoom = Math.max(bounds.minZoom, Math.min(bounds.maxZoom, state.zoom * factor));
    if (newZoom === state.zoom) return;
    state.panX = cursorX - (cursorX - state.panX) * (newZoom / state.zoom);
    state.panY = cursorY - (cursorY - state.panY) * (newZoom / state.zoom);
    state.zoom = newZoom;
    _clamp();
    _notify();
}

/** delta-pan in screen pixels. No-op ถ้ายังไม่มี content/viewport bounds (กัน pan ++ ก่อน upload). */
export function panBy(dx, dy) {
    if (bounds.contentW <= 0 || bounds.viewportW <= 0) return;
    state.panX += dx;
    state.panY += dy;
    _clamp();
    _notify();
}

function _applyOne(el) {
    el.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    el.style.transformOrigin = "0 0";
}
function _notify() {
    targets.forEach(_applyOne);
    listeners.forEach(fn => fn(state));
}

/**
 * convert client (screen) coords → world (image pixel @ level 0) coords.
 * canvas อยู่ที่ pane CSS size (ไม่มี CSS transform); world transform ทำผ่าน ctx.setTransform.
 * Formula: world = (clientPaneLocal - pan) / zoom
 */
export function clientToWorld(canvasEl, clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    return {
        x: (clientX - rect.left - state.panX) / state.zoom,
        y: (clientY - rect.top - state.panY) / state.zoom,
    };
}

/** Apply current viewport transform บน canvas 2D context.
 *  dpr = device pixel ratio — canvas backing store = cssSize × dpr → ต้องคูณ */
export function applyToCanvasCtx(ctx, dpr) {
    const z = state.zoom * dpr;
    ctx.setTransform(z, 0, 0, z, state.panX * dpr, state.panY * dpr);
}

// legacy alias — ของเดิม clientToCanvas เรียกใช้ใน mouse handlers
// (Phase 2-5 ตอน CSS transform; Phase 6 canvas-no-transform → clientToWorld แทน)
export const clientToCanvas = clientToWorld;
