const VALID_TOOLS = ["select", "pan", "shape-triangle", "shape-rect", "shape-circle", "shape-pen", "add-textbox"];
let _tool = "select";
const _listeners = new Set();

export function getTool() { return _tool; }

export function setTool(t) {
    if (!VALID_TOOLS.includes(t)) t = "select";
    if (_tool === t) return;
    _tool = t;
    const isShape = t.startsWith("shape-");
    document.querySelectorAll(".split-pane").forEach(p => {
        p.classList.toggle("pan-mode", t === "pan");
        p.classList.toggle("shape-mode", isShape);
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
