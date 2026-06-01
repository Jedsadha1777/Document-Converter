import { ITool } from "./ITool.js";
import { state } from "../../state.js";
import { history } from "../../history.js";
import { CreateMarkupCmd, UpdateMarkupCmd, DeleteMarkupCmd } from "../../commands.js";
import { packPenPath } from "./ShapeTool.js";
import { COLORS } from "../../colors.js";
import * as viewport from "../viewport.js";

const CLOSE_TOLERANCE_PX = 12;
const ANCHOR_TOLERANCE_PX = 8;
const HANDLE_TOLERANCE_PX = 12;
const SEGMENT_TOLERANCE_PX = 10;
const ANCHOR_DOT_R_PX = 4;
const SEGMENT_SAMPLES = 32;
const PATH_THICKNESS = 2;

const _isCtrlKey = (e) => e.key === "Control" || e.key === "Meta";
const _isCtrlEvent = (ev) => !!(ev.ctrlKey || ev.metaKey);

const _clone = (v) => v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));

function _currentPageNo() {
    const sel = document.getElementById("pageSelect");
    return parseInt(sel?.value || state.lastResult?.preview?.pages?.[0]?.page_no || 1, 10);
}

function _newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return "mk_" + crypto.randomUUID();
    return "mk_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function _cubic(B0, B1, B2, B3, t) {
    const omt = 1 - t;
    const w0 = omt * omt * omt, w1 = 3 * omt * omt * t, w2 = 3 * omt * t * t, w3 = t * t * t;
    return { x: w0 * B0.x + w1 * B1.x + w2 * B2.x + w3 * B3.x, y: w0 * B0.y + w1 * B1.y + w2 * B2.y + w3 * B3.y };
}

function _lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

function _constrainAngle(sx, sy, ex, ey) {
    const dx = ex - sx, dy = ey - sy;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: ex, y: ey };
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: sx + Math.cos(angle) * len, y: sy + Math.sin(angle) * len };
}

function _absAnchors(shape) {
    return (shape.points || []).map(p => ({
        x: shape.x + shape.w * (p.nx ?? 0),
        y: shape.y + shape.h * (p.ny ?? 0),
        hInDx: p.hInDx ?? 0, hInDy: p.hInDy ?? 0,
        hOutDx: p.hOutDx ?? 0, hOutDy: p.hOutDy ?? 0,
    }));
}

function _repackInto(shape, anchors, closed) {
    const packed = packPenPath(anchors, closed);
    shape.x = packed.x; shape.y = packed.y; shape.w = packed.w; shape.h = packed.h;
    shape.points = packed.points; shape.closed = !!closed;
}

function _hitAnchorOrHandle(a, px, py, anchorTolSq, handleTolSq) {
    if ((px - a.x) ** 2 + (py - a.y) ** 2 <= anchorTolSq) return "anchor";
    if (a.hInDx !== 0 || a.hInDy !== 0) {
        const hx = a.x + a.hInDx, hy = a.y + a.hInDy;
        if ((px - hx) ** 2 + (py - hy) ** 2 <= handleTolSq) return "hin";
    }
    if (a.hOutDx !== 0 || a.hOutDy !== 0) {
        const hx = a.x + a.hOutDx, hy = a.y + a.hOutDy;
        if ((px - hx) ** 2 + (py - hy) ** 2 <= handleTolSq) return "hout";
    }
    return null;
}

function _findHandleOnCommitted(pos, pageNo, handleTolSq) {
    for (let i = state.markup.length - 1; i >= 0; i--) {
        const s = state.markup[i];
        if (s.type !== "shape-pen" && s.type !== "pen") continue;
        if (s.pageNo && s.pageNo !== pageNo) continue;
        const anchors = _absAnchors(s);
        for (let j = 0; j < anchors.length; j++) {
            const a = anchors[j];
            if (a.hInDx !== 0 || a.hInDy !== 0) {
                const hx = a.x + a.hInDx, hy = a.y + a.hInDy;
                if ((pos.x - hx) ** 2 + (pos.y - hy) ** 2 <= handleTolSq) {
                    return { shape: s, shapeIdx: i, anchorIdx: j, side: "in" };
                }
            }
            if (a.hOutDx !== 0 || a.hOutDy !== 0) {
                const hx = a.x + a.hOutDx, hy = a.y + a.hOutDy;
                if ((pos.x - hx) ** 2 + (pos.y - hy) ** 2 <= handleTolSq) {
                    return { shape: s, shapeIdx: i, anchorIdx: j, side: "out" };
                }
            }
        }
    }
    return null;
}

