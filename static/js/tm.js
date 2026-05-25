// Translation Memory (TM) — Faiss-backed glossary suggestions

import { state } from "./state.js";
import { COLORS } from "./colors.js";
import { runDom } from "./run-state.js";
import { SPEAKER_SKIP } from "./characters.js";

const tmSuggestBtn = document.getElementById("tmSuggestBtn");
const tmBuildBtn = document.getElementById("tmBuildBtn");
const tmPairSel = document.getElementById("tmPair");
const tmFinalKEl = document.getElementById("tmFinalK");
const tmStatusEl = document.getElementById("tmStatus");

const TM_BLOCK_BEGIN = "=== TM Suggestions (auto-generated — re-run to refresh) ===";
const TM_BLOCK_END = "=== End TM Suggestions ===";

// อ่าน source ต่อ row — corrected ถ้ามี, ไม่งั้น original
// filter SKIP + empty ออก — ไม่ต้อง embed row ที่ไม่ได้จะแปล (ประหยัด Ollama embed call)
function _collectSources() {
    const compareArea = document.getElementById("compareArea");
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    const out = [];
    for (const r of rows) {
        const ref = r.dataset.ref;
        if (ref && state.speakerByRef[ref] === SPEAKER_SKIP) continue;
        const orig = r.dataset.orig || "";
        const t = (ref && state.corrections[ref] !== undefined) ? state.corrections[ref] : orig;
        if (t && t.trim()) out.push(t);
    }
    return out;
}

function _replaceTmBlock(textarea, tmText) {
    const cur = textarea.value || "";
    const beginIdx = cur.indexOf(TM_BLOCK_BEGIN);
    const endIdx = cur.indexOf(TM_BLOCK_END);
    const newBlock = `${TM_BLOCK_BEGIN}\n${tmText}\n${TM_BLOCK_END}`;
    if (beginIdx >= 0 && endIdx > beginIdx) {
        const before = cur.slice(0, beginIdx).replace(/\s+$/, "");
        const after = cur.slice(endIdx + TM_BLOCK_END.length).replace(/^\s+/, "");
        textarea.value = [before, newBlock, after].filter(s => s).join("\n\n");
    } else {
        const userPart = cur.trim();
        textarea.value = userPart ? userPart + "\n\n" + newBlock : newBlock;
    }
}

// content_type = folder name ใน data_tm/{pair}/{type}/ = domain โดยตรง → filter เป็น [type] ตรงๆ

async function tmSuggest() {
    const sources = _collectSources();
    if (!sources.length) {
        tmStatusEl.textContent = "no OCR rows yet — convert a file first";
        tmStatusEl.style.color = COLORS.errorStrong;
        return;
    }
    const pair = tmPairSel.value || "jp-th";
    const finalK = parseInt(tmFinalKEl.value, 10) || 20;
    const contentType = runDom.contentTypeSel?.value || "";
    const domainFilter = contentType ? [contentType] : null;
    tmSuggestBtn.disabled = true;
    tmStatusEl.style.color = COLORS.textMuted;
    tmStatusEl.textContent = `embedding ${sources.length} queries (${contentType})…`;
    try {
        const res = await fetch("/tm/suggest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                texts: sources, pair, final_k: finalK, auto_build: true,
                domain_filter: domainFilter,
            }),
        });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
            const body = (await res.text()).slice(0, 300);
            throw new Error(`HTTP ${res.status} (non-JSON): ${body}`);
        }
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        const stats = data.stats || {};
        if (!data.rules_text) {
            tmStatusEl.textContent = `no matches (n_index_rows=${stats.n_index_rows || "?"})`;
            tmStatusEl.style.color = COLORS.errorStrong;
            return;
        }
        _replaceTmBlock(runDom.customRulesEl, data.rules_text);
        tmStatusEl.style.color = COLORS.successStrong;
        tmStatusEl.textContent = `${stats.n_returned} rules from ${stats.n_queries} queries (index=${stats.n_index_rows})`;
        const dbg = data.per_query_debug || [];
        if (dbg.length) {
            const sample = dbg.slice(0, 5).map((d, i) => {
                const q = (d.q || "").slice(0, 60);
                const s = (d.top_score != null) ? d.top_score.toFixed(3) : "-";
                const t = (d.top_source || "").slice(0, 60);
                return `[q${i}] "${q}…" → score=${s} | "${t}…"`;
            }).join("\n");
            console.log("[TM] per-query top hits:\n" + sample);
            tmStatusEl.title = sample + (dbg.length > 5 ? `\n…(+${dbg.length - 5} more)` : "");
        }
        if (Array.isArray(data.hits) && data.hits.length) {
            console.log(`[TM] final ${data.hits.length} hits (sorted by final_score desc):`);
            console.table(data.hits.map(h => ({
                final: h.final_score,
                cos: h.max_score,
                lex: h.lex_score,
                abs: h.abs_overlap,
                len: h.src_len,
                hits: h.n_hits,
                row: h.row,
                source: (h.source || "").slice(0, 80),
            })));
        }
    } catch (err) {
        tmStatusEl.style.color = COLORS.errorStrong;
        tmStatusEl.textContent = "error: " + err.message;
    } finally {
        tmSuggestBtn.disabled = false;
    }
}

async function tmBuild() {
    if (!confirm("Rebuild ALL TM indexes (every pair folder under data_tm/)? This calls the embedding model for every TU and can take several minutes per pair.")) return;
    tmBuildBtn.disabled = true;
    tmStatusEl.style.color = COLORS.textMuted;
    tmStatusEl.textContent = "building all indexes…";
    try {
        const res = await fetch("/tm/build", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
            const body = (await res.text()).slice(0, 300);
            throw new Error(`HTTP ${res.status} (non-JSON): ${body}`);
        }
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        const ms = data.manifests || [];
        const summary = ms.map(m => `${m.pair}(n=${m.n_rows})`).join(", ");
        tmStatusEl.style.color = COLORS.successStrong;
        tmStatusEl.textContent = `built ✓ pairs=${ms.length} → ${summary}`;
    } catch (err) {
        tmStatusEl.style.color = COLORS.errorStrong;
        tmStatusEl.textContent = "build error: " + err.message;
    } finally {
        tmBuildBtn.disabled = false;
    }
}

tmSuggestBtn.addEventListener("click", tmSuggest);
tmBuildBtn.addEventListener("click", tmBuild);
