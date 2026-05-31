// Translate runner — batch translate + run/retry button + LLM-response → row helpers
// applyTranslationSuccess/Error exported เพื่อให้ preview-prompt reuse ตอน apply manual response

import { state } from "./state.js";
import { getCharacters, SPEAKER_SKIP, SPEAKER_AUTO } from "./characters.js";
import { EMOTION_AUTO, combineEmotion } from "./emotions.js";
import { buildSubTmRules } from "./sub-tm.js";
import { renderPreview } from "./preview.js";
import { buildCompareTable } from "./compare.js";
import {
    runState, runDom, getTranslateTarget,
    disableDuringRun, enableAfterRun,
    geminiThrottle, geminiTouch, parse429RetrySec,
    updateRetryButton,
} from "./run-state.js";

const { corrections, translations, speakerByRef } = state;

// ── row source: corrected > original ──
function rowSource(row) {
    const ref = row.dataset.ref;
    const orig = row.dataset.orig || "";
    return (ref && corrections[ref] !== undefined) ? corrections[ref] : orig;
}

// ── DOM helpers (apply{Success,Error} export → preview-prompt ใช้ apply manual response) ──
function markTranslatePending(row) {
    const cell = row.querySelector(".col-translated");
    cell.classList.add("pending");
    cell.classList.remove("error");
    cell.removeAttribute("title");
    cell.textContent = "Translating...";
    row.classList.add("active");
}
export function applyTranslationSuccess(row, translated, warning) {
    const cell = row.querySelector(".col-translated");
    cell.classList.remove("pending", "error", "warning");
    if (warning) {
        cell.classList.add("warning");
        cell.title = "⚠ " + warning;
    } else {
        cell.removeAttribute("title");
    }
    row.classList.remove("active");
    cell.textContent = translated;
    const ref = row.dataset.ref;
    if (ref) translations[ref] = translated;
}
export function applyTranslationError(row, errMsg) {
    const cell = row.querySelector(".col-translated");
    cell.classList.remove("pending", "warning");
    cell.classList.add("error");
    cell.textContent = "—";
    cell.title = "❌ " + errMsg;
    row.classList.remove("active");
}

// ── HTTP ──
async function translateOne(text, target, engine) {
    const res = await fetch("/translate", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ text, target, engine: engine || "qwen" }),
    });
    return res.json();
}

async function translateBatchCall(texts, target, engine, customRules, attempt, speakers, ids, emotions) {
    const defaultId = SPEAKER_AUTO;
    const speakerArr = speakers || texts.map(() => defaultId);
    const emotionArr = emotions || texts.map(() => EMOTION_AUTO);
    const res = await fetch("/translate-batch", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            texts, target,
            engine: engine || "qwen",
            custom_rules: customRules || "",
            attempt: attempt || 0,
            speakers: speakerArr,
            emotions: emotionArr,
            characters: getCharacters(),
            ids: ids || null,
            content_type: runDom.contentTypeSel?.value || "dialogue",
        }),
    });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`HTTP ${res.status} (non-JSON): ${body}`);
    }
    return res.json();
}

