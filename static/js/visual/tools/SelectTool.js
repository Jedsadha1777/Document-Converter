import { ITool } from "./ITool.js";
import { state } from "../../state.js";
import { history } from "../../history.js";
import { UpdateBboxCmd, UpdateMarkupCmd, DeleteMarkupCmd } from "../../commands.js";
import { getLayer } from "../layer-mode.js";
import { COLORS } from "../../colors.js";
import * as viewport from "../viewport.js";
import {
    _hitHandle, _hitRotationHandle, _hitRotatedBox, _aabbOfRotated, _worldToBoxLocal,
} from "../geometry.js";
import { drawResizeHandles, drawRotationHandle } from "../renderers/handle-renderer.js";
import { samplePenShape } from "./ShapeTool.js";

const DRAG_THRESHOLD = 4;
const MIN_BOX = 12;
const ROT_ZERO_SNAP_DEG = 3;
const ROT_SHIFT_STEP_DEG = 15;

const RESIZE_CURSOR = {
    n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
};

const _clone = (v) => v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
const MIN_SHAPE = 5;

function _currentPageNo() {
    const sel = document.getElementById("pageSelect");
    return parseInt(sel?.value || state.lastResult?.preview?.pages?.[0]?.page_no || 1, 10);
}

function _pointInTri(px, py, ax, ay, bx, by, cx, cy) {
    const v0x = cx - ax, v0y = cy - ay;
    const v1x = bx - ax, v1y = by - ay;
    const v2x = px - ax, v2y = py - ay;
    const d00 = v0x * v0x + v0y * v0y;
    const d01 = v0x * v1x + v0y * v1y;
    const d02 = v0x * v2x + v0y * v2y;
    const d11 = v1x * v1x + v1y * v1y;
    const d12 = v1x * v2x + v1y * v2y;
    const denom = d00 * d11 - d01 * d01;
    if (!denom) return false;
    const inv = 1 / denom;
    const u = (d11 * d02 - d01 * d12) * inv;
    const v = (d00 * d12 - d01 * d02) * inv;
    return u >= 0 && v >= 0 && u + v <= 1;
}

function _hitShape(s, px, py) {
    const rot = s.rotation || 0;
    const lp = rot ? _worldToBoxLocal({ x: s.x, y: s.y, w: s.w, h: s.h }, rot, px, py) : { x: px, y: py };
    const lx = lp.x, ly = lp.y;
    if (s.type === "shape-rect" || s.type === "rect") {
        return lx >= s.x && lx <= s.x + s.w && ly >= s.y && ly <= s.y + s.h;
    }
    if (s.type === "shape-circle" || s.type === "circle") {
        const rx = s.w / 2, ry = s.h / 2;
        if (rx <= 0 || ry <= 0) return false;
        const dx = (lx - (s.x + rx)) / rx;
        const dy = (ly - (s.y + ry)) / ry;
        return dx * dx + dy * dy <= 1;
    }
    if (s.type === "shape-triangle" || s.type === "triangle") {
        const apexX = s.x + s.w / 2;
        return _pointInTri(lx, ly, apexX, s.y, s.x + s.w, s.y + s.h, s.x, s.y + s.h);
    }
    if (s.type === "shape-pen" || s.type === "pen") {
        if (!s.points || s.points.length < 2) return false;
        const samples = samplePenShape(s);
        if (samples.length < 2) return false;
        if (s.fillColor != null && samples.length >= 3) {
            if (_pointInPolygon(lx, ly, samples)) return true;
        }
        const tol = Math.max(4, (s.strokeWidth || 1) / 2 + 2);
        for (let i = 0; i < samples.length - 1; i++) {
            if (_distToSeg(lx, ly, samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y) <= tol) return true;
        }
        if (s.closed) {
            const last = samples[samples.length - 1], first = samples[0];
            if (_distToSeg(lx, ly, last.x, last.y, first.x, first.y) <= tol) return true;
        }
        return false;
    }
    return false;
}

function _pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi + 1e-9) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function _distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function _snapRotation(deg, shiftHeld) {
    let d = ((deg % 360) + 540) % 360 - 180;
    if (shiftHeld) {
        d = Math.round(d / ROT_SHIFT_STEP_DEG) * ROT_SHIFT_STEP_DEG;
    } else if (Math.abs(d) <= ROT_ZERO_SNAP_DEG) {
        d = 0;
    }
    return d;
}

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

