// Resolve image src for a page — client blob URL (image upload) > server base64 (PDF/DOC render)
import { state } from "../state.js";

function _pageKey(page) {
    const docId = page._doc_id || state.lastResult?.doc_id || "";
    const pno = page._page_no_orig ?? page.page_no;
    return `${docId}/${pno}`;
}

export function getImageSrc(page) {
    if (!page) return null;
    const key = _pageKey(page);
    return state.clientImages.get(key) || page.image || null;
}

export function setClientImage(docId, pageNo, blobUrl) {
    state.clientImages.set(`${docId}/${pageNo}`, blobUrl);
}

export function clearClientImages() {
    for (const url of state.clientImages.values()) {
        URL.revokeObjectURL(url);
    }
    state.clientImages.clear();
}
