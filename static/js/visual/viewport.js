// Viewport — shared zoom/pan state ระหว่าง 2 panes (before + after).
// Apply ผ่าน CSS transform บน .zoom-wrap div ที่ register ไว้.
// Math pattern อิงจาก Ketchup CanvasEngine: pan ใน screen pixels,
// zoom around cursor (newPan = mouse - (mouse - oldPan) * (newZoom / oldZoom)).

const state = { zoom: 1, panX: 0, panY: 0 };
const targets = new Set();           // .zoom-wrap elements ที่จะ apply transform
const listeners = new Set();         // callbacks เรียกหลัง mutate (เช่น redraw canvas overlay)

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;

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
    _notify();
}

/** fit content (naturalW × naturalH) into a viewport box, centered */
export function fitToViewport(naturalW, naturalH, viewportW, viewportH) {
    if (naturalW <= 0 || naturalH <= 0 || viewportW <= 0 || viewportH <= 0) {
        return reset();
    }
    const z = Math.min(viewportW / naturalW, viewportH / naturalH);
    state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    state.panX = (viewportW - naturalW * state.zoom) / 2;
    state.panY = (viewportH - naturalH * state.zoom) / 2;
    _notify();
}

/** zoom around a cursor point (screen-coord relative to container) */
export function zoomAt(cursorX, cursorY, factor) {
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * factor));
    if (newZoom === state.zoom) return;
    state.panX = cursorX - (cursorX - state.panX) * (newZoom / state.zoom);
    state.panY = cursorY - (cursorY - state.panY) * (newZoom / state.zoom);
    state.zoom = newZoom;
    _notify();
}

/** delta-pan in screen pixels */
export function panBy(dx, dy) {
    state.panX += dx;
    state.panY += dy;
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
