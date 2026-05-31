import { ITool } from "./ITool.js";
import { state } from "../../state.js";
import { history } from "../../history.js";
import { UpdateBboxCmd } from "../../commands.js";
import * as viewport from "../viewport.js";
import {
    _hitHandle, _hitRotationHandle, _hitRotatedBox, _aabbOfRotated,
} from "../geometry.js";

const DRAG_THRESHOLD = 4;
const MIN_BOX = 12;
const ROT_ZERO_SNAP_DEG = 3;
const ROT_SHIFT_STEP_DEG = 15;

const RESIZE_CURSOR = {
    n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
};

const _clone = (v) => v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));

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

}
