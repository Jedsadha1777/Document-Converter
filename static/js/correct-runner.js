// Correct runner — batch LLM proofread + stop/clear + per-row context (apple/nllb path)
// processCorrectBatch exported สำหรับ retry-correct path ใน translate-runner (dynamic import)

import { state } from "./state.js";
import { diffChars, renderDiffSide } from "./diff.js";
import { renderPreview } from "./preview.js";
import { buildCompareTable } from "./compare.js";
import {
    runState, runDom,
    disableDuringRun, enableAfterRun,
    geminiThrottle, geminiTouch, parse429RetrySec,
    updateRetryButton,
} from "./run-state.js";

const { corrections, translations, manualEdits, manualTranslations } = state;

const clearCorrectBtn = document.getElementById("clearCorrectBtn");

// ── DOM helpers ──
function _applyCorrectResult(row, orig, corrected) {
    const origCell = row.querySelector(".col-original");
    const cell = row.querySelector(".col-corrected");
    cell.classList.remove("pending", "error");
    cell.removeAttribute("title");
    row.classList.remove("active");
    let changed = false;
    if (corrected.trim() !== orig.trim()) {
        const ops = diffChars(orig, corrected);
        origCell.innerHTML = renderDiffSide(ops, "orig");
        cell.innerHTML = renderDiffSide(ops, "corr");
        row.classList.add("changed");
        changed = true;
    } else {
        cell.textContent = corrected;
        row.classList.add("same");
    }
    const ref = row.dataset.ref;
    if (ref) corrections[ref] = corrected;
    return changed;
}
function _applyCorrectError(row, errMsg) {
    const origCell = row.querySelector(".col-original");
    const cell = row.querySelector(".col-corrected");
    cell.classList.remove("pending");
    cell.classList.add("error");
    // คืน original ลง col-corrected (ถือว่า "ไม่มีการแก้") + reset diff display
    const orig = row.dataset.orig || "";
    cell.textContent = orig;
    cell.title = "❌ " + errMsg;
    origCell.textContent = orig;
    row.classList.remove("active", "changed", "same");
}
function _markCorrectPending(row) {
    const cell = row.querySelector(".col-corrected");
    cell.classList.add("pending");
    cell.classList.remove("error");
    cell.removeAttribute("title");
    cell.textContent = "Correcting...";
    row.classList.add("active");
}

// ── HTTP ──
async function correctOne(text, before, after, engine, customRules) {
    const res = await fetch("/correct", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            text,
            context_before: before || [],
            context_after: after || [],
            engine: engine || "qwen",
            custom_rules: customRules || "",
        }),
    });
    return res.json();
}
async function correctBatchCall(texts, engine, customRules, attempt) {
    const res = await fetch("/correct-batch", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            texts,
            engine: engine || "qwen",
            custom_rules: customRules || "",
            attempt: attempt || 0,
        }),
    });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`HTTP ${res.status} (non-JSON): ${body}`);
    }
    return res.json();
}

// ส่ง correct batch สำหรับ index list — return list ของ index ที่ยัง fail
export async function processCorrectBatch(rows, indexes, batchSz, engine, customRules, attempt, label) {
    // pre-filter: empty source → set corrected = "" ทันที ไม่ส่ง LLM
    const workIndexes = [];
    let skippedEmpty = 0;
    for (const idx of indexes) {
        const orig = rows[idx].dataset.orig || "";
        if (!orig || !orig.trim()) {
            _applyCorrectResult(rows[idx], orig, orig);
            skippedEmpty++;
        } else {
            workIndexes.push(idx);
        }
    }
    indexes = workIndexes;
    if (skippedEmpty > 0) console.log(`[correct] skipped ${skippedEmpty} empty rows`);

    const stillFailed = [];
    const total = rows.length;
    let changed = 0;
    for (let start = 0; start < indexes.length; start += batchSz) {
        if (runState.abort) {
            stillFailed.push(...indexes.slice(start));
            break;
        }
        const sliceIdxs = indexes.slice(start, start + batchSz);
        const sliceRows = sliceIdxs.map(i => rows[i]);
        const sources = sliceRows.map(r => r.dataset.orig || "");
        sliceRows.forEach(_markCorrectPending);
        await geminiThrottle(engine);
        if (runState.abort) {
            stillFailed.push(...indexes.slice(start));
            break;
        }
        try {
            const data = await correctBatchCall(sources, engine, customRules, attempt);
            geminiTouch(engine);
            const errSample = data.error || (data.errors || []).find(e => e);
            const wait429 = parse429RetrySec(errSample);
            if (wait429 > 0) {
                sliceIdxs.forEach((idx, k) => {
                    _applyCorrectError(sliceRows[k], `quota exceeded — wait ${(wait429/1000).toFixed(0)}s then click retry`);
                    stillFailed.push(idx);
                });
                runDom.correctProgress.textContent = `⛔ Gemini quota exceeded — stopping; wait ${(wait429/1000).toFixed(0)}s before retry`;
                stillFailed.push(...indexes.slice(start + sliceIdxs.length));
                break;
            }
            if (data.error) {
                sliceIdxs.forEach((idx, k) => {
                    _applyCorrectError(sliceRows[k], data.error);
                    stillFailed.push(idx);
                });
            } else {
                const arr = data.corrected || [];
                const errs = data.errors || [];
                sliceIdxs.forEach((idx, k) => {
                    if (errs[k]) {
                        _applyCorrectError(sliceRows[k], errs[k]);
                        stillFailed.push(idx);
                    } else {
                        if (_applyCorrectResult(sliceRows[k], sources[k], arr[k] ?? sources[k])) {
                            changed++;
                        }
                    }
                });
            }
        } catch (e) {
            geminiTouch(engine);
            sliceIdxs.forEach((idx, k) => {
                _applyCorrectError(sliceRows[k], e.message);
                stillFailed.push(idx);
            });
        }
        const okCount = total - stillFailed.length - (indexes.length - start - sliceIdxs.length);
        runDom.correctProgress.textContent =
            `Corrected ${okCount}/${total} (${label}) — changed ${changed}${stillFailed.length ? `, fail ${stillFailed.length}` : ""}`;
    }
    return stillFailed;
}

