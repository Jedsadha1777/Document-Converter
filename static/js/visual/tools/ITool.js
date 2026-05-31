export class ITool {
    constructor(id, title, options = {}) {
        this.id = id;
        this.title = title;
        this.icon = options.icon;
        this.cursor = options.cursor || "default";
    }

    activate(ctx) {}
    deactivate(ctx) {}
    onPointerDown(ev, pos, ctx) {}
    onPointerMove(ev, pos, ctx) {}
    onPointerUp(ev, pos, ctx) {}
    onDoubleClick(ev, pos, ctx) {}
    onContextMenu(ev, pos, ctx) {}
    drawOverlay(canvasCtx, opts) {}
}