// ส่ง batch สำหรับ index list — return list ของ index ที่ยัง fail
async function processTranslateBatch(rows, indexes, batchSz, target, engine, customRules, attempt, label) {
    // pre-filter: SKIP speaker / empty source → set "" ไม่ส่ง LLM (กัน token เปล่า)
    const workIndexes = [];
    let skippedEmpty = 0;
    let skippedSkip = 0;
    for (const idx of indexes) {
        const ref = rows[idx].dataset.ref;
        if (ref && speakerByRef[ref] === SPEAKER_SKIP) {
            applyTranslationSuccess(rows[idx], "");
            skippedSkip++;
            continue;
        }
        const src = rowSource(rows[idx]);
        if (!src || !src.trim()) {
            applyTranslationSuccess(rows[idx], "");
            skippedEmpty++;
            continue;
        }
        workIndexes.push(idx);
    }
    indexes = workIndexes;
    if (skippedSkip + skippedEmpty > 0) console.log(`[translate] skipped ${skippedSkip} SKIP + ${skippedEmpty} empty`);

    const stillFailed = [];
    const total = rows.length;
    for (let start = 0; start < indexes.length; start += batchSz) {
        if (runState.abort) {
            stillFailed.push(...indexes.slice(start));
            break;
        }
        const sliceIdxs = indexes.slice(start, start + batchSz);
        const sliceRows = sliceIdxs.map(i => rows[i]);
        const sources = sliceRows.map(rowSource);
        const defaultId = SPEAKER_AUTO;
        const sliceSpeakers = sliceRows.map(r => speakerByRef[r.dataset.ref] || defaultId);
        const sliceEmotions = sliceRows.map(r => combineEmotion(
            state.emotionByRef[r.dataset.ref], state.emotion2ByRef[r.dataset.ref]
        ));
        sliceRows.forEach(markTranslatePending);
        await geminiThrottle(engine);
        if (runState.abort) {
            stillFailed.push(...indexes.slice(start));
            break;
        }
        try {
            const sliceIds = sliceIdxs.map(idx => idx + 1);
            const data = await translateBatchCall(sources, target, engine, customRules, attempt, sliceSpeakers, sliceIds, sliceEmotions);
            geminiTouch(engine);
            const errSample = data.error || (data.errors || []).find(e => e);
            const wait429 = parse429RetrySec(errSample);
            if (wait429 > 0) {
                sliceIdxs.forEach((idx, k) => {
                    applyTranslationError(sliceRows[k], `quota exceeded — wait ${(wait429/1000).toFixed(0)}s then click retry`);
                    stillFailed.push(idx);
                });
                runDom.correctProgress.textContent = `⛔ Gemini quota exceeded — stopping; wait ${(wait429/1000).toFixed(0)}s before retry`;
                stillFailed.push(...indexes.slice(start + sliceIdxs.length));
                break;
            }
            if (data.error) {
                sliceIdxs.forEach((idx, k) => {
                    applyTranslationError(sliceRows[k], data.error);
                    stillFailed.push(idx);
                });
            } else {
                const arr = data.translated || [];
                const errs = data.errors || [];
                sliceIdxs.forEach((idx, k) => {
                    const tr = arr[k] ?? "";
                    const er = errs[k];
                    if (tr && er) {
                        applyTranslationSuccess(sliceRows[k], tr, er);
                    } else if (er) {
                        applyTranslationError(sliceRows[k], er);
                        stillFailed.push(idx);
                    } else {
                        applyTranslationSuccess(sliceRows[k], tr);
                    }
                });
            }
        } catch (e) {
            geminiTouch(engine);
            sliceIdxs.forEach((idx, k) => {
                applyTranslationError(sliceRows[k], e.message);
                stillFailed.push(idx);
            });
        }
        const okCount = total - stillFailed.length - (indexes.length - start - sliceIdxs.length);
        runDom.correctProgress.textContent =
            `Translated ${okCount}/${total} (${label})${stillFailed.length ? ` — fail ${stillFailed.length}` : ""}`;
    }
    return stillFailed;
}

// ── button wiring ──

