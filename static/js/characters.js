// Character Persona management — LocalStorage + modal UI + dropdown option builder
// แต่ละ character กำหนด tone/persona ให้ LLM ใช้ตอนแปล

import { escapeHtml } from "./diff.js";
import { COLORS } from "./colors.js";

// sentinel — ตรงกับฝั่ง backend
export const SPEAKER_SKIP = "__skip__";

const CHARS_STORAGE_KEY = "doclingCharacters";

// internal state (reassignable)
let _characters = _loadFromStorage();

function _loadFromStorage() {
    try {
        const raw = localStorage.getItem(CHARS_STORAGE_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length) return arr;
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

function _nextCharId() {
    const used = new Set(_characters.map(c => c.id));
    let n = 1;
    while (used.has(String(n))) n++;
    return String(n);
}

// ── public API ──

export function getCharacters() { return _characters; }

// คืน function builder ที่ render <option> ให้ <select> โดยรับค่า selected
export function renderSpeakerOptions() {
    return (selectedId) => {
        const skipSel = selectedId === SPEAKER_SKIP ? " selected" : "";
        const skipOpt = `<option value="${SPEAKER_SKIP}"${skipSel}>🚫 Don't translate</option>`;
        const charOpts = _characters.map(c => {
            const sel = c.id === selectedId ? " selected" : "";
            const meta = [c.name, c.gender].filter(Boolean).join(", ");
            return `<option value="${escapeHtml(c.id)}"${sel}>${escapeHtml(c.id + (meta ? " — " + meta : ""))}</option>`;
        }).join("");
        return skipOpt + charOpts;
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

function _openModal() {
    if (!_modal) {
        _modal = document.createElement("div");
        _modal.className = "modal-backdrop";
        _modal.innerHTML = `
            <div class="modal-card" role="dialog">
                <h2><span class="material-symbols-outlined">groups</span>Characters / Speaker Persona</h2>
                <div style="font-size:13px; color:${COLORS.textMuted}; margin-bottom:8px;">
                    Set the persona for each character — when a speaker is chosen in the Compare table,
                    the LLM will translate using that voice (tone, mannerisms).<br>
                    The first character is the <strong>default</strong> for items without a speaker assigned.
                </div>
                <div id="charsList"></div>
                <div class="modal-foot">
                    <button type="button" id="charAddBtn" class="ghost">+ Add character</button>
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
    _characters = next;
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
