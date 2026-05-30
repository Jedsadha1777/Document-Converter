// Emotion sentinel + per-target dropdown list + helpers
// pattern เดียวกับ characters.js (SPEAKER_AUTO) — emotion=__auto__ → LLM picks per row
// storage: state.emotionByRef[ref] = "ดีใจ"/"vui vẻ"/... หรือ EMOTION_AUTO

import { escapeHtml } from "./diff.js";

export const EMOTION_AUTO = "__auto__";

// label ของ emotion = string ตาม target language เลย (ใช้ใน prompt prefix ตรง ๆ)
// _default = English fallback สำหรับ target อื่นในอนาคต
// list ของ emotion ที่ใช้กับ dialogue/narration ทั่วไป ครอบคลุม 6 หมวด:
//   positive — neutral/calm — sad/regret — anger/disgust — fear/surprise — uncertainty/social
const EMOTIONS_BY_TARGET = {
    "th": [
        // positive
        "ดีใจ","ตื่นเต้น","ขำ","ภูมิใจ","รัก","หวัง","มั่นใจ","ปลื้ม",
        // neutral / calm
        "เฉยๆ","สบาย","จริงจัง",
        // sad / regret
        "เศร้า","ผิดหวัง","เหนื่อย","เบื่อ","สงสาร",
        // anger / disgust
        "โกรธ","หงุดหงิด","รังเกียจ","เกลียด","ดูถูก",
        // fear / surprise
        "กลัว","ตกใจ","กังวล","ผวา",
        // uncertainty / social
        "อิจฉา","ประชด","ลังเล","สงสัย","งง","เขิน","อาย"
    ],
    "vi": [
        "vui vẻ","hào hứng","buồn cười","tự hào","yêu","hy vọng","tự tin","sung sướng",
        "bình thường","thoải mái","nghiêm túc",
        "buồn","thất vọng","mệt","chán","thương hại",
        "giận","khó chịu","ghê tởm","ghét","khinh thường",
        "sợ","ngạc nhiên","lo lắng","hoảng",
        "ghen tị","mỉa mai","do dự","nghi ngờ","bối rối","ngại","xấu hổ"
    ],
    "_default": [
        "happy","excited","amused","proud","love","hopeful","confident","delighted",
        "neutral","relaxed","serious",
        "sad","disappointed","tired","bored","sympathetic",
        "angry","frustrated","disgusted","hate","contempt",
        "afraid","surprised","worried","panicked",
        "jealous","sarcastic","hesitant","suspicious","confused","shy","embarrassed"
    ],
};

export function getEmotionList(target) {
    return EMOTIONS_BY_TARGET[target] || EMOTIONS_BY_TARGET._default;
}

// builder: คืน function ที่ render <option> สำหรับ <select> รับ selected value + target
// allowEmpty=true → secondary slot, มี "(none)" option สำหรับเคสไม่ใส่ emotion ที่ 2
export function renderEmotionOptions(target, allowEmpty = false) {
    const list = getEmotionList(target);
    return (selected) => {
        const autoSel = selected === EMOTION_AUTO || (!selected && !allowEmpty) ? " selected" : "";
        const autoOpt = `<option value="${EMOTION_AUTO}"${autoSel}>🤖 Auto</option>`;
        const emptySel = !selected && allowEmpty ? " selected" : "";
        const emptyOpt = allowEmpty ? `<option value=""${emptySel}>—</option>` : "";
        const opts = list.map(e => {
            const sel = e === selected ? " selected" : "";
            return `<option value="${escapeHtml(e)}"${sel}>${escapeHtml(e)}</option>`;
        }).join("");
        // ถ้า selected เป็นค่าที่ไม่อยู่ใน list ปัจจุบัน (เปลี่ยน target) → แสดง (unmapped)
        let extraOpt = "";
        if (selected && selected !== EMOTION_AUTO && !list.includes(selected)) {
            extraOpt = `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (unmapped)</option>`;
        }
        return autoOpt + emptyOpt + extraOpt + opts;
    };
}

// combine 2 emotion slots → single string ที่จะส่งไปกับ user message
//   (auto, auto) → __auto__
//   (X, auto/empty) → X
//   (auto/empty, X) → X
//   (X, Y) → "X+Y"
export function combineEmotion(e1, e2) {
    const isEmpty = v => !v || v === EMOTION_AUTO;
    const a1 = isEmpty(e1), a2 = isEmpty(e2);
    if (a1 && a2) return EMOTION_AUTO;
    if (a1) return e2;
    if (a2) return e1;
    return `${e1}+${e2}`;
}
