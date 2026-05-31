let _tool = "select";
const _listeners = new Set();

export function getTool() { return _tool; }

export function setTool(t) {
    if (t !== "select" && t !== "pan") t = "select";
    if (_tool === t) return;
    _tool = t;
    document.querySelectorAll(".split-pane").forEach(p => {
        p.classList.toggle("pan-mode", t === "pan");
    });
    document.querySelectorAll("[data-tool]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tool === t);
    });
    _listeners.forEach(fn => { try { fn(t); } catch (_) {} });
}

export function onToolChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

export function initToolButtons() {
    document.querySelectorAll("[data-tool]").forEach(btn => {
        btn.addEventListener("click", () => setTool(btn.dataset.tool));
    });
    document.querySelectorAll("[data-tool]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tool === _tool);
    });
}
