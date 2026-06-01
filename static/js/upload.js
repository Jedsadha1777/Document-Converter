// Multi-file upload + merge
// - 1 ไฟล์: ใช้ data จาก /convert ตรงๆ
// - หลายไฟล์ (image เท่านั้น): POST ทีละไฟล์ → shift page_no + remap self_ref → merge

import { state } from "./state.js";
import { history } from "./history.js";
import { setStatus } from "./status.js";
import { buildCompareTable, resetCompareUI } from "./compare.js";
import { renderPreview, clearSelectionAndUI } from "./preview.js";
import { renderBeforePane } from "./visual/before-pane.js";
import { renderThumbSidebar } from "./visual/thumbnail.js";
import { setClientImage, clearClientImages } from "./visual/image-source.js";
import * as viewport from "./visual/viewport.js";
import { COLORS } from "./colors.js";

const { corrections, translations, speakerByRef, emotionByRef, emotion2ByRef, bboxOverrides, manualEdits, manualTranslations } = state;

function _newMarkupId(i) {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return "mk_" + crypto.randomUUID();
    return "mk_" + Date.now().toString(36) + "_" + i.toString(36);
}

function _autoCreateMarkup(lastResult) {
    state.markup = [];
    state.markupSelection.id = null;
    state.markupSelection.ids = new Set();
    if (!lastResult?.preview) return;
    const pages = lastResult.preview.pages || [];
    const items = lastResult.preview.items || [];
    const pageMap = new Map(pages.map(p => [p.page_no, p]));
    let idx = 0;
    for (const it of items) {
        if (!it.bbox || it.category !== "texts") continue;
        const page = pageMap.get(it.page_no);
        if (!page) continue;
        const imgW = page.img_width || page.width || 1;
        const imgH = page.img_height || page.height || 1;
        const pageW = page.width || imgW;
        const pageH = page.height || imgH;
        const sx = imgW / pageW;
        const sy = imgH / pageH;
        const b = it.bbox;
        const isBL = (b.coord_origin || "").toUpperCase() === "BOTTOMLEFT";
        const x = b.l * sx;
        const w = (b.r - b.l) * sx;
        const y = isBL ? (pageH - b.t) * sy : b.t * sy;
        const h = isBL ? (b.t - b.b) * sy : (b.b - b.t) * sy;
        state.markup.push({
            id: _newMarkupId(idx++),
            type: "shape-rect",
            x, y, w, h,
            fillColor: it.bg_color || COLORS.overlayBg,
            strokeColor: null,
            strokeWidth: 0,
            pageNo: it.page_no,
        });
    }
    if (state.markup.length) {
        state.markupDefaults.fillColor = state.markup[state.markup.length - 1].fillColor;
    }
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".avif"];
function _isImageFile(file) {
    const name = (file.name || "").toLowerCase();
    return IMAGE_EXTS.some(ext => name.endsWith(ext));
}

// POST 1 ไฟล์ไป /convert, คืน data หรือ null ถ้า error
async function _convertOneFile(file) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("type", "texts");
    fd.append("lang", document.getElementById("lang").value);
    fd.append("ocr_engine", document.getElementById("ocr_engine").value);
    fd.append("fast", document.getElementById("fast").checked ? "1" : "0");
    fd.append("pages", document.getElementById("pages").value.trim());
    // image upload: client มี blob อยู่แล้ว → บอก server ไม่ต้องส่ง base64 กลับ
    if (_isImageFile(file)) fd.append("skip_image_data", "1");

    const res = await fetch("/convert", { method: "POST", body: fd });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
        const body = (await res.text()).slice(0, 400);
        setStatus(`HTTP ${res.status} (non-JSON): ${body}`, "error");
        return null;
    }
    const data = await res.json();
    if (!res.ok) {
        setStatus(data.error || `Error: ${file.name}`, "error");
        return null;
    }
    return data;
}

