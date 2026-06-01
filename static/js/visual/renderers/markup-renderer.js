import { state } from "../../state.js";
import { drawShape } from "../tools/ShapeTool.js";

export function renderMarkup(ctx, opts) {
    const { pageNo, z } = opts;
    const shapes = state.markup || [];
    if (shapes.length === 0) return;
    for (const s of shapes) {
        if (s.pageNo && s.pageNo !== pageNo) continue;
        const hasFill = s.fillColor != null;
        const hasStroke = s.strokeColor != null;
        const rot = s.rotation || 0;
        const isPen = s.type === "shape-pen" || s.type === "pen";
        ctx.save();
        if (rot) {
            const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
            ctx.translate(cx, cy);
            ctx.rotate(rot * Math.PI / 180);
            ctx.translate(-cx, -cy);
        }
        if (hasFill) ctx.fillStyle = s.fillColor;
        if (hasStroke) {
            ctx.strokeStyle = s.strokeColor;
            ctx.lineWidth = (s.strokeWidth || 1) / z;
            if (isPen) { ctx.lineCap = "round"; ctx.lineJoin = "round"; }
        }
        drawShape(ctx, s.type, s.x, s.y, s.w, s.h, {
            fill: hasFill, stroke: hasStroke,
            points: s.points, closed: s.closed,
        });
        ctx.restore();
    }
}
