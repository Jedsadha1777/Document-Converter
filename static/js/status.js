// Status bar helpers — แสดงข้อความสั้นๆ ใน #status (success/error/info)
// kind: "success" | "error" | "info" — match กับ CSS .status.show.{kind}

export function setStatus(msg, kind) {
    const el = document.getElementById("status");
    if (!el) return;
    el.textContent = msg;
    el.className = "status show " + (kind || "");
}

export function clearStatus() {
    const el = document.getElementById("status");
    if (!el) return;
    el.className = "status";
    el.textContent = "";
}
