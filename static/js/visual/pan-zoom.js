import * as viewport from "./viewport.js";

export function initPanZoom(container, { shouldPan } = {}) {
    if (!container) return;

    container.addEventListener("wheel", (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            // cursor ต้อง pane-local (zoom-wrap absolute ใน .split-pane, fitToViewport ใช้ pane size)
            const pane = e.target.closest(".split-pane") || container;
            const rect = pane.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            viewport.zoomAt(cx, cy, factor);
        } else {
            e.preventDefault();
            viewport.panBy(-e.deltaX, -e.deltaY);
        }
    }, { passive: false });

    let panning = false;
    let lastX = 0, lastY = 0;
    let panPane = null;

    container.addEventListener("mousedown", (e) => {
        if (e.button === 1 || (e.button === 0 && e.altKey) ||
            (shouldPan && shouldPan(e))) {
            panning = true;
            lastX = e.clientX;
            lastY = e.clientY;
            panPane = e.target.closest(".split-pane");
            if (panPane) panPane.classList.add("panning");
            e.preventDefault();
        }
    });
    document.addEventListener("mousemove", (e) => {
        if (!panning) return;
        viewport.panBy(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
    });
    document.addEventListener("mouseup", () => {
        if (!panning) return;
        panning = false;
        if (panPane) panPane.classList.remove("panning");
        panPane = null;
    });

    document.addEventListener("keydown", (e) => {
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        const visualActive = document.querySelector(".tab.active")?.dataset.tab === "visual";
        if (!visualActive) return;
        const rect = container.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        if (e.key === "0") { viewport.reset(); _refit(container); e.preventDefault(); }
        else if (e.key === "1") {
            const cur = viewport.getZoom() || 1;
            viewport.zoomAt(cx, cy, 1 / cur);
            e.preventDefault();
        }
        else if (e.key === "+" || e.key === "=") { viewport.zoomAt(cx, cy, 1.25); e.preventDefault(); }
        else if (e.key === "-" || e.key === "_") { viewport.zoomAt(cx, cy, 0.8); e.preventDefault(); }
    });
}

function _refit(container) {
    const pane = document.getElementById("previewArea");
    if (!pane) return;
    const r = pane.getBoundingClientRect();
    const p = window.state?.lastResult?.preview?.pages?.[0];
    if (!p) return;
    const w = p.img_width || p.width || 1;
    const h = p.img_height || p.height || 1;
    viewport.fitToViewport(w, h, r.width, r.height);
}
