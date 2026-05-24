// Single source for color tokens — แก้ที่นี่ที่เดียว ทุก module เห็นพร้อมกัน
// ตั้งชื่อแบบ semantic (purpose-based) ไม่ใช่ literal (red/blue) เพื่อให้ swap theme ง่าย

export const COLORS = {
    // ── Status / semantic ──
    error:        "#dc2626",  // red — error text, fail
    errorStrong:  "#b91c1c",  // red strong — TM error
    errorTitle:   "#991b1b",  // red darker — "retry fail:" label
    errorBg:      "#fee2e2",  // red light — error block bg
    success:      "#059669",  // green — success text
    successStrong:"#15803d",  // green strong — TM ok
    warning:      "#d97706",  // amber — corrected label
    warningBg:    "#fef3c7",  // amber light — warning block bg
    warningBgAlpha:"#fef3c744",// amber + alpha — corrected bbox fill

    // ── Text ──
    text:         "#0f172a",  // primary text (slate-900)
    textMuted:    "#6b7280",  // muted (gray-500)
    textStrong:   "#374151",  // strong labels (gray-700)
    textInverse:  "#fff",     // on-dark text

    // ── Borders / backgrounds ──
    border:       "#d1d5db",  // input border (gray-300)
    borderMuted:  "#9ca3af",  // untranslated overlay border
    bgLight:      "#f9fafb",  // meta box bg
    divider:      "#475569",  // tooltip divider

    // ── Primary (selection / focus / translated) ──
    primary:      "#2563eb",  // active selection, "texts" category
    primaryStrong:"#1e40af",  // translated overlay border / label
    primaryLight: "#bfdbfe",  // translation text in tooltip

    // ── Visual Preview ──
    categoryTexts:    "#2563eb",
    categoryTables:   "#dc2626",
    categoryPictures: "#059669",
    multiSelect:      "#7c3aed",  // violet — multi-select highlight
    marquee:          "#0066cc",  // marquee border
    marqueeFill:      "rgba(0, 102, 204, 0.1)",
    overlayBg:        "#ffffff",  // bbox text overlay bg (solid — fade เฉพาะกล่อง SKIP)

    // ── Preview prompt modal (code blocks) ──
    codeBg:       "#0f172a",  // request body bg
    codeText:     "#86efac",  // request body text (light green)
    codeAltBg:    "#fef3c7",  // characters JSON bg
    codeAltText:  "#78350f",  // characters JSON text
    promptBg:     "#0b1021",  // system/user prompt bg
    promptText:   "#e5e7eb",  // system prompt text
};
