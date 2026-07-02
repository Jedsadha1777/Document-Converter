// Status bar helpers — progress line ใน #status
// kind: "success" | "error" | "info" — match กับ CSS .statusbar.show.{kind}

export function setStatus(msg, kind) {
    const el = document.getElementById("status");
    if (!el) return;
    el.textContent = kind === "error" ? msg : "";
    el.title = msg || "";
    el.className = "statusbar show " + (kind || "info");
}

export function clearStatus() {
    const el = document.getElementById("status");
    if (!el) return;
    el.className = "statusbar";
    el.textContent = "";
    el.title = "";
}
