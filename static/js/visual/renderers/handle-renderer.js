import { COLORS } from "../../colors.js";
import { HANDLE_SIZE, _rotationHandleLocalPos } from "../geometry.js";

const _ROTATE_ICON_SVG_D = "M15.55,5.55L11,1v3.07C7.06,4.56,4,7.92,4,12s3.05,7.44,7,7.93v-2.02c-2.84-0.48-5-2.94-5-5.91s2.16-5.43,5-5.91V10l4.55-4.45z M19.93,11c-0.17-1.39-0.72-2.73-1.62-3.89l-1.42,1.42c0.54,0.75,0.88,1.6,1.02,2.47H19.93z M13,17.9v2.02c1.39-0.17,2.74-0.71,3.9-1.61l-1.44-1.44C14.71,17.4,13.87,17.74,13,17.9z M16.89,15.48l1.42,1.41c0.9-1.16,1.45-2.5,1.62-3.89h-2.02C17.77,13.88,17.43,14.73,16.89,15.48z";
let _rotateIconPath = null;
function _getRotateIconPath() {
    if (!_rotateIconPath) _rotateIconPath = new Path2D(_ROTATE_ICON_SVG_D);
    return _rotateIconPath;
}

function _applyRotation(ctx, x, y, w, h, rotDeg) {
    if (!rotDeg) return;
    const cx = x + w / 2, cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rotDeg * Math.PI / 180);
    ctx.translate(-cx, -cy);
}

export function drawResizeHandles(ctx, box, zoom = 1, rotDeg = 0) {
    const z = Math.max(0.01, zoom);
    const hs = HANDLE_SIZE / z;
    const pts = [
        [box.x,              box.y],
        [box.x + box.w / 2,  box.y],
        [box.x + box.w,      box.y],
        [box.x + box.w,      box.y + box.h / 2],
        [box.x + box.w,      box.y + box.h],
        [box.x + box.w / 2,  box.y + box.h],
        [box.x,              box.y + box.h],
        [box.x,              box.y + box.h / 2],
    ];
    ctx.save();
    _applyRotation(ctx, box.x, box.y, box.w, box.h, rotDeg);
    ctx.fillStyle = COLORS.textInverse;
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = 2 / z;
    for (const [px, py] of pts) {
        ctx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
        ctx.strokeRect(px - hs / 2, py - hs / 2, hs, hs);
    }
    ctx.restore();
}

export function drawRotationHandle(ctx, box, rotDeg, zoom) {
    const z = Math.max(0.01, zoom);
    const local = _rotationHandleLocalPos(box, z);
    const r = 7 / z;
    const lw = 1.5 / z;
    ctx.save();
    _applyRotation(ctx, box.x, box.y, box.w, box.h, rotDeg);
    ctx.beginPath();
    ctx.moveTo(local.x, box.y + box.h);
    ctx.lineTo(local.x, local.y - r);
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(local.x, local.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.textInverse;
    ctx.fill();
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = lw;
    ctx.stroke();
    const iconSize = r * 1.55;
    const scale = iconSize / 24;
    ctx.save();
    ctx.translate(local.x - iconSize / 2, local.y - iconSize / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle = COLORS.primary;
    ctx.fill(_getRotateIconPath());
    ctx.restore();
    ctx.restore();
}