// merge ผลของไฟล์ที่ N เข้า combined — shift page_no + remap self_ref + ติดชื่อไฟล์
function _mergeFileResult(combined, data, pageOffset, textOffset, filename) {
    const refMap = new Map();
    (data.texts || []).forEach((t, idx) => {
        const newRef = `#/texts/${textOffset + idx}`;
        refMap.set(t.self_ref, newRef);
        t.self_ref = newRef;
        if (Array.isArray(t.prov)) {
            t.prov.forEach(p => { if (typeof p.page_no === "number") p.page_no += pageOffset; });
        }
    });
    (data.preview?.items || []).forEach(it => {
        const nr = refMap.get(it.self_ref);
        if (nr) it.self_ref = nr;
        if (typeof it.page_no === "number") it.page_no += pageOffset;
    });
    (data.preview?.pages || []).forEach(p => {
        if (typeof p.page_no === "number") {
            p._page_no_orig = p.page_no;            // ต้องใช้ใน tile URL — backend store ที่ original number
            p.page_no += pageOffset;                 // shifted สำหรับ UI/pageSelect (unique ทั้ง batch)
        }
        if (filename) p._filename = filename;
        if (data.doc_id) p._doc_id = data.doc_id;
    });
    combined.preview.pages.push(...(data.preview?.pages || []));
    combined.preview.items.push(...(data.preview?.items || []));
    combined.texts.push(...(data.texts || []));
}

function _populatePages(pages) {
    const pageSelect = document.getElementById("pageSelect");
    pageSelect.innerHTML = "";
    pages.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.page_no;
        // multi-image: ใช้ชื่อไฟล์, อื่นๆ: "Page N"
        opt.textContent = p._filename || ("Page " + p.page_no);
        pageSelect.appendChild(opt);
    });
    // upload ใหม่ → เริ่มหน้าแรก + reset zoom/pan + clear viewport targets
    if (pages.length) pageSelect.value = String(pages[0].page_no);
    viewport.clearTargets();
    viewport.reset();
}

// thumbnail click handler — switch page + re-render 3 areas
function _onClickPage(pageNo) {
    const pageSelect = document.getElementById("pageSelect");
    if (!pageSelect) return;
    pageSelect.value = String(pageNo);
    viewport.clearTargets();
    viewport.reset();
    renderBeforePane();
    pageSelect.dispatchEvent(new Event("change"));   // triggers renderPreview via filter listener
    // active state update
    import("./visual/thumbnail.js").then(m => m.setActiveThumb(pageNo));
}

// ล้าง state document ทั้งหมด — เรียกตอนเริ่ม upload ใหม่
function _resetDocumentState() {
    state.lastResult = null;
    Object.keys(corrections).forEach(k => delete corrections[k]);
    Object.keys(translations).forEach(k => delete translations[k]);
    Object.keys(speakerByRef).forEach(k => delete speakerByRef[k]);
    Object.keys(emotionByRef).forEach(k => delete emotionByRef[k]);
    Object.keys(emotion2ByRef).forEach(k => delete emotion2ByRef[k]);
    Object.keys(bboxOverrides).forEach(k => delete bboxOverrides[k]);
    manualEdits.clear();
    manualTranslations.clear();
    clearClientImages();
    clearSelectionAndUI();
    history.clear();
}