function _mutateAnchor(a, kind, pos, symmetric, shiftHeld) {
    if (kind === "anchor") {
        a.x = pos.x; a.y = pos.y;
        return;
    }
    let dx = pos.x - a.x, dy = pos.y - a.y;
    if (shiftHeld) {
        const len = Math.hypot(dx, dy);
        if (len > 0) {
            const step = Math.PI / 4;
            const angle = Math.round(Math.atan2(dy, dx) / step) * step;
            dx = Math.cos(angle) * len; dy = Math.sin(angle) * len;
        }
    }
    if (kind === "hin") {
        a.hInDx = dx; a.hInDy = dy;
        if (symmetric) { a.hOutDx = -dx; a.hOutDy = -dy; }
    } else if (kind === "hout") {
        a.hOutDx = dx; a.hOutDy = dy;
        if (symmetric) { a.hInDx = -dx; a.hInDy = -dy; }
    }
}

export class PenTool extends ITool {
    constructor() {
        super("shape-pen", "shape-pen", { cursor: "crosshair" });
        this.isDrawing = false;
        this.points = [];
        this.isMouseDown = false;
        this.activeAnchorIdx = -1;
        this.dragMode = null;
        this.rawX = 0; this.rawY = 0;
        this.previewX = 0; this.previewY = 0;
        this.shiftHeld = false;
        this.altHeld = false;
        this.ctrlHeld = false;
        this.ctrlEdit = null;
        this.activeAnchor = null;
        this.hoverState = null;
        this._ctx = null;
        this._onKeyDown = null;
        this._onKeyUp = null;
    }

    activate(ctx) {
        ctx.wrap.style.cursor = "crosshair";
        this._ctx = ctx;
        this._onKeyDown = (e) => this._handleKeyDown(e, ctx);
        this._onKeyUp = (e) => this._handleKeyUp(e, ctx);
        this._onContextMenu = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
        document.addEventListener("keydown", this._onKeyDown);
        document.addEventListener("keyup", this._onKeyUp);
        document.addEventListener("contextmenu", this._onContextMenu, true);
        state.markupSelection.id = null;
        state.markupSelection.ids = new Set();
    }

    deactivate(ctx) {
        if (this._onKeyDown) document.removeEventListener("keydown", this._onKeyDown);
        if (this._onKeyUp) document.removeEventListener("keyup", this._onKeyUp);
        if (this._onContextMenu) document.removeEventListener("contextmenu", this._onContextMenu, true);
        this._onKeyDown = null;
        this._onKeyUp = null;
        this._onContextMenu = null;
        if (this.isDrawing && this.points.length >= 2 && this._ctx) {
            this._commit(this._ctx, false);
        }
        this._reset();
        if (ctx?.wrap) ctx.wrap.style.cursor = "default";
        this._ctx = null;
    }

    _reset() {
        this.isDrawing = false;
        this.points = [];
        this.isMouseDown = false;
        this.activeAnchorIdx = -1;
        this.dragMode = null;
        this.ctrlEdit = null;
        this.activeAnchor = null;
        this.hoverState = null;
    }

    _zoom() { return viewport.getZoom() || 1; }

    _isNearFirstAnchor(wx, wy) {
        if (this.points.length < 3) return false;
        const first = this.points[0];
        return Math.hypot(wx - first.x, wy - first.y) <= CLOSE_TOLERANCE_PX / this._zoom();
    }

