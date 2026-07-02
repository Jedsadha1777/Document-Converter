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

// e.code (KeyV/KeyH/KeyP) ไม่ใช่ e.key — กัน layout แป้นไทยพิมพ์อักษรอื่น
const _TOOL_KEYS = { KeyV: "select", KeyH: "pan", KeyP: "shape-pen" };
let _spacePrevTool = null;

export function initToolButtons() {
    document.querySelectorAll("[data-tool]").forEach(btn => {
        btn.addEventListener("click", () => setTool(btn.dataset.tool));
    });
    document.querySelectorAll("[data-tool]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tool === _tool);
    });

    document.addEventListener("keydown", (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const tag = (e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
        if (document.querySelector(".tab.active")?.dataset.tab !== "visual") return;

        if (e.code === "Space") {
            e.preventDefault();
            if (e.repeat) return;
            if (_spacePrevTool === null && _tool !== "pan") {
                _spacePrevTool = _tool;
                setTool("pan");
            }
            return;
        }

        const t = _TOOL_KEYS[e.code];
        if (!t) return;
        const btn = document.querySelector(`[data-tool="${t}"]`);
        // ปุ่มถูกซ่อน = เครื่องมือไม่พร้อมใน layer ปัจจุบัน (เช่น pen นอก markup)
        if (!btn || btn.offsetParent === null) return;
        setTool(t);
    });
    document.addEventListener("keyup", (e) => {
        if (e.code !== "Space" || _spacePrevTool === null) return;
        setTool(_spacePrevTool);
        _spacePrevTool = null;
    });
}