// init: รับ callback ที่ index.html ต้อง trigger หลัง upload สำเร็จ (sync checkboxes ตาม kind)
export function initUpload({ onAfterConvert } = {}) {
    const form = document.getElementById("convertForm");
    const fileInput = document.getElementById("file");
    const submitBtn = document.getElementById("submitBtn");
    const output = document.getElementById("output");
    const previewArea = document.getElementById("previewArea");
    const pageSelect = document.getElementById("pageSelect");

    // แสดงจำนวนไฟล์ + เตือนถ้า multi กับ non-image
    fileInput.addEventListener("change", () => {
        const files = [...fileInput.files];
        const fc = document.getElementById("fileCount");
        if (!fc) return;
        if (files.length <= 1) { fc.textContent = ""; fc.style.color = ""; return; }
        const nonImg = files.find(f => !_isImageFile(f));
        if (nonImg) {
            fc.textContent = `⚠ ${files.length} files — multi-file รับเฉพาะ image (${nonImg.name} ไม่ใช่)`;
            fc.style.color = COLORS.error;
        } else {
            fc.textContent = `📦 ${files.length} images (batch OCR)`;
            fc.style.color = COLORS.success;
        }
    });

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const files = [...fileInput.files];
        if (!files.length) { setStatus("Please choose a file", "error"); return; }
        if (files.length > 1) {
            const nonImg = files.find(f => !_isImageFile(f));
            if (nonImg) {
                setStatus(`Multi-file รับเฉพาะ image — '${nonImg.name}' ไม่ใช่ image. PDF/Excel/DOC ให้ยัดทีละไฟล์`, "error");
                return;
            }
        }

        submitBtn.disabled = true;
        submitBtn.textContent = "Processing...";
        setStatus(files.length > 1 ? `Converting ${files.length} files...` : "Converting document...", "info");
        output.value = "";
        _resetDocumentState();
        pageSelect.innerHTML = "";
        previewArea.innerHTML = '<div class="empty">Processing...</div>';
        resetCompareUI();

        try {
            // กรณี 1 ไฟล์ — ใช้ data จาก backend ตรงๆ (รักษา json_text เดิม)
            if (files.length === 1) {
                const file = files[0];
                const data = await _convertOneFile(file);
                if (!data) { previewArea.innerHTML = '<div class="empty">An error occurred</div>'; return; }
                (data.preview?.pages || []).forEach(p => {
                    if (typeof p.page_no === "number" && p._page_no_orig === undefined) {
                        p._page_no_orig = p.page_no;
                    }
                    if (data.doc_id) p._doc_id = data.doc_id;
                });
                // image upload: client มีไฟล์อยู่แล้ว — สร้าง blob URL ใช้ตรงๆ ไม่ต้องโหลด base64 จาก server
                if (_isImageFile(file) && data.doc_id) {
                    const blobUrl = URL.createObjectURL(file);
                    (data.preview?.pages || []).forEach(p => {
                        const pno = p._page_no_orig ?? p.page_no;
                        setClientImage(data.doc_id, pno, blobUrl);
                    });
                }
                state.lastResult = data;
                _autoCreateMarkup(data);
                output.value = data.json_text;
                _populatePages(data.preview.pages);
                onAfterConvert?.();
                const notes = [];
                if (data.engine_fallback) notes.push(`fallback: ${data.engine_fallback}`);
                if (data.pages_warning) notes.push(data.pages_warning);
                setStatus(notes.length ? `Converted ✓ (${notes.join("; ")})` : "Converted ✓",
                          notes.length ? "info" : "success");
                buildCompareTable(true);
                renderThumbSidebar(_onClickPage);
                renderBeforePane();
                if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
                return;
            }

            // หลายไฟล์ — POST ทีละไฟล์, shift+remap, merge
            const combined = { preview: { pages: [], items: [] }, texts: [], json_text: "" };
            const errors = [];
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                setStatus(`Processing file ${i+1}/${files.length}: ${file.name}`, "info");
                const pageOffset = combined.preview.pages.length;
                const textOffset = combined.texts.length;
                const data = await _convertOneFile(file);
                if (!data) { errors.push(file.name); continue; }
                _mergeFileResult(combined, data, pageOffset, textOffset, file.name);
                // multi-image batch รับเฉพาะ image — แต่ละไฟล์ใช้ blob URL ของตัวเอง
                if (_isImageFile(file) && data.doc_id) {
                    const blobUrl = URL.createObjectURL(file);
                    (data.preview?.pages || []).forEach(p => {
                        const pno = p._page_no_orig ?? p.page_no;
                        setClientImage(data.doc_id, pno, blobUrl);
                    });
                }
            }
            if (!combined.preview.pages.length) {
                previewArea.innerHTML = '<div class="empty">All files failed</div>';
                return;
            }
            // json_text รวม — minimal (เฉพาะ texts) + file list
            combined.json_text = JSON.stringify({
                _files: files.map(f => f.name),
                texts: combined.texts,
            }, null, 2);
            state.lastResult = combined;
            _autoCreateMarkup(combined);
            output.value = combined.json_text;
            _populatePages(combined.preview.pages);
            onAfterConvert?.();
            const okN = files.length - errors.length;
            setStatus(
                errors.length
                    ? `Converted ${okN}/${files.length} ✓ — failed: ${errors.join(", ")}`
                    : `Converted ${okN} files ✓`,
                errors.length ? "info" : "success"
            );
            buildCompareTable(true);
            renderThumbSidebar(_onClickPage);
            renderBeforePane();
            if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
        } catch (err) {
            setStatus("An error occurred: " + err.message, "error");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Convert to JSON";
        }
    });
}
