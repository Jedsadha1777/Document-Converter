// Pure helpers — HTML escape + LCS-based diff for Compare table
// เปรียบเทียบระดับ grapheme cluster (สระ/วรรณยุกต์ไทยอยู่กับพยัญชนะเป็น 1 หน่วย)

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// แตก string เป็น grapheme clusters — Thai "บ้าน" = ["บ้", "า", "น"] (สระ/วรรณยุกต์ติดพยัญชนะ)
// Intl.Segmenter = Unicode TR29 มาตรฐาน (Pretext เองก็ใช้ตัวนี้ภายใน → consistent กับการ wrap text)
// fallback: codepoint split สำหรับ browser เก่าที่ไม่มี Intl.Segmenter (Chrome <87 / Safari <14.1)
const _segmenter = (typeof Intl !== "undefined" && Intl.Segmenter)
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
function _toClusters(s) {
    if (_segmenter) return Array.from(_segmenter.segment(s), x => x.segment);
    return Array.from(s);  // codepoint-level fallback
}

// LCS-based diff → ops [['eq'|'del'|'ins', text], ...]
export function diffChars(a, b) {
    if (!a.length) return b.length ? [["ins", b]] : [];
    if (!b.length) return [["del", a]];
    // ตัดเป็น grapheme clusters ก่อน — กันสระ/วรรณยุกต์ไทยลอยหลุดจากพยัญชนะตอน render
    const aArr = _toClusters(a);
    const bArr = _toClusters(b);
    const m = aArr.length, n = bArr.length;
    const dp = Array.from({length: m + 1}, () => new Uint32Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (aArr[i-1] === bArr[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
            else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
        }
    }
    const ops = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (aArr[i-1] === bArr[j-1]) { ops.push(["eq", aArr[i-1]]); i--; j--; }
        else if (dp[i-1][j] >= dp[i][j-1]) { ops.push(["del", aArr[i-1]]); i--; }
        else { ops.push(["ins", bArr[j-1]]); j--; }
    }
    while (i > 0) { ops.push(["del", aArr[i-1]]); i--; }
    while (j > 0) { ops.push(["ins", bArr[j-1]]); j--; }
    ops.reverse();
    // merge adjacent same ops — concat cluster strings
    const merged = [];
    for (const [op, ch] of ops) {
        if (merged.length && merged[merged.length-1][0] === op) merged[merged.length-1][1] += ch;
        else merged.push([op, ch]);
    }
    return merged;
}

// side: 'orig' shows eq + del (red strike), 'corr' shows eq + ins (green)
export function renderDiffSide(ops, side) {
    return ops.map(([op, txt]) => {
        if (op === "eq") return escapeHtml(txt);
        if (op === "del" && side === "orig") return `<span class="diff-del">${escapeHtml(txt)}</span>`;
        if (op === "ins" && side === "corr") return `<span class="diff-ins">${escapeHtml(txt)}</span>`;
        return "";
    }).join("");
}
