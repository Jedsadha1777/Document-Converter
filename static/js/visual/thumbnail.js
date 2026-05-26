// Thumbnail sidebar — lazy <img> per page; src = client blob URL หรือ base64 inline.
// IntersectionObserver กัน decode พร้อมกัน 2000 หน้า.

import { state } from "../state.js";
import { getImageSrc } from "./image-source.js";

const ROW_GAP_PX = 6;
let _io = null;
let _onClickPage = null;

function _ensureObserver() {
    if (_io) return _io;
    _io = new IntersectionObserver((entries) => {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            const img = en.target;
            const src = img.dataset.src;
            if (src && !img.src) img.src = src;
            _io.unobserve(img);
        }
    }, { root: document.getElementById("thumbSidebar"), rootMargin: "200px" });
    return _io;
}

/** call ตอน upload เสร็จ หรือสลับ tab → visual */
export function renderThumbSidebar(onClickPage) {
    if (typeof onClickPage === "function") _onClickPage = onClickPage;
    const sidebar = document.getElementById("thumbSidebar");
    if (!sidebar) return;

    const pages = state.lastResult?.preview?.pages || [];
    sidebar.innerHTML = "";

    if (!pages.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.style.cssText = "padding:20px 8px; font-size:11px;";
        empty.textContent = "No pages yet";
        sidebar.appendChild(empty);
        return;
    }

    const io = _ensureObserver();
    const pageSelect = document.getElementById("pageSelect");
    const activePage = parseInt(pageSelect?.value || pages[0].page_no, 10);

    for (const p of pages) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "thumb-row" + (p.page_no === activePage ? " active" : "");
        row.dataset.pageNo = String(p.page_no);
        row.style.cssText = `
            display:block; width:100%; margin:0 0 ${ROW_GAP_PX}px 0;
            padding:4px; background:#fff; border:2px solid transparent;
            border-radius:4px; cursor:pointer; text-align:center; font-size:10px;
            color:#6b7280;`;
        if (p.page_no === activePage) row.style.borderColor = "#2563eb";

        const img = document.createElement("img");
        img.alt = `page ${p.page_no}`;
        img.style.cssText = "display:block; width:100%; height:auto; margin-bottom:2px; background:#f3f4f6;";
        // reserve aspect ratio ก่อนโหลด (กัน layout jump)
        const iw = p.img_width || p.width;
        const ih = p.img_height || p.height;
        if (iw && ih) {
            img.width = iw;
            img.height = ih;
            img.style.aspectRatio = `${iw}/${ih}`;
        }
        const src = getImageSrc(p);
        if (src) img.dataset.src = src;
        io.observe(img);
        row.appendChild(img);

        const lbl = document.createElement("div");
        lbl.textContent = p._filename || `p.${p.page_no}`;
        lbl.style.cssText = "overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
        row.appendChild(lbl);

        row.addEventListener("click", () => {
            if (_onClickPage) _onClickPage(p.page_no);
        });
        sidebar.appendChild(row);
    }
}

export function setActiveThumb(pageNo) {
    const sidebar = document.getElementById("thumbSidebar");
    if (!sidebar) return;
    sidebar.querySelectorAll(".thumb-row").forEach(r => {
        const active = parseInt(r.dataset.pageNo, 10) === pageNo;
        r.classList.toggle("active", active);
        r.style.borderColor = active ? "#2563eb" : "transparent";
    });
}
