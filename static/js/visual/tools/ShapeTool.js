import { ITool } from "./ITool.js";
import { state } from "../../state.js";
import { history } from "../../history.js";
import { CreateMarkupCmd } from "../../commands.js";

const MIN_SIZE = 5;

export class ShapeTool extends ITool {
    constructor(id, shapeType) {
        super(id, shapeType);
        this.shapeType = shapeType;
        this.isDrawing = false;
        this.startX = 0;
        this.startY = 0;
        this.preview = null;
        this._shiftHeld = false;
    }

    activate(ctx) {
        ctx.wrap.style.cursor = "crosshair";
    }

    deactivate(ctx) {
        this.isDrawing = false;
        this.preview = null;
        if (ctx?.wrap) ctx.wrap.style.cursor = "default";
    }

    _dragDelta(pos, shift) {
        let w = pos.x - this.startX;
        let h = pos.y - this.startY;
        if (shift) {
            const size = Math.max(Math.abs(w), Math.abs(h));
            w = size * Math.sign(w || 1);
            h = size * Math.sign(h || 1);
        }
        return { w, h };
    }

    onPointerDown(ev, pos, ctx) {
        if (ev.button !== 0) return;
        ev.preventDefault();
        this.isDrawing = true;
        this.startX = pos.x;
        this.startY = pos.y;
        this._shiftHeld = !!ev.shiftKey;
        this.preview = { x: pos.x, y: pos.y, w: 0, h: 0 };
    }

    onPointerMove(ev, pos, ctx) {
        if (!this.isDrawing) return;
        this._shiftHeld = !!ev.shiftKey;
        const { w, h } = this._dragDelta(pos, this._shiftHeld);
        this.preview = { x: this.startX, y: this.startY, w, h };
        ctx.doDraw();
    }

    onPointerUp(ev, pos, ctx) {
        if (!this.isDrawing) return;
        this.isDrawing = false;
        const { w, h } = this._dragDelta(pos, this._shiftHeld);
        this.preview = null;
        if (Math.abs(w) < MIN_SIZE || Math.abs(h) < MIN_SIZE) {
            ctx.doDraw();
            return;
        }
        const x = Math.min(this.startX, this.startX + w);
        const y = Math.min(this.startY, this.startY + h);
        const aw = Math.abs(w);
        const ah = Math.abs(h);
        const pageNo = _currentPageNo();
        const shape = {
            id: _newId(),
            type: this.shapeType,
            x, y, w: aw, h: ah,
            fillColor: state.markupDefaults.fillColor,
            strokeColor: null,
            strokeWidth: 0,
            pageNo,
        };
        history.exec(new CreateMarkupCmd(shape));
        ctx.doDraw();
    }

    drawOverlay(canvasCtx, opts) {
        if (!this.preview) return;
        const { x, y, w, h } = this.preview;
        canvasCtx.save();
        canvasCtx.fillStyle = state.markupDefaults.fillColor;
        drawShape(canvasCtx, this.shapeType, x, y, w, h, { fill: true, stroke: false });
        canvasCtx.restore();
    }
}

export function drawShape(ctx, type, x, y, w, h, opts = {}) {
    const fill = opts.fill !== false;
    const stroke = opts.stroke === true;
    ctx.beginPath();
    if (type === "shape-rect" || type === "rect") {
        ctx.rect(x, y, w, h);
    } else if (type === "shape-circle" || type === "circle") {
        const cx = x + w / 2;
        const cy = y + h / 2;
        ctx.ellipse(cx, cy, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
    } else if (type === "shape-triangle" || type === "triangle") {
        const apexX = x + w / 2;
        ctx.moveTo(apexX, y);
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x, y + h);
        ctx.closePath();
    } else if (type === "shape-pen" || type === "pen") {
        const anchors = _denormAnchors(opts.points, x, y, w, h);
        if (anchors.length < 2) return;
        ctx.moveTo(anchors[0].x, anchors[0].y);
        for (let i = 0; i < anchors.length - 1; i++) {
            const a = anchors[i], b = anchors[i + 1];
            ctx.bezierCurveTo(a.x + a.hOutDx, a.y + a.hOutDy, b.x + b.hInDx, b.y + b.hInDy, b.x, b.y);
        }
        if (opts.closed && anchors.length >= 3) {
            const last = anchors[anchors.length - 1], first = anchors[0];
            ctx.bezierCurveTo(last.x + last.hOutDx, last.y + last.hOutDy, first.x + first.hInDx, first.y + first.hInDy, first.x, first.y);
            ctx.closePath();
        }
    } else {
        return;
    }
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
}

function _denormAnchors(points, x, y, w, h) {
    if (!points || !points.length) return [];
    return points.map(p => ({
        x: x + w * (p.nx ?? 0),
        y: y + h * (p.ny ?? 0),
        hInDx: p.hInDx || 0, hInDy: p.hInDy || 0,
        hOutDx: p.hOutDx || 0, hOutDy: p.hOutDy || 0,
    }));
}

const PEN_SAMPLES_PER_SEG = 16;
function _sampleAnchors(anchors, closed) {
    if (anchors.length < 2) return anchors.map(a => ({ x: a.x, y: a.y }));
    const out = [{ x: anchors[0].x, y: anchors[0].y }];
    const N = anchors.length;
    const segs = closed ? N : N - 1;
    for (let i = 0; i < segs; i++) {
        const a = anchors[i], b = anchors[(i + 1) % N];
        const c1x = a.x + a.hOutDx, c1y = a.y + a.hOutDy;
        const c2x = b.x + b.hInDx, c2y = b.y + b.hInDy;
        for (let k = 1; k <= PEN_SAMPLES_PER_SEG; k++) {
            const t = k / PEN_SAMPLES_PER_SEG;
            const omt = 1 - t;
            const w0 = omt * omt * omt;
            const w1 = 3 * omt * omt * t;
            const w2 = 3 * omt * t * t;
            const w3 = t * t * t;
            out.push({
                x: w0 * a.x + w1 * c1x + w2 * c2x + w3 * b.x,
                y: w0 * a.y + w1 * c1y + w2 * c2y + w3 * b.y,
            });
        }
    }
    return out;
}

export function samplePenShape(shape) {
    return _sampleAnchors(_denormAnchors(shape.points, shape.x, shape.y, shape.w, shape.h), !!shape.closed);
}

export function packPenPath(rawPoints, closed) {
    const samples = _sampleAnchors(rawPoints, !!closed);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of samples) {
        if (s.x < minX) minX = s.x;
        if (s.y < minY) minY = s.y;
        if (s.x > maxX) maxX = s.x;
        if (s.y > maxY) maxY = s.y;
    }
    const rangeX = maxX - minX, rangeY = maxY - minY;
    const w = Math.max(1, rangeX), h = Math.max(1, rangeY);
    const points = rawPoints.map(p => ({
        nx: rangeX === 0 ? 0 : (p.x - minX) / rangeX,
        ny: rangeY === 0 ? 0 : (p.y - minY) / rangeY,
        hInDx: p.hInDx || 0, hInDy: p.hInDy || 0,
        hOutDx: p.hOutDx || 0, hOutDy: p.hOutDy || 0,
    }));
    return { x: minX, y: minY, w, h, points };
}

function _currentPageNo() {
    const sel = document.getElementById("pageSelect");
    return parseInt(sel?.value || state.lastResult?.preview?.pages?.[0]?.page_no || 1, 10);
}

function _newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return "mk_" + crypto.randomUUID();
    }
    return "mk_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
