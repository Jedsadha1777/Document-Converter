let _layer = "subtitle";
const _listeners = new Set();

function _applyDOM(l) {
    document.querySelectorAll("[data-layer]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.layer === l);
    });
    const sub = document.getElementById("subtitleTools");
    const shape = document.getElementById("shapeTools");
    if (sub) sub.style.display = l === "subtitle" ? "inline-flex" : "none";
    if (shape) shape.style.display = l === "markup" ? "inline-flex" : "none";
}

export function getLayer() { return _layer; }

export function setLayer(l) {
    if (l !== "subtitle" && l !== "markup") l = "subtitle";
    if (_layer === l) return;
    _layer = l;
    _applyDOM(l);
    _listeners.forEach(fn => { try { fn(l); } catch (_) {} });
}

export function onLayerChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

export function initLayerButtons() {
    document.querySelectorAll("[data-layer]").forEach(btn => {
        btn.addEventListener("click", () => setLayer(btn.dataset.layer));
    });
    _applyDOM(_layer);
}