// ── button wiring ──
runDom.runCorrectBtn.addEventListener("click", async () => {
    const compareArea = document.getElementById("compareArea");
    buildCompareTable();
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!rows.length) return;

    const engine = runDom.translateEngineSel.value;
    const customRules = (runDom.customRulesEl.value || "").trim();
    const rawBatch = parseInt(runDom.batchSizeInput.value || "1", 10);
    const effectiveBatch = (rawBatch === 0) ? rows.length : Math.max(1, rawBatch);
    const useBatch = (engine === "qwen" || engine === "gemini") && effectiveBatch > 1;
    const batchLabel = (rawBatch === 0) ? `entire file (${rows.length})` : String(effectiveBatch);

    runState.abort = false;
    disableDuringRun();

    runState.lastFailedIndexes = [];
    runState.lastBatchUsed = effectiveBatch;
    runState.lastCustomRules = customRules;
    runState.lastOperationType = "correct";
    runState.lastAttempt = 0;

    const total = rows.length;

    if (useBatch) {
        const allIdx = Array.from({length: rows.length}, (_, i) => i);
        const failed = await processCorrectBatch(
            rows, allIdx, effectiveBatch, engine, customRules, 0, `batch=${batchLabel}`
        );
        runState.lastFailedIndexes = failed;
    } else {
        // non-batch engine (apple/nllb) → ส่ง /correct ทีละ row พร้อม before/after context
        let done = 0, changed = 0, errors = 0;
        const contextWindow = [];
        const allOrigs = rows.map(r => r.dataset.orig || '');

        for (let idx = 0; idx < rows.length; idx++) {
            if (runState.abort) break;
            const row = rows[idx];
            const orig = row.dataset.orig || row.querySelector(".col-original").textContent;
            if (!orig || !orig.trim()) {
                _applyCorrectResult(row, orig, orig);
                contextWindow.push(orig);
                done++;
                continue;
            }
            _markCorrectPending(row);
            try {
                const before = contextWindow.slice(-5);
                const after = allOrigs.slice(idx + 1, idx + 6);
                const data = await correctOne(orig, before, after, engine, customRules);
                if (data.error) {
                    _applyCorrectError(row, data.error);
                    errors++;
                    contextWindow.push(orig);
                } else {
                    const corr = data.corrected || "";
                    if (_applyCorrectResult(row, orig, corr)) changed++;
                    contextWindow.push(corr);
                }
            } catch (e) {
                _applyCorrectError(row, e.message);
                errors++;
                contextWindow.push(orig);
            }
            done++;
            runDom.correctProgress.textContent = `${done}/${total} — changed ${changed}, fail ${errors}`;
        }
    }

    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();

    enableAfterRun();
    updateRetryButton();
});

runDom.stopCorrectBtn.addEventListener("click", () => {
    runState.abort = true;
    runDom.stopCorrectBtn.disabled = true;
});

clearCorrectBtn.addEventListener("click", () => {
    Object.keys(corrections).forEach(k => delete corrections[k]);
    Object.keys(translations).forEach(k => delete translations[k]);
    manualEdits.clear();
    manualTranslations.clear();
    // clear retry state — fail indices ของ run เก่าใช้ไม่ได้แล้วเพราะ result ถูกล้างไปด้วย
    runState.lastFailedIndexes = [];
    runState.lastAttempt = 0;
    buildCompareTable(true);
    updateRetryButton();
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});
