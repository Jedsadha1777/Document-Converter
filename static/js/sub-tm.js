// Sub-TM — work-specific glossary, grouped by category. Active category appended to custom_rules at send time.

import { COLORS } from "./colors.js";
import { escapeHtml } from "./diff.js";

const STORAGE_KEY = "doclingSubTM";

function _defaultState() {
    return { categories: [{ name: "Default", entries: [] }], activeIdx: 0 };
}

function _loadFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return _defaultState();
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            // legacy schema: bare entry array → wrap into single "Default" category
            const entries = data
                .filter(e => e && typeof e === "object")
                .map(e => ({ source: String(e.source || ""), target: String(e.target || "") }));
            return { categories: [{ name: "Default", entries }], activeIdx: 0 };
        }
        if (data && Array.isArray(data.categories) && data.categories.length) {
            const cats = data.categories.map(c => ({
                name: String(c.name || "Untitled"),
                entries: Array.isArray(c.entries)
                    ? c.entries.map(e => ({
                        source: String(e.source || ""),
                        target: String(e.target || ""),
                    }))
                    : [],
            }));
            const idx = Math.min(Math.max(0, parseInt(data.activeIdx) || 0), cats.length - 1);
            return { categories: cats, activeIdx: idx };
        }
    } catch (_) {}
    return _defaultState();
}

let _state = _loadFromStorage();

function _saveToStorage() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_state)); } catch (_) {}
}

export function getSubTm() {
    return _state.categories[_state.activeIdx]?.entries?.slice() || [];
}

export function buildSubTmRules() {
    const entries = getSubTm().filter(e => e.source.trim() && e.target.trim());
    if (!entries.length) return "";
    const lines = ["Glossary:"];
    entries.forEach(e => lines.push(`  ${e.source.trim()} → ${e.target.trim()}`));
    return lines.join("\n");
}

function _updateButtonLabel() {
    const btn = document.getElementById("subTmBtn");
    if (!btn) return;
    const cat = _state.categories[_state.activeIdx];
    const count = cat ? cat.entries.filter(e => e.source.trim() && e.target.trim()).length : 0;
    const name = cat ? cat.name : "—";
    btn.textContent = `📚 Sub-TM: ${name} (${count})`;
}

let _modal = null;
let _catModal = null;
let _draft = null;
let _draftActiveIdx = 0;

function _entryRowEl(entry) {
    const e = entry || { source: "", target: "" };
    const row = document.createElement("div");
    row.className = "subtm-row";
    row.style.cssText = "display:flex; gap:6px; align-items:center; margin-bottom:4px;";
    row.innerHTML = `
        <input type="text" class="subtm-source" placeholder="Source (e.g., 田中)"
               value="${escapeHtml(e.source || "")}"
               style="flex:1; padding:5px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px;">
        <span style="color:#9ca3af; font-weight:600;">→</span>
        <input type="text" class="subtm-target" placeholder="Target (e.g., ทานากะ)"
               value="${escapeHtml(e.target || "")}"
               style="flex:1; padding:5px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px;">
        <button type="button" class="del-subtm" title="Delete entry"
                style="border:none; background:transparent; cursor:pointer; color:#dc2626; font-size:16px; padding:2px 6px;">✕</button>
    `;
    row.querySelector(".del-subtm").addEventListener("click", () => row.remove());
    return row;
}

function _renderEntries() {
    const list = document.getElementById("subTmEntriesList");
    if (!list) return;
    list.innerHTML = "";
    const cat = _draft.categories[_draftActiveIdx];
    const entries = (cat && cat.entries) || [];
    if (entries.length) {
        entries.forEach(e => list.appendChild(_entryRowEl(e)));
    } else {
        list.appendChild(_entryRowEl());
    }
}

