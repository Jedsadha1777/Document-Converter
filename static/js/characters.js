// Character Persona management — LocalStorage + modal UI + dropdown option builder
// แต่ละ character กำหนด tone/persona ให้ LLM ใช้ตอนแปล

import { escapeHtml } from "./diff.js";
import { COLORS } from "./colors.js";

// sentinels — ตรงกับฝั่ง backend (config.py)
export const SPEAKER_SKIP = "__skip__";
export const SPEAKER_AUTO = "__auto__";

const CHARS_STORAGE_KEY = "doclingCharacters";

// internal state (reassignable)
let _characters = _loadFromStorage();

// sort by numeric id asc — id แรก = default character (เลขน้อยสุด)
// migrate data เก่าที่อาจสลับตำแหน่งจาก _nextCharId แบบ recycle ก่อน fix
function _sortById(arr) {
    return arr.slice().sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0));
}

function _loadFromStorage() {
    try {
        const raw = localStorage.getItem(CHARS_STORAGE_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length) return _sortById(arr);
        }
    } catch (_) {}
    // default — 1 character กลาง ๆ ไม่ระบุเพศ
    return [{
        id: "1",
        name: "General",
        gender: "",
        persona: "พูดเป็นกลาง สุภาพปานกลาง ไม่ระบุเพศ ไม่ใช้ค่ะ/ครับ",
    }];
}

function _saveToStorage() {
    try { localStorage.setItem(CHARS_STORAGE_KEY, JSON.stringify(_characters)); } catch (_) {}
}

// monotonic — max(ids)+1, ไม่ recycle id ที่ลบไป
// reason: id recycle ทำให้ speakerByRef[ref]="1" เก่าชี้ persona ตัวใหม่ที่บังเอิญได้ id 1
//         + ลำดับ UI ไม่เรียง (ลบ id 2 → เพิ่มใหม่ได้ id 2 → ไปอยู่ท้ายลิสต์)
function _nextCharId() {
    const ids = _characters.map(c => parseInt(c.id, 10)).filter(n => Number.isFinite(n));
    return String((ids.length ? Math.max(...ids) : 0) + 1);
}

// ── public API ──

export function getCharacters() { return _characters; }

// คืน function builder ที่ render <option> ให้ <select> โดยรับค่า selected
export function renderSpeakerOptions() {
    return (selectedId) => {
        const autoSel = selectedId === SPEAKER_AUTO ? " selected" : "";
        const skipSel = selectedId === SPEAKER_SKIP ? " selected" : "";
        const autoOpt = `<option value="${SPEAKER_AUTO}"${autoSel}>Auto (LLM picks)</option>`;
        const skipOpt = `<option value="${SPEAKER_SKIP}"${skipSel}>🚫 Don't translate</option>`;
        const charOpts = _characters.map(c => {
            const sel = c.id === selectedId ? " selected" : "";
            const meta = [c.name, c.gender].filter(Boolean).join(", ");
            return `<option value="${escapeHtml(c.id)}"${sel}>${escapeHtml(c.id + (meta ? " — " + meta : ""))}</option>`;
        }).join("");
        return autoOpt + skipOpt + charOpts;
    };
}

// ── modal UI ──

let _modal = null;