export class SelectTool extends ITool {
    constructor() {
        super("select", "Select", { cursor: "default" });
    }

    onPointerDown(ev, pos, ctx) {
        if (ev.button !== 0) return;
        state.justDragged = false;
        if (getLayer() === "markup") return this._markupPointerDown(ev, pos, ctx);
        const { x: px, y: py } = pos;
        const { wrap, drawn, sel, doDraw } = ctx;

        if (sel.ref && !ev.shiftKey) {
            const selDrawn = drawn.find(d => d.item.self_ref === sel.ref);
            if (selDrawn) {
                const zNow = viewport.getZoom();
                const rot = selDrawn.rotation || 0;
                if (_hitRotationHandle(selDrawn, rot, px, py, zNow)) {
                    ev.preventDefault();
                    state.drag = {
                        ref: sel.ref, mode: "rotate",
                        startX: px, startY: py,
                        startBox: { x: selDrawn.x, y: selDrawn.y, w: selDrawn.w, h: selDrawn.h },
                        rotation: rot,
                        startRotation: rot,
                        beforeOv: _clone(state.bboxOverrides[sel.ref]),
                    };
                    wrap.classList.add("dragging");
                    return;
                }
                const handle = _hitHandle(selDrawn, px, py, zNow, rot);
                if (handle) {
                    ev.preventDefault();
                    state.drag = {
                        ref: sel.ref, mode: handle,
                        startX: px, startY: py,
                        startBox: { x: selDrawn.x, y: selDrawn.y, w: selDrawn.w, h: selDrawn.h },
                        rotation: rot,
                        beforeOv: _clone(state.bboxOverrides[sel.ref]),
                    };
                    wrap.classList.add("dragging");
                    return;
                }
            }
        }

        const ids = wrap._grid ? wrap._grid.queryAt(px, py) : [];
        let hit = null;
        for (let i = ids.length - 1; i >= 0; i--) {
            const d = drawn[ids[i]];
            if (_hitRotatedBox({ x: d.x, y: d.y, w: d.w, h: d.h }, d.rotation || 0, px, py)) {
                hit = d;
                break;
            }
        }
        if (hit) {
            ev.preventDefault();
            ev.stopPropagation();
            ctx.helpers.toggleSelectAndButton(hit.item.self_ref, ev.shiftKey);
            if (!ev.shiftKey && sel.ref) {
                state.drag = {
                    ref: sel.ref, mode: "move",
                    startX: px, startY: py,
                    startBox: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
                    rotation: hit.rotation || 0,
                    beforeOv: _clone(state.bboxOverrides[sel.ref]),
                };
                wrap.classList.add("dragging");
            }
            doDraw();
        } else {
            if (!ev.shiftKey && (sel.ref || sel.refs.size)) {
                ctx.helpers.clearSelectionAndButton();
                doDraw();
            }
            state.marquee = {
                startX: px, startY: py,
                endX: px, endY: py,
                additive: ev.shiftKey,
                initialSelection: new Set(sel.refs),
            };
        }
    }

    onPointerMove(ev, pos, ctx) {
        if (state.drag?.markupId) return this._markupPointerMove(ev, pos, ctx);
        if (getLayer() === "markup") return this._markupHover(ev, pos, ctx);
        const { wrap, canvas, tooltip, drawn, sel, doDraw } = ctx;
        const { x: px, y: py } = pos;

        const mq = state.marquee;
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
            ctx.helpers.updateMergeButton();
            ctx.helpers.syncAlignToolbar();
            ctx.helpers.updateInspector();
            tooltip.style.display = "none";
            doDraw();
            return;
        }