function _syncEntriesFromForm() {
    if (!_modal) return;
    const cat = _draft.categories[_draftActiveIdx];
    if (!cat) return;
    const rows = _modal.querySelectorAll(".subtm-row");
    const entries = [];
    rows.forEach(r => {
        const s = r.querySelector(".subtm-source").value.trim();
        const t = r.querySelector(".subtm-target").value.trim();
        if (s || t) entries.push({ source: s, target: t });
    });
    cat.entries = entries;
}

function _renderCategoryDropdown() {
    const sel = document.getElementById("subTmCategorySelect");
    if (!sel) return;
    sel.innerHTML = _draft.categories.map((c, i) => {
        const count = c.entries.length;
        const label = `${c.name} (${count})`;
        return `<option value="${i}"${i === _draftActiveIdx ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
}

function _onCategoryChange() {
    _syncEntriesFromForm();
    const sel = document.getElementById("subTmCategorySelect");
    _draftActiveIdx = parseInt(sel.value, 10) || 0;
    _renderEntries();
    _renderCategoryDropdown();   // refresh count badges
}

function _openModal() {
    _draft = JSON.parse(JSON.stringify(_state));
    _draftActiveIdx = _state.activeIdx;

    if (!_modal) {
        _modal = document.createElement("div");
        _modal.className = "modal-backdrop";
        _modal.innerHTML = `
            <div class="modal-card" role="dialog" style="max-width:680px;">
                <h2><span class="material-symbols-outlined">menu_book</span>Sub-TM (work-specific glossary)</h2>
                <div style="font-size:13px; color:${COLORS.textMuted}; margin-bottom:10px; line-height:1.5;">
                    Character names / places / work-specific terms — automatically appended to <strong>Additional translation rules</strong> for the active category.<br>
                    <span style="color:#6b7280; font-size:12px;">All entries loaded (not filtered by final_k / min_score). Saved separately from the main TM.</span>
                </div>
                <div style="display:flex; gap:6px; align-items:center; margin-bottom:10px;">
                    <strong style="font-size:12px;">Category:</strong>
                    <select id="subTmCategorySelect" style="flex:1; padding:5px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px;"></select>
                    <button type="button" id="subTmManageCatBtn" class="ghost" style="font-size:12px;" title="Add, rename, or delete categories">⚙️ Manage</button>
                </div>
                <div id="subTmEntriesList" style="max-height:50vh; overflow-y:auto; padding:4px;"></div>
                <div class="modal-foot">
                    <button type="button" id="subTmAddBtn" class="ghost">+ Add entry</button>
                    <div style="display:flex; gap:6px;">
                        <button type="button" id="subTmCancelBtn" class="ghost">Cancel</button>
                        <button type="button" id="subTmSaveBtn">Save</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(_modal);
        _modal.addEventListener("click", (e) => { if (e.target === _modal) _closeModal(); });
        document.getElementById("subTmAddBtn").addEventListener("click", () =>
            document.getElementById("subTmEntriesList").appendChild(_entryRowEl())
        );
        document.getElementById("subTmCancelBtn").addEventListener("click", _closeModal);
        document.getElementById("subTmSaveBtn").addEventListener("click", _saveFromModal);
        document.getElementById("subTmCategorySelect").addEventListener("change", _onCategoryChange);
        document.getElementById("subTmManageCatBtn").addEventListener("click", _openCategoryModal);
    }
    _renderCategoryDropdown();
    _renderEntries();
    _modal.classList.add("show");
}

function _closeModal() {
    if (_modal) _modal.classList.remove("show");
    _draft = null;
}

function _saveFromModal() {
    _syncEntriesFromForm();
    _state = _draft;
    _state.activeIdx = _draftActiveIdx;
    _saveToStorage();
    _updateButtonLabel();
    _closeModal();
}

function _renderCategoryList() {
    const list = document.getElementById("subTmCatList");
    if (!list) return;
    list.innerHTML = "";
    _draft.categories.forEach((cat, idx) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex; gap:6px; align-items:center; margin-bottom:6px; padding:6px 8px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px;";
        const warn = cat.entries.length > 0
            ? ` <span style="color:#b45309; font-size:11px;" title="This category contains entries — deleting will remove all of them">⚠️</span>`
            : "";
        row.innerHTML = `
            <input type="text" value="${escapeHtml(cat.name)}" class="cat-name-input"
                   placeholder="Category name"
                   style="flex:1; padding:5px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px;">
            <span style="font-size:11px; color:#6b7280; min-width:90px; text-align:right;">
                ${cat.entries.length} entr${cat.entries.length === 1 ? "y" : "ies"}${warn}
            </span>
            <button type="button" class="cat-delete-btn" title="Delete category"
                    style="border:none; background:transparent; cursor:pointer; color:#dc2626; font-size:16px; padding:2px 6px;">🗑️</button>
        `;
        row.querySelector(".cat-name-input").addEventListener("input", (e) => {
            _draft.categories[idx].name = e.target.value;
        });
        row.querySelector(".cat-delete-btn").addEventListener("click", () => _deleteCategory(idx));
        list.appendChild(row);
    });
}