    _handleKeyDown(e, ctx) {
        const tag = (e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
        const modKey = _isCtrlKey(e) || e.key === "Alt";
        if (e.key === "Shift") this.shiftHeld = true;
        if (e.key === "Alt") this.altHeld = true;
        if (_isCtrlKey(e)) this.ctrlHeld = true;
        if (modKey && !this.isDrawing && this._ctx) {
            this._updateHover({ x: this.rawX, y: this.rawY }, this._ctx);
        }
        if (!this.isDrawing && (e.key === "Backspace" || e.key === "Delete") && this.activeAnchor) {
            const shape = state.markup.find(s => s.id === this.activeAnchor.shapeId);
            if (shape && (shape.type === "shape-pen" || shape.type === "pen")) {
                e.preventDefault();
                const anchors = _absAnchors(shape);
                const idx = this.activeAnchor.anchorIdx;
                if (idx >= 0 && idx < anchors.length) {
                    this._deleteAnchor(ctx, shape, idx, anchors);
                    this.activeAnchor = null;
                    ctx.doDraw();
                }
            }
            return;
        }
        if (!this.isDrawing) return;
        if (e.key === "Escape") {
            e.preventDefault();
            this._reset();
            ctx.doDraw();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (this.points.length >= 2) this._commit(ctx, false);
            else this._reset();
            ctx.doDraw();
        } else if (e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            if (this.points.length > 1) this.points.pop();
            else this._reset();
            ctx.doDraw();
        }
    }

    _handleKeyUp(e, ctx) {
        const modKey = _isCtrlKey(e) || e.key === "Alt";
        if (e.key === "Shift") this.shiftHeld = false;
        if (e.key === "Alt") this.altHeld = false;
        if (_isCtrlKey(e)) this.ctrlHeld = false;
        if (modKey && !this.isDrawing && this._ctx) {
            this._updateHover({ x: this.rawX, y: this.rawY }, this._ctx);
        }
    }

    _findInProgAnchorIdx(pos) {
        const tolSq = (ANCHOR_TOLERANCE_PX / this._zoom()) ** 2;
        for (let i = 0; i < this.points.length; i++) {
            const a = this.points[i];
            if ((pos.x - a.x) ** 2 + (pos.y - a.y) ** 2 <= tolSq) return i;
        }
        return -1;
    }

    _findCommittedAnchor(pos) {
        const tolSq = (ANCHOR_TOLERANCE_PX / this._zoom()) ** 2;
        const pageNo = _currentPageNo();
        for (let i = state.markup.length - 1; i >= 0; i--) {
            const s = state.markup[i];
            if (s.type !== "shape-pen" && s.type !== "pen") continue;
            if (s.pageNo && s.pageNo !== pageNo) continue;
            const anchors = _absAnchors(s);
            for (let j = 0; j < anchors.length; j++) {
                const a = anchors[j];
                if ((pos.x - a.x) ** 2 + (pos.y - a.y) ** 2 <= tolSq) {
                    return { shape: s, shapeIdx: i, anchorIdx: j, anchors };
                }
            }
        }
        return null;
    }

    _findCommittedSegment(pos) {
        const tol = SEGMENT_TOLERANCE_PX / this._zoom();
        const anchorTolSq = (ANCHOR_TOLERANCE_PX / this._zoom()) ** 2;
        const pageNo = _currentPageNo();
        for (let i = state.markup.length - 1; i >= 0; i--) {
            const s = state.markup[i];
            if (s.type !== "shape-pen" && s.type !== "pen") continue;
            if (s.pageNo && s.pageNo !== pageNo) continue;
            const anchors = _absAnchors(s);
            const N = anchors.length;
            if (N < 2) continue;
            const segs = s.closed ? N : N - 1;
            for (let k = 0; k < segs; k++) {
                const a = anchors[k], b = anchors[(k + 1) % N];
                const B0 = { x: a.x, y: a.y };
                const B1 = { x: a.x + a.hOutDx, y: a.y + a.hOutDy };
                const B2 = { x: b.x + b.hInDx, y: b.y + b.hInDy };
                const B3 = { x: b.x, y: b.y };
                let bestT = -1, bestDistSq = Infinity, bestP = null;
                for (let t_i = 1; t_i < SEGMENT_SAMPLES; t_i++) {
                    const t = t_i / SEGMENT_SAMPLES;
                    const p = _cubic(B0, B1, B2, B3, t);
                    const dSq = (pos.x - p.x) ** 2 + (pos.y - p.y) ** 2;
                    if (dSq < bestDistSq) { bestDistSq = dSq; bestT = t; bestP = p; }
                }
                if (Math.sqrt(bestDistSq) > tol) continue;
                const onAnchor = anchors.some(an => (pos.x - an.x) ** 2 + (pos.y - an.y) ** 2 <= anchorTolSq);
                if (onAnchor) continue;
                return { shape: s, shapeIdx: i, segIdx: k, anchors, t: bestT, B0, B1, B2, B3, p: bestP };
            }
        }
        return null;
    }

    _tryCtrlEditDown(pos, ev, ctx) {
        const anchorTolSq = (ANCHOR_TOLERANCE_PX / this._zoom()) ** 2;
        const handleTolSq = (HANDLE_TOLERANCE_PX / this._zoom()) ** 2;
        if (this.isDrawing) {
            for (let i = 0; i < this.points.length; i++) {
                const hit = _hitAnchorOrHandle(this.points[i], pos.x, pos.y, anchorTolSq, handleTolSq);
                if (hit) {
                    this.ctrlEdit = { kind: hit, source: "inprogress", anchorIdx: i };
                    return true;
                }
            }
        }
        const pageNo = _currentPageNo();
        for (let i = state.markup.length - 1; i >= 0; i--) {
            const s = state.markup[i];
            if (s.type !== "shape-pen" && s.type !== "pen") continue;
            if (s.pageNo && s.pageNo !== pageNo) continue;
            const anchors = _absAnchors(s);
            for (let j = 0; j < anchors.length; j++) {
                const hit = _hitAnchorOrHandle(anchors[j], pos.x, pos.y, anchorTolSq, handleTolSq);
                if (hit) {
                    this.ctrlEdit = {
                        kind: hit, source: "committed",
                        anchorIdx: j, shape: s, origShape: _clone(s),
                    };
                    return true;
                }
            }
        }
        return false;
    }

    _applyCtrlEditMove(pos, ev, ctx) {
        const ce = this.ctrlEdit;
        if (!ce) return;
        const symmetric = !ev.altKey;
        if (ce.source === "inprogress") {
            const a = this.points[ce.anchorIdx];
            _mutateAnchor(a, ce.kind, pos, symmetric, ev.shiftKey);
            return;
        }
        const shape = ce.shape;
        const anchors = _absAnchors(shape);
        _mutateAnchor(anchors[ce.anchorIdx], ce.kind, pos, symmetric, ev.shiftKey);
        _repackInto(shape, anchors, !!shape.closed);
    }

    _commitCtrlEdit(ctx) {
        const ce = this.ctrlEdit;
        if (!ce || ce.source !== "committed") return;
        const shape = ce.shape;
        const before = ce.origShape;
        const after = _clone(shape);
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        Object.assign(shape, before);
        history.exec(new UpdateMarkupCmd(shape.id, before, after, "Edit anchor"));
    }

    onPointerDown(ev, pos, ctx) {
        ev.preventDefault();
        this.rawX = pos.x; this.rawY = pos.y;
        this.shiftHeld = ev.shiftKey;
        this.altHeld = ev.altKey;
        this.ctrlHeld = _isCtrlEvent(ev);

        const ctrlActive = _isCtrlEvent(ev) || this.ctrlHeld;
        if (ctrlActive) {
            if (this._tryCtrlEditDown(pos, ev, ctx)) {
                ctx.doDraw();
                return;
            }
            ctx.doDraw();
            return;
        }

        if (this.isDrawing && ev.altKey) {
            const idx = this._findInProgAnchorIdx(pos);
            if (idx >= 0) {
                this.activeAnchorIdx = idx;
                this.isMouseDown = true;
                this.dragMode = "handle";
                ctx.doDraw();
                return;
            }
        }

        if (this.isDrawing && this._isNearFirstAnchor(pos.x, pos.y)) {
            this._commit(ctx, true);
            ctx.doDraw();
            return;
        }

        if (!this.isDrawing) {
            const aHit = this._findCommittedAnchor(pos);
            if (aHit) {
                const { shape, anchorIdx, anchors } = aHit;
                const isEndpoint = !shape.closed && (anchorIdx === 0 || anchorIdx === anchors.length - 1);
                if (isEndpoint) {
                    this._resumeFromEndpoint(ctx, shape, anchorIdx, anchors);
                } else if (ev.altKey) {
                    this._convertAnchor(ctx, shape, anchorIdx, anchors);
                } else {
                    this.activeAnchor = { shapeId: shape.id, anchorIdx };
                }
                ctx.doDraw();
                return;
            }
            const sHit = this._findCommittedSegment(pos);
            if (sHit) {
                this._insertAnchorOnSegment(ctx, sHit);
                ctx.doDraw();
                return;
            }
        }

        let nx = pos.x, ny = pos.y;
        if (ev.shiftKey && this.points.length > 0) {
            const last = this.points[this.points.length - 1];
            const c = _constrainAngle(last.x, last.y, nx, ny);
            nx = c.x; ny = c.y;
        }

        if (!this.isDrawing) {
            this.isDrawing = true;
            this.points = [];
            this.activeAnchor = null;
        }

        this.points.push({ x: nx, y: ny, hInDx: 0, hInDy: 0, hOutDx: 0, hOutDy: 0 });
        this.activeAnchorIdx = this.points.length - 1;
        this.isMouseDown = true;
        this.dragMode = "handle";
        this.previewX = nx; this.previewY = ny;
        ctx.doDraw();
    }

    onPointerMove(ev, pos, ctx) {
        this.rawX = pos.x; this.rawY = pos.y;
        this.shiftHeld = ev.shiftKey;
        this.altHeld = ev.altKey;
        this.ctrlHeld = _isCtrlEvent(ev);

        if (this.ctrlEdit) {
            this._applyCtrlEditMove(pos, ev, ctx);
            ctx.doDraw();
            return;
        }

        if (this.isDrawing && this.isMouseDown && this.activeAnchorIdx >= 0) {
            const a = this.points[this.activeAnchorIdx];
            let dx = pos.x - a.x, dy = pos.y - a.y;
            if (ev.shiftKey) {
                const len = Math.hypot(dx, dy);
                if (len > 0) {
                    const step = Math.PI / 4;
                    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
                    dx = Math.cos(angle) * len; dy = Math.sin(angle) * len;
                }
            }
            a.hOutDx = dx; a.hOutDy = dy;
            a.hInDx = -dx; a.hInDy = -dy;
            ctx.doDraw();
            return;
        }

        if (this.isDrawing) {
            let px = pos.x, py = pos.y;
            if (ev.shiftKey && this.points.length > 0) {
                const last = this.points[this.points.length - 1];
                const c = _constrainAngle(last.x, last.y, px, py);
                px = c.x; py = c.y;
            }
            this.previewX = px; this.previewY = py;
            ctx.doDraw();
            return;
        }

        this._updateHover(pos, ctx);
    }

    onPointerUp(ev, pos, ctx) {
        if (this.ctrlEdit) {
            const ce = this.ctrlEdit;
            if (ce.source === "committed") {
                this._commitCtrlEdit(ctx);
                this.activeAnchor = { shapeId: ce.shape.id, anchorIdx: ce.anchorIdx };
            }
            this.ctrlEdit = null;
            ctx.doDraw();
            return;
        }
        this.isMouseDown = false;
        this.activeAnchorIdx = this.isDrawing ? (this.points.length - 1) : -1;
        this.dragMode = null;
        ctx.doDraw();
    }

    onDoubleClick(ev, pos, ctx) {
        if (this.isDrawing && this.points.length >= 2) {
            ev.preventDefault();
            this._commit(ctx, false);
            ctx.doDraw();
        }
    }

    _updateHover(pos, ctx) {
        let next = null;
        const ctrlHeld = this.ctrlHeld;
        const aHit = this._findCommittedAnchor(pos);
        if (aHit) {
            const { shape, anchorIdx, anchors } = aHit;
            const isEndpoint = !shape.closed && (anchorIdx === 0 || anchorIdx === anchors.length - 1);
            let kind;
            if (ctrlHeld) kind = "ctrl-anchor";
            else if (this.altHeld) kind = "convert";
            else kind = isEndpoint ? "endpoint" : "interior";
            next = { kind, shapeId: shape.id, anchorIdx };
        } else if (ctrlHeld) {
            const handleTolSq = (HANDLE_TOLERANCE_PX / this._zoom()) ** 2;
            const hHit = _findHandleOnCommitted(pos, _currentPageNo(), handleTolSq);
            if (hHit) {
                next = { kind: "ctrl-handle", shapeId: hHit.shape.id, anchorIdx: hHit.anchorIdx, side: hHit.side };
            }
        }
        if (!next) {
            const sHit = this._findCommittedSegment(pos);
            if (sHit) next = { kind: "segment", shapeId: sHit.shape.id, segIdx: sHit.segIdx, x: sHit.p.x, y: sHit.p.y };
        }
        const changed = !_sameHover(this.hoverState, next);
        this.hoverState = next;
        this._applyCursor(ctx);
        if (changed) ctx.doDraw();
    }

    _applyCursor(ctx) {
        const h = this.hoverState;
        if (!h) { ctx.wrap.style.cursor = this.cursor; return; }
        const map = {
            endpoint: "pointer", interior: "pointer", convert: "cell",
            segment: "copy", "ctrl-anchor": "move", "ctrl-handle": "move",
        };
        ctx.wrap.style.cursor = map[h.kind] || this.cursor;
    }

    _commit(ctx, closed) {
        if (this.points.length < 2) { this._reset(); return; }
        if (closed && this.points.length < 3) closed = false;
        const packed = packPenPath(this.points, closed);
        const fill = state.markupDefaults.fillColor;
        const lastIdx = packed.points.length - 1;
        const shape = {
            id: _newId(),
            type: "shape-pen",
            x: packed.x, y: packed.y, w: packed.w, h: packed.h,
            points: packed.points,
            closed: !!closed,
            fillColor: closed ? fill : null,
            strokeColor: COLORS.penPath,
            strokeWidth: PATH_THICKNESS,
            pageNo: _currentPageNo(),
        };
        history.exec(new CreateMarkupCmd(shape));
        this._reset();
        this.activeAnchor = { shapeId: shape.id, anchorIdx: lastIdx };
    }

    _resumeFromEndpoint(ctx, shape, anchorIdx, anchors) {
        let working = anchors.map(a => ({ ...a }));
        if (anchorIdx === 0) {
            working.reverse();
            for (const a of working) {
                const tx = a.hInDx, ty = a.hInDy;
                a.hInDx = a.hOutDx; a.hInDy = a.hOutDy;
                a.hOutDx = tx; a.hOutDy = ty;
            }
        }
        history.exec(new DeleteMarkupCmd(shape.id));
        this.isDrawing = true;
        this.points = working;
        this.activeAnchorIdx = -1;
        this.isMouseDown = false;
        this.activeAnchor = null;
    }

    _deleteAnchor(ctx, shape, anchorIdx, anchors) {
        const next = anchors.slice();
        next.splice(anchorIdx, 1);
        if (next.length < 2) {
            history.exec(new DeleteMarkupCmd(shape.id));
            this.activeAnchor = null;
            return;
        }
        let closed = !!shape.closed;
        if (closed && next.length < 3) closed = false;
        const before = _clone(shape);
        const after = _clone(shape);
        _repackInto(after, next, closed);
        history.exec(new UpdateMarkupCmd(shape.id, before, after, "Delete anchor"));
        const newIdx = Math.min(anchorIdx, next.length - 1);
        this.activeAnchor = { shapeId: shape.id, anchorIdx: newIdx };
    }

    _convertAnchor(ctx, shape, anchorIdx, anchors) {
        const next = anchors.map(a => ({ ...a }));
        const a = next[anchorIdx];
        const isSmooth = a.hInDx !== 0 || a.hInDy !== 0 || a.hOutDx !== 0 || a.hOutDy !== 0;
        if (isSmooth) {
            a.hInDx = 0; a.hInDy = 0; a.hOutDx = 0; a.hOutDy = 0;
        } else if (next.length >= 2) {
            const N = next.length;
            const prev = next[(anchorIdx - 1 + N) % N];
            const nx = next[(anchorIdx + 1) % N];
            let dx = nx.x - prev.x, dy = nx.y - prev.y;
            const len = Math.hypot(dx, dy);
            if (len > 0) {
                const target = Math.min(len / 3, 60);
                dx = dx / len * target; dy = dy / len * target;
            }
            a.hInDx = -dx; a.hInDy = -dy;
            a.hOutDx = dx; a.hOutDy = dy;
        }
        const before = _clone(shape);
        const after = _clone(shape);
        _repackInto(after, next, !!shape.closed);
        history.exec(new UpdateMarkupCmd(shape.id, before, after, "Convert anchor"));
    }

    _insertAnchorOnSegment(ctx, hit) {
        const { shape, segIdx, anchors, t, B0, B1, B2, B3 } = hit;
        const Q0 = _lerp(B0, B1, t), Q1 = _lerp(B1, B2, t), Q2 = _lerp(B2, B3, t);
        const R0 = _lerp(Q0, Q1, t), R1 = _lerp(Q1, Q2, t);
        const P = _lerp(R0, R1, t);
        const next = anchors.map(a => ({ ...a }));
        const N = next.length;
        const idxA = segIdx, idxB = (segIdx + 1) % N;
        next[idxA].hOutDx = Q0.x - B0.x; next[idxA].hOutDy = Q0.y - B0.y;
        next[idxB].hInDx = Q2.x - B3.x; next[idxB].hInDy = Q2.y - B3.y;
        next.splice(idxA + 1, 0, {
            x: P.x, y: P.y,
            hInDx: R0.x - P.x, hInDy: R0.y - P.y,
            hOutDx: R1.x - P.x, hOutDy: R1.y - P.y,
        });
        const before = _clone(shape);
        const after = _clone(shape);
        _repackInto(after, next, !!shape.closed);
        history.exec(new UpdateMarkupCmd(shape.id, before, after, "Insert anchor"));
        this.activeAnchor = { shapeId: shape.id, anchorIdx: idxA + 1 };
    }

    drawOverlay(canvasCtx, opts) {
        const z = opts.zoom || 1;
        this._drawCommittedAnchors(canvasCtx, z);
        if (!this.isDrawing || this.points.length === 0) return;

        if (this.points.length >= 2) {
            canvasCtx.save();
            canvasCtx.strokeStyle = COLORS.penPath;
            canvasCtx.lineWidth = PATH_THICKNESS;
            canvasCtx.lineCap = "round";
            canvasCtx.lineJoin = "round";
            canvasCtx.beginPath();
            canvasCtx.moveTo(this.points[0].x, this.points[0].y);
            for (let i = 0; i < this.points.length - 1; i++) {
                const a = this.points[i], b = this.points[i + 1];
                canvasCtx.bezierCurveTo(a.x + a.hOutDx, a.y + a.hOutDy, b.x + b.hInDx, b.y + b.hInDy, b.x, b.y);
            }
            canvasCtx.stroke();
            canvasCtx.restore();
        }

        if (!this.isMouseDown && !this.ctrlEdit && this.points.length >= 1) {
            const last = this.points[this.points.length - 1];
            canvasCtx.save();
            canvasCtx.strokeStyle = COLORS.penPath;
            canvasCtx.globalAlpha = 0.5;
            canvasCtx.lineWidth = PATH_THICKNESS;
            canvasCtx.lineCap = "round";
            canvasCtx.lineJoin = "round";
            canvasCtx.beginPath();
            canvasCtx.moveTo(last.x, last.y);
            canvasCtx.bezierCurveTo(last.x + last.hOutDx, last.y + last.hOutDy, this.previewX, this.previewY, this.previewX, this.previewY);
            canvasCtx.stroke();
            canvasCtx.restore();
        }

        canvasCtx.save();
        canvasCtx.strokeStyle = COLORS.marquee;
        canvasCtx.lineWidth = 1 / z;
        for (const a of this.points) {
            if (a.hInDx !== 0 || a.hInDy !== 0 || a.hOutDx !== 0 || a.hOutDy !== 0) {
                canvasCtx.beginPath();
                canvasCtx.moveTo(a.x + a.hInDx, a.y + a.hInDy);
                canvasCtx.lineTo(a.x + a.hOutDx, a.y + a.hOutDy);
                canvasCtx.stroke();
            }
        }
        canvasCtx.restore();

        if (!this.isMouseDown && !this.ctrlEdit && this._isNearFirstAnchor(this.rawX, this.rawY)) {
            const first = this.points[0];
            canvasCtx.save();
            canvasCtx.strokeStyle = COLORS.penEndpoint;
            canvasCtx.lineWidth = 2 / z;
            canvasCtx.beginPath();
            canvasCtx.arc(first.x, first.y, 8 / z, 0, Math.PI * 2);
            canvasCtx.stroke();
            canvasCtx.restore();
        }

        const r = ANCHOR_DOT_R_PX / z;
        canvasCtx.save();
        canvasCtx.fillStyle = COLORS.textInverse;
        canvasCtx.strokeStyle = COLORS.marquee;
        canvasCtx.lineWidth = 1.5 / z;
        for (const a of this.points) {
            canvasCtx.fillRect(a.x - r, a.y - r, r * 2, r * 2);
            canvasCtx.strokeRect(a.x - r, a.y - r, r * 2, r * 2);
            if (a.hInDx !== 0 || a.hInDy !== 0) {
                canvasCtx.beginPath();
                canvasCtx.arc(a.x + a.hInDx, a.y + a.hInDy, r * 0.85, 0, Math.PI * 2);
                canvasCtx.fill(); canvasCtx.stroke();
            }
            if (a.hOutDx !== 0 || a.hOutDy !== 0) {
                canvasCtx.beginPath();
                canvasCtx.arc(a.x + a.hOutDx, a.y + a.hOutDy, r * 0.85, 0, Math.PI * 2);
                canvasCtx.fill(); canvasCtx.stroke();
            }
        }
        canvasCtx.restore();
    }

    _drawCommittedAnchors(canvasCtx, z) {
        const pageNo = _currentPageNo();
        const baseR = ANCHOR_DOT_R_PX / z;
        const h = this.hoverState;
        for (const s of state.markup) {
            if (s.type !== "shape-pen" && s.type !== "pen") continue;
            if (s.pageNo && s.pageNo !== pageNo) continue;
            const anchors = _absAnchors(s);
            const N = anchors.length;
            const closed = !!s.closed;
            canvasCtx.save();
            canvasCtx.lineWidth = 1 / z;

            const focusIdx = (this.activeAnchor && this.activeAnchor.shapeId === s.id)
                ? this.activeAnchor.anchorIdx
                : (this.ctrlEdit && this.ctrlEdit.source === "committed" && this.ctrlEdit.shape && this.ctrlEdit.shape.id === s.id)
                    ? this.ctrlEdit.anchorIdx
                    : -1;
            if (focusIdx >= 0 && focusIdx < N) {
                const group = [focusIdx];
                if (closed) {
                    group.push((focusIdx - 1 + N) % N);
                    group.push((focusIdx + 1) % N);
                } else {
                    if (focusIdx > 0) group.push(focusIdx - 1);
                    if (focusIdx < N - 1) group.push(focusIdx + 1);
                }
                canvasCtx.strokeStyle = COLORS.marquee;
                canvasCtx.lineWidth = 1 / z;
                const drawn = new Set();
                for (const k of group) {
                    const a = anchors[k];
                    if (k === focusIdx) {
                        if (a.hInDx !== 0 || a.hInDy !== 0) {
                            canvasCtx.beginPath();
                            canvasCtx.moveTo(a.x, a.y);
                            canvasCtx.lineTo(a.x + a.hInDx, a.y + a.hInDy);
                            canvasCtx.stroke();
                            drawn.add(k + ":in");
                        }
                        if (a.hOutDx !== 0 || a.hOutDy !== 0) {
                            canvasCtx.beginPath();
                            canvasCtx.moveTo(a.x, a.y);
                            canvasCtx.lineTo(a.x + a.hOutDx, a.y + a.hOutDy);
                            canvasCtx.stroke();
                            drawn.add(k + ":out");
                        }
                    } else if (k === ((focusIdx - 1 + N) % N) && (closed || k === focusIdx - 1)) {
                        if (a.hOutDx !== 0 || a.hOutDy !== 0) {
                            canvasCtx.beginPath();
                            canvasCtx.moveTo(a.x, a.y);
                            canvasCtx.lineTo(a.x + a.hOutDx, a.y + a.hOutDy);
                            canvasCtx.stroke();
                            drawn.add(k + ":out");
                        }
                    } else if (k === ((focusIdx + 1) % N) && (closed || k === focusIdx + 1)) {
                        if (a.hInDx !== 0 || a.hInDy !== 0) {
                            canvasCtx.beginPath();
                            canvasCtx.moveTo(a.x, a.y);
                            canvasCtx.lineTo(a.x + a.hInDx, a.y + a.hInDy);
                            canvasCtx.stroke();
                            drawn.add(k + ":in");
                        }
                    }
                }
                const hr = 3 / z;
                canvasCtx.fillStyle = COLORS.textInverse;
                canvasCtx.lineWidth = 1 / z;
                for (const key of drawn) {
                    const colon = key.indexOf(":");
                    const k = parseInt(key.slice(0, colon), 10);
                    const side = key.slice(colon + 1);
                    const a = anchors[k];
                    const dx = side === "in" ? a.hInDx : a.hOutDx;
                    const dy = side === "in" ? a.hInDy : a.hOutDy;
                    canvasCtx.beginPath();
                    canvasCtx.arc(a.x + dx, a.y + dy, hr, 0, Math.PI * 2);
                    canvasCtx.fill();
                    canvasCtx.stroke();
                }
            }

            for (let j = 0; j < N; j++) {
                const a = anchors[j];
                const isEndpoint = !closed && (j === 0 || j === N - 1);
                const isHover = h && h.shapeId === s.id && h.anchorIdx === j
                    && (h.kind === "endpoint" || h.kind === "interior" || h.kind === "convert" || h.kind === "ctrl-anchor");
                const isActive = (this.activeAnchor && this.activeAnchor.shapeId === s.id && this.activeAnchor.anchorIdx === j)
                    || (this.ctrlEdit && this.ctrlEdit.source === "committed" && this.ctrlEdit.shape && this.ctrlEdit.shape.id === s.id && this.ctrlEdit.anchorIdx === j);
                const r = isHover ? baseR * 1.6 : baseR;
                if (isActive) {
                    canvasCtx.fillStyle = COLORS.marquee;
                } else {
                    canvasCtx.fillStyle = isEndpoint ? COLORS.penEndpointBg : COLORS.textInverse;
                }
                canvasCtx.strokeStyle = isEndpoint ? COLORS.penEndpoint : COLORS.marquee;
                canvasCtx.lineWidth = (isHover ? 2 : 1) / z;
                canvasCtx.fillRect(a.x - r, a.y - r, r * 2, r * 2);
                canvasCtx.strokeRect(a.x - r, a.y - r, r * 2, r * 2);
            }

            if (h && h.kind === "ctrl-handle" && h.shapeId === s.id && h.anchorIdx >= 0 && h.anchorIdx < N) {
                const a = anchors[h.anchorIdx];
                const hx = a.x + (h.side === "in" ? a.hInDx : a.hOutDx);
                const hy = a.y + (h.side === "in" ? a.hInDy : a.hOutDy);
                const r = baseR * 1.4;
                canvasCtx.fillStyle = COLORS.textInverse;
                canvasCtx.strokeStyle = COLORS.marquee;
                canvasCtx.lineWidth = 2 / z;
                canvasCtx.beginPath();
                canvasCtx.arc(hx, hy, r, 0, Math.PI * 2);
                canvasCtx.fill();
                canvasCtx.stroke();
            }
            canvasCtx.restore();
        }
        if (h && h.kind === "segment") {
            const x = h.x, y = h.y;
            const r = 7 / z;
            canvasCtx.save();
            canvasCtx.fillStyle = COLORS.textInverse;
            canvasCtx.strokeStyle = COLORS.marquee;
            canvasCtx.lineWidth = 1.5 / z;
            canvasCtx.beginPath();
            canvasCtx.arc(x, y, r, 0, Math.PI * 2);
            canvasCtx.fill(); canvasCtx.stroke();
            canvasCtx.strokeStyle = COLORS.marquee;
            canvasCtx.lineWidth = 2 / z;
            canvasCtx.beginPath();
            canvasCtx.moveTo(x - r * 0.5, y); canvasCtx.lineTo(x + r * 0.5, y);
            canvasCtx.moveTo(x, y - r * 0.5); canvasCtx.lineTo(x, y + r * 0.5);
            canvasCtx.stroke();
            canvasCtx.restore();
        }
    }
}

function _sameHover(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.kind === b.kind && a.shapeId === b.shapeId && a.anchorIdx === b.anchorIdx && a.segIdx === b.segIdx && a.side === b.side;
}
