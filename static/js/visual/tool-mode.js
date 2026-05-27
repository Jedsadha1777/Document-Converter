// Tool mode — select (default = ลูกศร, คลิก/drag bbox) | pan (มือจับ, drag เลื่อน viewport)
// Pattern อ้างอิงจาก reference/Ketchup/tools/{SelectTool,PanTool}.js

let _tool = "select";
const _listeners = new Set();

export function getTool() { return _tool; }

export function setTool(t) {
    if (t !== "select" && t !== "pan") t = "select";
    if (_tool === t) return;
    _tool = t;
    // sync cursor บน split panes (CSS .pan-mode override .split-pane cursor)
    document.querySelectorAll(".split-pane").forEach(p => {
        p.classList.toggle("pan-mode", t === "pan");
    });
    // sync active class บนปุ่ม toolbar
    document.querySelectorAll("[data-tool]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tool === t);
    });
    _listeners.forEach(fn => { try { fn(t); } catch (_) {} });
}

export function onToolChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

// wire ปุ่มที่มี data-tool=... ใน DOM ให้ setTool ตอนคลิก — call ครั้งเดียวตอน boot
export function initToolButtons() {
    document.querySelectorAll("[data-tool]").forEach(btn => {
        btn.addEventListener("click", () => setTool(btn.dataset.tool));
    });
    // sync initial state
    document.querySelectorAll("[data-tool]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tool === _tool);
    });
}
