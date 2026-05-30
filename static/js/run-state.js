// LLM run-state — shared ระหว่าง correct-runner / translate-runner / preview-prompt
// เก็บ retry state, abort flag, config (Jinja-injected), DOM refs ของ toolbar
// + Gemini throttle helpers + UI sync (batch visibility, retry button label)

// ── mutable state (export-by-reference) ──
export const runState = {
    abort: false,            // stop button → loops อ่านระหว่าง iteration
    lastFailedIndexes: [],   // row indexes ที่ fail หลัง run ล่าสุด
    lastBatchUsed: 0,        // batch size ที่เพิ่งใช้
    lastTranslateTarget: "",
    lastCustomRules: "",     // rules ที่ใช้ตอน run ล่าสุด — retry ใช้ตัวเดียวกัน
    lastOperationType: "translate",  // "translate" | "correct"
    lastAttempt: 0,          // attempt counter — เพิ่มขึ้นทุก retry → backend ปรับ temp ให้ result ต่าง
};

export const runConfig = { batchSizeDefault: 5, geminiDelayMs: 0, geminiModel: "gemini-2.5-flash" };

// ── DOM refs (shared toolbar) ──
export const runDom = {
    correctProgress:   document.getElementById("correctProgress"),
    runCorrectBtn:     document.getElementById("runCorrectBtn"),
    runTranslateBtn:   document.getElementById("runTranslateBtn"),
    stopCorrectBtn:    document.getElementById("stopCorrectBtn"),
    retryFailedBtn:    document.getElementById("retryFailedBtn"),
    translateEngineSel:document.getElementById("translateEngine"),
    tmPairSel:         document.getElementById("tmPair"),
    contentTypeSel:    document.getElementById("contentType"),
    batchSizeInput:    document.getElementById("batchSize"),
    batchSizeLabel:    document.getElementById("batchSizeLabel"),
    customRulesEl:     document.getElementById("customRules"),
    engineHint:        document.getElementById("engineHint"),
};

// target language = ครึ่งหลังของ TM pair (jp-th → th, en-vn → vi, ฯลฯ)
const PAIR_TARGET = { "jp-th": "th", "en-th": "th", "en-vn": "vi" };
export function getTranslateTarget() {
    return PAIR_TARGET[runDom.tmPairSel?.value] || "";
}

// disable/enable ปุ่ม toolbar ระหว่าง run
export function disableDuringRun() {
    runDom.runCorrectBtn.disabled = true;
    runDom.runTranslateBtn.disabled = true;
    runDom.retryFailedBtn.disabled = true;
    runDom.stopCorrectBtn.disabled = false;
}
export function enableAfterRun() {
    runDom.runCorrectBtn.disabled = false;
    runDom.runTranslateBtn.disabled = false;
    runDom.stopCorrectBtn.disabled = true;
}

// Gemini rate-limit (5 RPM free tier) — กัน quota หมด, delay จาก runConfig.geminiDelayMs
let _lastGeminiCallAt = 0;
export async function geminiThrottle(engine) {
    const delay = runConfig.geminiDelayMs;
    if (engine !== "gemini" || delay <= 0) return;
    const elapsed = Date.now() - _lastGeminiCallAt;
    if (elapsed < delay) {
        const wait = delay - elapsed;
        runDom.correctProgress.textContent = `⏳ wait ${(wait/1000).toFixed(1)}s (Gemini rate limit)...`;
        await new Promise(r => setTimeout(r, wait));
    }
}
export function geminiTouch(engine) {
    if (engine === "gemini") _lastGeminiCallAt = Date.now();
}

// ตรวจ 429 จาก error string — return delay ms ที่ต้องรอ (0 = ไม่ใช่ 429)
export function parse429RetrySec(errMsg) {
    if (!errMsg || typeof errMsg !== "string") return 0;
    if (!errMsg.includes("RESOURCE_EXHAUSTED") && !errMsg.includes("429")) return 0;
    const m = errMsg.match(/retry in ([\d.]+)s/i) || errMsg.match(/retryDelay['"]?\s*[:=]\s*['"]?(\d+)s/i);
    if (m) return Math.ceil(parseFloat(m[1])) * 1000 + 1000;  // +1s buffer
    return 30000;  // fallback 30s
}

// ── retry button label + batch visibility (engine-dependent) ──
export function updateRetryButton() {
    const n = runState.lastFailedIndexes.length;
    const ICON = '<span class="material-symbols-outlined">replay</span>';
    if (n === 0) {
        runDom.retryFailedBtn.disabled = true;
        runDom.retryFailedBtn.innerHTML = `${ICON}retry fail`;
        return;
    }
    runDom.retryFailedBtn.disabled = false;
    const engine = runDom.translateEngineSel.value;
    const nextBatch = engine === "gemini"
        ? runState.lastBatchUsed
        : Math.max(2, Math.floor(runState.lastBatchUsed / 2));
    const opLabel = runState.lastOperationType === "correct" ? "correct" : "translate";
    runDom.retryFailedBtn.innerHTML = `${ICON}retry ${opLabel} (${n}) batch=${nextBatch}`;
}

let _prevEngine = null;
export function syncBatchVisibility() {
    const eng = runDom.translateEngineSel.value;
    const supportsBatch = (eng === "qwen" || eng === "gemini");
    runDom.batchSizeLabel.style.display = supportsBatch ? "inline-flex" : "none";
    runDom.retryFailedBtn.style.display = supportsBatch ? "" : "none";
    if (eng === "qwen") {
        runDom.engineHint.textContent = "qwen2.5:1.5b via Ollama";
    } else if (eng === "gemini") {
        runDom.engineHint.textContent = `Gemini (${runConfig.geminiModel || "gemini-2.5-flash"})`;
    } else if (eng === "nllb") {
        runDom.engineHint.textContent = "NLLB-200 distilled-600M (local)";
    } else {
        runDom.engineHint.textContent = "Apple Translate (Shortcuts CLI)";
    }
    // Gemini ใช้ทั้งไฟล์ (context ใหญ่ + rate limit ตึง), Qwen ใช้ batch default จาก config
    if (eng !== _prevEngine) {
        if (eng === "gemini") runDom.batchSizeInput.value = "0";
        else if (eng === "qwen") runDom.batchSizeInput.value = String(runConfig.batchSizeDefault);
        _prevEngine = eng;
    }
}
runDom.translateEngineSel.addEventListener("change", syncBatchVisibility);
syncBatchVisibility();

// initRunState — เซ็ต config จาก Jinja + force re-apply batch default
export function applyRunConfig(cfg) {
    Object.assign(runConfig, cfg || {});
    _prevEngine = null;
    syncBatchVisibility();
}