function _addCharRow(c, isDefault) {
    const list = document.getElementById("charsList");
    if (!c) c = { id: _nextCharId(), name: "", gender: "", age: "", persona: "" };
    const row = document.createElement("div");
    row.className = "char-row" + (isDefault ? " char-default" : "");
    row.dataset.id = c.id;
    row.innerHTML = `
        <span class="char-id-pill" title="character id">${escapeHtml(c.id)}</span>
        <input type="text" class="char-name" value="${escapeHtml(c.name || "")}" placeholder="Name (e.g. heroine)">
        <select class="char-gender" title="เพศ — กำหนด ค่ะ/ครับ + สรรพนามฝั่ง male/female">
            <option value="" ${!c.gender ? "selected" : ""}>Unspecified</option>
            <option value="female" ${c.gender === "female" ? "selected" : ""}>Female</option>
            <option value="male" ${c.gender === "male" ? "selected" : ""}>Male</option>
            <option value="other" ${c.gender === "other" ? "selected" : ""}>Other</option>
        </select>
        <select class="char-age" title="ช่วงอายุ — กำหนดสรรพนาม (หนู/ฉัน/พี่/ป้า/ยาย...)">
            <option value="" ${!c.age ? "selected" : ""}>Age range</option>
            <option value="child" ${c.age === "child" ? "selected" : ""}>Child (0–12)</option>
            <option value="teen" ${c.age === "teen" ? "selected" : ""}>Teen (13–22)</option>
            <option value="adult" ${c.age === "adult" ? "selected" : ""}>Adult (23–39)</option>
            <option value="middle" ${c.age === "middle" ? "selected" : ""}>Middle-aged (40–59)</option>
            <option value="senior" ${c.age === "senior" ? "selected" : ""}>Senior (60+)</option>
        </select>
        <textarea class="char-persona" rows="2" placeholder="Personality / mannerisms / speech style">${escapeHtml(c.persona || "")}</textarea>
        <button type="button" class="del-char" title="Delete">✕</button>
    `;
    row.querySelector(".del-char").addEventListener("click", () => row.remove());
    list.appendChild(row);
}

function _renderCharsList() {
    const list = document.getElementById("charsList");
    list.innerHTML = "";
    _characters.forEach((c, i) => _addCharRow(c, i === 0));
}

// ── Character auto-detection via copy/paste workflow ──

function _collectOcrCorpus() {
    // OCR + corrected ที่อยู่ในตาราง Compare — ใช้ corrected ถ้ามี ไม่งั้น orig
    const compareArea = document.getElementById("compareArea");
    if (!compareArea) return [];
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    const out = [];
    rows.forEach(r => {
        const orig = (r.dataset.orig || "").trim();
        // ถ้ามี corrected ก็เอา ไม่งั้น orig — corrected cell ใช้ data-attribute หรือ textarea
        const corr = (r.querySelector(".corr-text-cell")?.textContent ||
                      r.querySelector("textarea.corr-text")?.value || "").trim();
        const t = corr || orig;
        if (t) out.push(t);
    });
    return out;
}

// target language ของ persona text — ตาม tmPair dropdown
// gender/age = ค่าคงที่ enum (English) — ห้าม translate (UI select รับ value English)
const _PERSONA_LANG_BY_PAIR = {
    "jp-th": "Thai (ภาษาไทย)",
    "en-th": "Thai (ภาษาไทย)",
    "en-vn": "Vietnamese (Tiếng Việt)",
};

// ตัวอย่าง name label ตามภาษาปลายทาง — กัน Thai lock เวลา target ไม่ใช่ไทย
const _NAME_EXAMPLE_BY_PAIR = {
    "jp-th": '"John (จอห์น)" or "Narrator (ผู้บรรยาย)"',
    "en-th": '"John (จอห์น)" or "Narrator (ผู้บรรยาย)"',
    "en-vn": '"Narrator (Người kể chuyện)"',
};