        const dr = state.drag;
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
                ov.x = sb.x + dx;
                ov.y = sb.y + dy;
                ov.w = sb.w;
                ov.h = sb.h;
            } else {
                // anchor opposite local edge/corner ใน world — box rotate รอบ center, implicit top-left anchor → drift
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

        // hover cursor
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
                    if (handle) cur = RESIZE_CURSOR[handle] || "default";
                }
            }
        }
        const hitIds = wrap._grid ? wrap._grid.queryAt(px, py) : [];
        let topHit = null;
        for (let i = hitIds.length - 1; i >= 0; i--) {
            const d = drawn[hitIds[i]];
            if (_hitRotatedBox({ x: d.x, y: d.y, w: d.w, h: d.h }, d.rotation || 0, px, py)) {
                topHit = d;
                break;
            }
        }
        if (cur === "default") cur = topHit ? "move" : "default";
        wrap.style.cursor = cur;
        tooltip.style.display = "none";
    }

    onDoubleClick(ev, pos, ctx) {
        if (getLayer() === "markup") return;
        const { wrap, drawn } = ctx;
        const { x: px, y: py } = pos;
        const ids = wrap._grid ? wrap._grid.queryAt(px, py) : [];
        for (let i = ids.length - 1; i >= 0; i--) {
            const d = drawn[ids[i]];
            if (_hitRotatedBox({ x: d.x, y: d.y, w: d.w, h: d.h }, d.rotation || 0, px, py)) {
                ev.preventDefault();
                ctx.useTool("edit-text", { box: d, ref: d.item.self_ref, clickPos: pos });
                return;
            }
        }
    }

    onPointerUp(ev, pos, ctx) {
        const { wrap, doDraw } = ctx;
        if (state.drag?.markupId) return this._markupPointerUp(ev, pos, ctx);
        if (state.marquee) {
            state.marquee = null;
            doDraw();
            return;
        }
        const dr = state.drag;
        if (dr) {
            if (dr.moved) {
                const afterOv = _clone(state.bboxOverrides[dr.ref]);
                const desc = dr.mode === "rotate" ? "Rotate bbox"
                    : (dr.mode === "move" ? "Move bbox" : "Resize bbox");
                history.exec(new UpdateBboxCmd(dr.ref, dr.beforeOv, afterOv, desc));
            }
            if (dr.mode === "rotate") _hideRotateBadge();
            state.drag = null;
            wrap.classList.remove("dragging");
            doDraw();
        }
    }

    drawOverlay(canvasCtx, opts) {
        if (getLayer() !== "markup") return;
        const id = state.markupSelection?.id;
        if (!id) return;
        const shape = state.markup.find(s => s.id === id);
        if (!shape) return;
        const pageNo = _currentPageNo();
        if (shape.pageNo && shape.pageNo !== pageNo) return;
        const z = opts.zoom;
        const rot = shape.rotation || 0;
        const box = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
        canvasCtx.save();
        if (rot) {
            const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
            canvasCtx.translate(cx, cy);
            canvasCtx.rotate(rot * Math.PI / 180);
            canvasCtx.translate(-cx, -cy);
        }
        canvasCtx.strokeStyle = COLORS.primary;
        canvasCtx.lineWidth = 2 / z;
        canvasCtx.setLineDash([6 / z, 4 / z]);
        canvasCtx.strokeRect(box.x, box.y, box.w, box.h);
        canvasCtx.setLineDash([]);
        canvasCtx.restore();
        drawResizeHandles(canvasCtx, box, z, rot);
        drawRotationHandle(canvasCtx, box, rot, z);
    }

    _markupHover(ev, pos, ctx) {
        const { wrap } = ctx;
        const { x: px, y: py } = pos;
        const pageNo = _currentPageNo();
        let cur = "default";
        const selId = state.markupSelection?.id;
        if (selId) {
            const sel = state.markup.find(s => s.id === selId);
            if (sel && (!sel.pageNo || sel.pageNo === pageNo)) {
                const zNow = viewport.getZoom();
                const rot = sel.rotation || 0;
                const box = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
                if (_hitRotationHandle(box, rot, px, py, zNow)) {
                    cur = "grab";
                } else {
                    const handle = _hitHandle(box, px, py, zNow, rot);
                    if (handle) cur = RESIZE_CURSOR[handle] || "default";
                }
            }
        }
        if (cur === "default") {
            for (let i = state.markup.length - 1; i >= 0; i--) {
                const s = state.markup[i];
                if (s.pageNo && s.pageNo !== pageNo) continue;
                if (_hitShape(s, px, py)) { cur = "move"; break; }
            }
        }
        wrap.style.cursor = cur;
    }

    _markupPointerDown(ev, pos, ctx) {
        const { wrap, doDraw } = ctx;
        const { x: px, y: py } = pos;
        const pageNo = _currentPageNo();
        const selId = state.markupSelection?.id;
        if (selId) {
            const sel = state.markup.find(s => s.id === selId);
            if (sel && (!sel.pageNo || sel.pageNo === pageNo)) {
                const zNow = viewport.getZoom();
                const rot = sel.rotation || 0;
                const box = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
                if (_hitRotationHandle(box, rot, px, py, zNow)) {
                    ev.preventDefault();
                    state.drag = {
                        markupId: selId,
                        mode: "rotate",
                        startX: px, startY: py,
                        startShape: _clone(sel),
                        startRotation: rot,
                        moved: false,
                    };
                    wrap.classList.add("dragging");
                    return;
                }
                const handle = _hitHandle(box, px, py, zNow, rot);
                if (handle) {
                    ev.preventDefault();
                    state.drag = {
                        markupId: selId,
                        mode: handle,
                        startX: px, startY: py,
                        startShape: _clone(sel),
                        rotation: rot,
                        moved: false,
                    };
                    wrap.classList.add("dragging");
                    return;
                }
            }
        }
        let hit = null;
        for (let i = state.markup.length - 1; i >= 0; i--) {
            const s = state.markup[i];
            if (s.pageNo && s.pageNo !== pageNo) continue;
            if (_hitShape(s, px, py)) { hit = s; break; }
        }
        if (hit) {
            ev.preventDefault();
            state.markupSelection.id = hit.id;
            state.markupSelection.ids = new Set([hit.id]);
            state.drag = {
                markupId: hit.id,
                mode: "move",
                startX: px, startY: py,
                startShape: _clone(hit),
                moved: false,
            };
            wrap.classList.add("dragging");
        } else {
            state.markupSelection.id = null;
            state.markupSelection.ids = new Set();
        }
        ctx.helpers.updateInspector();
        doDraw();
    }

    _markupPointerMove(ev, pos, ctx) {
        const { doDraw } = ctx;
        const { x: px, y: py } = pos;
        const dr = state.drag;
        if (!dr || !dr.markupId) return;
        const shape = state.markup.find(s => s.id === dr.markupId);
        if (!shape) return;
        const dx = px - dr.startX;
        const dy = py - dr.startY;
        if (!dr.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD
            && dr.mode !== "rotate") return;
        dr.moved = true;
        const sb = dr.startShape;

        if (dr.mode === "rotate") {
            const cx = sb.x + sb.w / 2, cy = sb.y + sb.h / 2;
            const startAngle = Math.atan2(dr.startY - cy, dr.startX - cx);
            const curAngle = Math.atan2(py - cy, px - cx);
            const rawDeg = dr.startRotation + (curAngle - startAngle) * 180 / Math.PI;
            const snapped = _snapRotation(rawDeg, ev.shiftKey);
            shape.rotation = snapped;
            const isAtZero = snapped === 0 || (ev.shiftKey && (snapped % ROT_SHIFT_STEP_DEG === 0));
            _showRotateBadge(ev.clientX, ev.clientY, snapped, isAtZero);
            doDraw();
            return;
        }

        if (dr.mode === "move") {
            shape.x = sb.x + dx;
            shape.y = sb.y + dy;
        } else {
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
            if (LEFT || RIGHT) nw = Math.max(-aox * moX, MIN_SHAPE);
            if (TOP || BOTTOM) nh = Math.max(-aoy * moY, MIN_SHAPE);

            const ncX = anchorX + (-aox) * (nw / 2) * ex.x + (-aoy) * (nh / 2) * ey.x;
            const ncY = anchorY + (-aox) * (nw / 2) * ex.y + (-aoy) * (nh / 2) * ey.y;

            shape.x = ncX - nw / 2;
            shape.y = ncY - nh / 2;
            shape.w = nw;
            shape.h = nh;
        }
        doDraw();
    }

    _markupPointerUp(ev, pos, ctx) {
        const { wrap, doDraw } = ctx;
        const dr = state.drag;
        if (!dr || !dr.markupId) return;
        if (dr.moved) {
            const shape = state.markup.find(s => s.id === dr.markupId);
            if (shape) {
                const after = _clone(shape);
                Object.assign(shape, dr.startShape);
                const desc = dr.mode === "rotate" ? "Rotate markup"
                    : (dr.mode === "move" ? "Move markup" : "Resize markup");
                history.exec(new UpdateMarkupCmd(dr.markupId, dr.startShape, after, desc));
            }
        }
        if (dr.mode === "rotate") _hideRotateBadge();
        state.drag = null;
        wrap.classList.remove("dragging");
        doDraw();
    }
}