function _addCategory() {
    let n = _draft.categories.length + 1;
    let name;
    do { name = `Category ${n++}`; } while (_draft.categories.some(c => c.name === name));
    _draft.categories.push({ name, entries: [] });
    _renderCategoryList();
}

function _deleteCategory(idx) {
    const cat = _draft.categories[idx];
    if (!cat) return;
    if (_draft.categories.length === 1) {
        alert("Cannot delete the last category. At least one category is required.");
        return;
    }
    if (cat.entries.length > 0) {
        const ok = confirm(
            `Category "${cat.name}" contains ${cat.entries.length} entr${cat.entries.length === 1 ? "y" : "ies"}.\n\n` +
            `Deleting will remove ALL of them. This cannot be undone (until you click Cancel in the parent dialog).\n\n` +
            `Continue?`
        );
        if (!ok) return;
    }
    _draft.categories.splice(idx, 1);
    if (_draftActiveIdx >= _draft.categories.length) {
        _draftActiveIdx = _draft.categories.length - 1;
    } else if (_draftActiveIdx > idx) {
        _draftActiveIdx -= 1;
    }
    _renderCategoryList();
}

function _openCategoryModal() {
    _syncEntriesFromForm();
    if (!_catModal) {
        _catModal = document.createElement("div");
        _catModal.className = "modal-backdrop";
        _catModal.innerHTML = `
            <div class="modal-card" role="dialog" style="max-width:560px;">
                <h2><span class="material-symbols-outlined">folder</span>Manage Categories</h2>
                <div style="font-size:13px; color:${COLORS.textMuted}; margin-bottom:10px; line-height:1.5;">
                    Add, rename, or delete categories. Categories with entries show ⚠️ — deletion confirms before removing them.<br>
                    <span style="color:#6b7280; font-size:12px;">Changes here apply only after you click <strong>Save</strong> in the parent dialog.</span>
                </div>
                <div id="subTmCatList" style="max-height:50vh; overflow-y:auto; padding:4px;"></div>
                <div class="modal-foot">
                    <button type="button" id="subTmCatAddBtn" class="ghost">+ Add category</button>
                    <div style="display:flex; gap:6px;">
                        <button type="button" id="subTmCatDoneBtn">Done</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(_catModal);
        _catModal.addEventListener("click", (e) => { if (e.target === _catModal) _closeCategoryModal(); });
        document.getElementById("subTmCatAddBtn").addEventListener("click", _addCategory);
        document.getElementById("subTmCatDoneBtn").addEventListener("click", _closeCategoryModal);
    }
    _renderCategoryList();
    _catModal.classList.add("show");
}

function _closeCategoryModal() {
    _catModal?.classList.remove("show");
    _renderCategoryDropdown();
    _renderEntries();
}

export function initSubTm() {
    document.getElementById("subTmBtn")?.addEventListener("click", _openModal);
    _updateButtonLabel();
}