function _buildDetectionPrompt() {
    const texts = _collectOcrCorpus();
    if (!texts.length) return null;
    const corpus = texts.map((t, i) => `[${i + 1}] ${t}`).join("\n");
    const limitRaw = parseInt(document.getElementById("charsDetectLimit")?.value, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 0;
    const tmPair = document.getElementById("tmPair")?.value || "";
    const personaLang = _PERSONA_LANG_BY_PAIR[tmPair] || "the target translation language";
    const nameEx = _NAME_EXAMPLE_BY_PAIR[tmPair] || '"Narrator (a label in the target language)"';
    // hard cap — บังคับให้ LLM ไม่เดาเกินจำนวนที่ user ตั้ง
    const limitLine = limit
        ? `LIMIT: return AT MOST ${limit} characters — pick the most important / most frequently appearing speakers. If more exist, prefer named recurring characters over one-off side characters.\n\n`
        : "";
    return (
        "Identify the main characters from this dialogue/narration. " +
        "Surface-level inference is fine — the user will refine afterward.\n\n" +
        `TARGET LANGUAGE for the 'persona' field: ${personaLang}.\n` +
        "Write the persona description IN THE TARGET LANGUAGE — it will be re-injected " +
        "into the translation prompt later, so it must read naturally to a translator working in that language.\n" +
        "gender / age = keep the enum values in English (they are fixed UI options, not translated).\n\n" +
        limitLine +
        "For each character, return:\n" +
        `  name (Keep original script/label AND append translation or descriptive label in ${personaLang} in parentheses, e.g., ${nameEx}),\n` +
        '  gender ("female" / "male" / "other" / "" if unclear) — English enum, do NOT translate,\n' +
        '  age ("child" / "teen" / "adult" / "middle" / "senior" / "" if unclear) — English enum, do NOT translate,\n' +
        `  persona (1-2 sentence description IN ${personaLang} — speech pattern / role / personality).\n\n` +
        "Output ONLY a JSON array — no markdown fences, no explanation:\n" +
        '[{"name":"...","gender":"...","age":"...","persona":"..."}, ...]\n\n' +
        "TEXT:\n" + corpus
    );
}

async function _copyDetectionPrompt(btn) {
    const prompt = _buildDetectionPrompt();
    if (!prompt) {
        alert("No OCR text in Compare table — upload a file + OCR first");
        return;
    }
    try {
        await navigator.clipboard.writeText(prompt);
        const orig = btn.textContent;
        btn.textContent = "✓ Copied — paste into Gemini";
        setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch (e) {
        alert("Clipboard copy failed: " + e.message);
    }
}

async function _pasteDetectionResponse() {
    let raw;
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        alert("Cannot read clipboard: " + e.message);
        return;
    }
    if (!raw || !raw.trim()) {
        alert("Clipboard empty");
        return;
    }
    // strip markdown fences / explanatory prose — keep first [ ... ] block
    let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const m = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (m) cleaned = m[0];
    let data;
    try {
        data = JSON.parse(cleaned);
    } catch (e) {
        alert("Failed to parse JSON: " + e.message + "\n\nExpected: [{name,gender,age,persona}, ...]");
        return;
    }
    if (!Array.isArray(data) || !data.length) {
        alert("Expected non-empty JSON array");
        return;
    }
    // REPLACE all — ทับทั้งหมด ไม่ merge (ตามที่ user สั่ง)
    // assign sequential ids ใหม่จาก 1 เพื่อ reset speakerByRef ที่อ้าง id เก่า
    let skipped = 0;
    const next = [];
    let nextId = 1;
    data.forEach(d => {
        const name = String(d.name || "").trim();
        if (!name) { skipped++; return; }
        next.push({
            id: String(nextId++),
            name,
            gender: String(d.gender || "").trim(),
            age: String(d.age || "").trim(),
            persona: String(d.persona || "").trim(),
        });
    });
    if (!next.length) {
        alert("No valid characters in response (all entries missing name)");
        return;
    }
    _characters = next;
    _renderCharsList();
    alert(`✓ Replaced with ${next.length} character(s)${skipped ? ", " + skipped + " skipped (no name)" : ""}\n\nReview rows then click Save to persist.`);
}

function _resetAllCharacters() {
    if (!confirm("Reset all characters to default (1 General)?\nExisting personas will be lost when you click Save.")) return;
    _characters = [{
        id: "1",
        name: "General",
        gender: "",
        age: "",
        persona: "พูดเป็นกลาง สุภาพปานกลาง ไม่ระบุเพศ ไม่ใช้ค่ะ/ครับ",
    }];
    _renderCharsList();
}

function _openModal() {
    if (!_modal) {
        _modal = document.createElement("div");
        _modal.className = "modal-backdrop";
        _modal.innerHTML = `
            <div class="modal-card chars" role="dialog">
                <h2><span class="material-symbols-outlined">groups</span>Characters / Speaker Persona</h2>
                <div style="font-size:13px; color:${COLORS.textMuted}; margin-bottom:8px;">
                    Set the persona for each character — when a speaker is chosen in the Compare table,
                    the LLM will translate using that voice (tone, mannerisms).<br>
                    The first character is the <strong>default</strong> for items without a speaker assigned.
                </div>
                <div id="charsList"></div>
                <div class="modal-foot">
                    <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                        <button type="button" id="charAddBtn" class="ghost">+ Add character</button>
                        <label style="font-size:12px; color:#374151; display:inline-flex; align-items:center; gap:4px;"
                               title="Hard cap — LLM จะ return ไม่เกินจำนวนนี้ — 0 = ไม่จำกัด">
                            limit:
                            <input type="number" id="charsDetectLimit" min="0" max="100" value="10"
                                   style="width:50px; padding:3px 5px; border:1px solid #d1d5db; border-radius:4px;">
                        </label>
                        <button type="button" id="charsDetectCopyBtn" class="ghost" title="Build a character-detection prompt with all OCR text and copy to clipboard — paste into Gemini/ChatGPT/Claude web">📋 Copy detect prompt</button>
                        <button type="button" id="charsDetectPasteBtn" class="ghost" title="Read LLM response (JSON array) from clipboard and REPLACE the entire character list">📥 Paste detected</button>
                        <button type="button" id="charsResetBtn" class="ghost" title="Clear all characters and reset to default (1 General). Must click Save to persist." style="color:#b91c1c;">🗑️ Reset all</button>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button type="button" id="charCancelBtn" class="ghost">Cancel</button>
                        <button type="button" id="charSaveBtn">Save</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(_modal);
        _modal.addEventListener("click", (e) => {
            if (e.target === _modal) _closeModal();
        });
        document.getElementById("charAddBtn").addEventListener("click", () => _addCharRow());
        document.getElementById("charsDetectCopyBtn").addEventListener("click", (e) => _copyDetectionPrompt(e.currentTarget));
        document.getElementById("charsDetectPasteBtn").addEventListener("click", _pasteDetectionResponse);
        document.getElementById("charsResetBtn").addEventListener("click", _resetAllCharacters);
        document.getElementById("charCancelBtn").addEventListener("click", _closeModal);
        document.getElementById("charSaveBtn").addEventListener("click", _saveFromModal);
    }
    _renderCharsList();
    _modal.classList.add("show");
}

function _closeModal() { if (_modal) _modal.classList.remove("show"); }

let _onChangeCallback = null;

function _saveFromModal() {
    const rows = _modal.querySelectorAll(".char-row");
    const next = [];
    rows.forEach(r => {
        const id = r.dataset.id;
        const name = r.querySelector(".char-name").value.trim();
        const gender = r.querySelector(".char-gender").value;
        const age = r.querySelector(".char-age").value;
        const persona = r.querySelector(".char-persona").value.trim();
        if (id) next.push({ id, name, gender, age, persona });
    });
    if (!next.length) {
        alert("At least 1 character is required");
        return;
    }
    _characters = _sortById(next);
    _saveToStorage();
    _closeModal();
    _onChangeCallback?.();
}

// wire ปุ่ม Characters + เก็บ callback ไว้ trigger หลัง save
export function initCharactersUI({ onChange } = {}) {
    _onChangeCallback = onChange || null;
    const btn = document.getElementById("charsBtn");
    btn?.addEventListener("click", _openModal);
}