// Run Translate
runDom.runTranslateBtn.addEventListener("click", async () => {
    const compareArea = document.getElementById("compareArea");
    buildCompareTable();
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!rows.length) return;
    const target = getTranslateTarget();
    if (!target) { alert("Select a TM pair first — target language is derived from it."); return; }
    const engine = runDom.translateEngineSel.value;
    const rawBatch = parseInt(runDom.batchSizeInput.value || "1", 10);
    // batch=0 (ทั้งไฟล์) cap ที่ TRANSLATE_BATCH_AUTO_CAP กัน token overflow → many "missing" rows
    const AUTO_CAP = 30;
    let effectiveBatch;
    let autoCapped = false;
    if (rawBatch === 0) {
        if (rows.length > AUTO_CAP) {
            effectiveBatch = AUTO_CAP;
            autoCapped = true;
        } else {
            effectiveBatch = rows.length;
        }
    } else {
        effectiveBatch = Math.max(1, rawBatch);
    }
    // batch=1 ยังต้องผ่าน /translate-batch — translateOne ส่งแค่ {text, target, engine}
    // ทิ้ง custom_rules/speakers/characters/emotions ทั้งหมด → context หาย
    const useBatch = (engine === "qwen" || engine === "gemini");
    const batchLabel = (rawBatch === 0)
        ? (autoCapped ? `entire file capped at ${AUTO_CAP}/row of ${rows.length}` : `entire file (${rows.length})`)
        : String(effectiveBatch);
    if (autoCapped) {
        console.warn(`[translate] batch=0 + ${rows.length} rows → auto-capped at ${AUTO_CAP}/batch to avoid token overflow. ` +
                     `If you want one-shot, set batch explicitly to ${rows.length}.`);
    }

    runState.abort = false;
    disableDuringRun();

    const userRules = (runDom.customRulesEl.value || "").trim();
    const subTm = buildSubTmRules();
    const customRules = [userRules, subTm].filter(Boolean).join("\n\n");
    runState.lastFailedIndexes = [];
    runState.lastBatchUsed = effectiveBatch;
    runState.lastTranslateTarget = target;
    runState.lastCustomRules = customRules;
    runState.lastOperationType = "translate";
    runState.lastAttempt = 0;

    const total = rows.length;
    let errors = 0;

    if (useBatch) {
        const allIdx = Array.from({length: rows.length}, (_, i) => i);
        const failed = await processTranslateBatch(
            rows, allIdx, effectiveBatch, target, engine, customRules, 0, `batch=${batchLabel}`
        );
        runState.lastFailedIndexes = failed;
        errors = failed.length;
    } else {
        let done = 0, skipped = 0;
        for (const row of rows) {
            if (runState.abort) break;
            const ref = row.dataset.ref;
            if (ref && speakerByRef[ref] === SPEAKER_SKIP) {
                applyTranslationSuccess(row, "");
                done++; skipped++;
                runDom.correctProgress.textContent = `Translated ${done}/${total} — skipped ${skipped}${errors ? `, fail ${errors}` : ""}`;
                continue;
            }
            const source = rowSource(row);
            if (!source || !source.trim()) {
                applyTranslationSuccess(row, "");
                done++;
                runDom.correctProgress.textContent = `Translated ${done}/${total}${errors ? ` — fail ${errors}` : ""}`;
                continue;
            }
            markTranslatePending(row);
            try {
                const data = await translateOne(source, target, engine);
                if (data.error) { applyTranslationError(row, data.error); errors++; }
                else { applyTranslationSuccess(row, data.translated || ""); }
            } catch (e) {
                applyTranslationError(row, e.message); errors++;
            }
            done++;
            runDom.correctProgress.textContent = `Translated ${done}/${total}${skipped ? ` — skipped ${skipped}` : ""}${errors ? `, fail ${errors}` : ""}`;
        }
    }

    enableAfterRun();
    updateRetryButton();
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});

// Retry — dispatch ตาม lastOperationType (correct path เรียก processCorrectBatch จาก correct-runner)
runDom.retryFailedBtn.addEventListener("click", async () => {
    if (!runState.lastFailedIndexes.length) return;
    const compareArea = document.getElementById("compareArea");
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    const engine = runDom.translateEngineSel.value;
    const target = getTranslateTarget();
    if (!target) { alert("Select a TM pair first — target language is derived from it."); return; }
    runState.lastTranslateTarget = target;
    const nextBatch = engine === "gemini"
        ? runState.lastBatchUsed
        : Math.max(2, Math.floor(runState.lastBatchUsed / 2));
    const nextAttempt = runState.lastAttempt + 1;

    runState.abort = false;
    disableDuringRun();

    const idxs = runState.lastFailedIndexes.slice();
    let failed;
    if (runState.lastOperationType === "correct") {
        // dynamic import → lazy-load correct-runner only when retry-correct is invoked
        const cr = await import("./correct-runner.js");
        failed = await cr.processCorrectBatch(
            rows, idxs, nextBatch, engine, runState.lastCustomRules, nextAttempt,
            `retry#${nextAttempt} correct batch=${nextBatch}`
        );
    } else {
        failed = await processTranslateBatch(
            rows, idxs, nextBatch, target, engine, runState.lastCustomRules, nextAttempt,
            `retry#${nextAttempt} translate batch=${nextBatch}`
        );
    }
    runState.lastFailedIndexes = failed;
    runState.lastBatchUsed = nextBatch;
    runState.lastAttempt = nextAttempt;

    enableAfterRun();
    updateRetryButton();
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});
