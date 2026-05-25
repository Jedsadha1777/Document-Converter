"""Translation Memory (TM) retrieval — embed source side of jsonl TUs, Faiss search,
aggregate top hits across multiple OCR queries, format as glossary rules for the LLM."""
import hashlib
import json
import math
import re
from pathlib import Path

import faiss
import httpx
import numpy as np

# Apple Silicon: faiss multi-thread + torch MPS (manga-ocr) → segfault หลัง manga-ocr OCR + faiss search
# บังคับ single-thread → ตัด OpenMP race ขัด torch MPS thread; cost น้อย (faiss search 400k บน CPU 1 core
# ก็ยัง <1s — vectorized SIMD ยังทำงานได้)
faiss.omp_set_num_threads(1)

from config import (
    OLLAMA_MODEL_EMBED,
    OLLAMA_URL,
    TM_BONUS_ALPHA,
    TM_DIR,
    TM_EMBED_BATCH_SIZE,
    TM_EMBED_TIMEOUT,
    TM_FINAL_K,
    TM_TOP_K_PER_QUERY,
)

_INDEX_FILENAME = "_index.faiss"
_META_FILENAME = "_meta.jsonl"
_MANIFEST_FILENAME = "_manifest.json"
_VECTORS_FILENAME = "_vectors.npy"   # raw vectors → ใช้ incremental rebuild (เก็บ vectors เก่าไว้)


def _pair_folder(pair: str) -> Path:
    return Path(TM_DIR) / pair


def _is_tm_file(p: Path) -> bool:
    return p.is_file() and p.suffix.lower() in (".jsonl", ".json") and not p.name.startswith("_")


def _list_source_files(pair: str) -> list[Path]:
    """Find all .jsonl/.json TM source files under data_tm/{pair}/{domain}/*.
    Domain = immediate parent folder name (set up by user). Files directly in the pair
    folder (legacy layout) are still picked up — domain inferred from filename."""
    folder = _pair_folder(pair)
    if not folder.exists():
        return []
    return sorted([p for p in folder.rglob("*") if _is_tm_file(p)])


def _list_pairs() -> list[str]:
    root = Path(TM_DIR)
    if not root.exists():
        return []
    return sorted([p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")])


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _infer_domain(path: Path, pair_root: Path) -> str:
    """Domain = name of the first subfolder under the pair root (data_tm/{pair}/{domain}/...).
    File ที่วางใน pair folder โดยตรง (legacy) → 'general'.
    Domain ที่ใส่ในแต่ละ row ของ jsonl ('domain' field) override ค่านี้ได้"""
    try:
        rel = path.relative_to(pair_root)
    except ValueError:
        return "general"
    parts = rel.parts
    if len(parts) >= 2:
        return parts[0]
    return "general"


def _load_jsonl_rows(files: list[Path], pair_root: Path) -> list[dict]:
    """Read every .jsonl file → flat list of {tu_id, source_file, source, target, domain}.
    Skip rows missing `source` or with empty/whitespace source.
    domain = entry's "domain" field if present, else inferred from the file's parent folder."""
    out: list[dict] = []
    for fp in files:
        file_domain = _infer_domain(fp, pair_root)
        # source_file = relative path (POSIX separator) — รองรับชื่อไฟล์ซ้ำต่าง subfolder
        try:
            rel_name = fp.relative_to(pair_root).as_posix()
        except ValueError:
            rel_name = fp.name
        with fp.open("r", encoding="utf-8") as f:
            for ln_no, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    print(f"[tm] skip bad jsonl: {rel_name}:{ln_no}", flush=True)
                    continue
                src = (obj.get("source") or "").strip()
                if not src:
                    continue
                out.append({
                    "tu_id": obj.get("tu_id"),
                    "source_file": rel_name,
                    "source": src,
                    "target": (obj.get("target") or "").strip(),
                    "domain": (obj.get("domain") or "").strip() or file_domain,
                })
    return out


def _embed_batch(texts: list[str], model: str, timeout: float = TM_EMBED_TIMEOUT) -> np.ndarray:
    """POST to Ollama /api/embed → np.ndarray (N, dim). L2-normalize for cosine via inner product."""
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)
    resp = httpx.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": model, "input": texts},
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    embs = data.get("embeddings")
    if not isinstance(embs, list) or not embs:
        raise RuntimeError(f"ollama /api/embed returned no embeddings: {data}")
    arr = np.asarray(embs, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


def _embed_many(texts: list[str], model: str, batch_size: int = TM_EMBED_BATCH_SIZE) -> np.ndarray:
    """Chunked embedding so Ollama doesn't OOM on a single huge request."""
    chunks: list[np.ndarray] = []
    total = len(texts)
    for i in range(0, total, batch_size):
        chunk = texts[i:i + batch_size]
        arr = _embed_batch(chunk, model)
        chunks.append(arr)
        if total > batch_size:
            print(f"[tm] embed {min(i + batch_size, total)}/{total}", flush=True)
    if not chunks:
        return np.zeros((0, 0), dtype=np.float32)
    return np.vstack(chunks)


def _manifest_path(pair: str) -> Path:
    return _pair_folder(pair) / _MANIFEST_FILENAME


def _read_manifest(pair: str) -> dict | None:
    p = _manifest_path(pair)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _current_hashes(pair: str) -> dict[str, str]:
    """key = relative path under pair folder (POSIX) — รองรับชื่อไฟล์ซ้ำต่าง subfolder.
    ตรงกับ `source_file` ที่ _load_jsonl_rows เก็บไว้"""
    root = _pair_folder(pair)
    out: dict[str, str] = {}
    for p in _list_source_files(pair):
        try:
            key = p.relative_to(root).as_posix()
        except ValueError:
            key = p.name
        out[key] = _file_hash(p)
    return out


def needs_rebuild(pair: str, model: str = OLLAMA_MODEL_EMBED) -> tuple[bool, str]:
    """Compare manifest vs current file hashes + model. Returns (need_rebuild, reason)."""
    files = _list_source_files(pair)
    if not files:
        return False, "no source files"
    manifest = _read_manifest(pair)
    if not manifest:
        return True, "no manifest"
    if manifest.get("model") != model:
        return True, f"model changed ({manifest.get('model')} → {model})"
    if not (_pair_folder(pair) / _INDEX_FILENAME).exists():
        return True, "missing .faiss file"
    if not (_pair_folder(pair) / _META_FILENAME).exists():
        return True, "missing .meta file"
    cur_hashes = _current_hashes(pair)
    if manifest.get("file_hashes", {}) != cur_hashes:
        return True, "file hashes changed"
    return False, "up to date"


def _write_index_artifacts(folder: Path, pair: str, model: str,
                            rows: list[dict], vecs: np.ndarray) -> dict:
    """Write Faiss + meta + vectors + manifest. Shared by full / incremental build."""
    dim = int(vecs.shape[1])
    index = faiss.IndexFlatIP(dim)
    index.add(vecs)
    faiss.write_index(index, str(folder / _INDEX_FILENAME))
    np.save(folder / _VECTORS_FILENAME, vecs)
    with (folder / _META_FILENAME).open("w", encoding="utf-8") as f:
        for i, row in enumerate(rows):
            f.write(json.dumps({"row": i, **row}, ensure_ascii=False) + "\n")
    manifest = {
        "pair": pair,
        "model": model,
        "dim": dim,
        "n_rows": len(rows),
        "file_hashes": _current_hashes(pair),
    }
    _manifest_path(pair).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def build_index(pair: str, model: str = OLLAMA_MODEL_EMBED,
                 force_full: bool = False) -> dict:
    """Embed all rows → save Faiss IndexFlatIP + meta jsonl + manifest. Returns stats.

    INCREMENTAL mode (default) — ถ้า _vectors.npy + meta + manifest มีอยู่ + model เดียวกัน:
      สำหรับ file ที่ hash ไม่เปลี่ยน → keep vectors เก่า, ไม่ embed ใหม่
      สำหรับ file ที่เปลี่ยน/เพิ่ม → embed เฉพาะ rows ในนั้น
      สำหรับ file ที่หาย → drop rows ทิ้ง
    force_full=True → ignore incremental, rebuild ทั้งหมด."""
    folder = _pair_folder(pair)
    if not folder.exists():
        raise FileNotFoundError(f"TM folder not found: {folder}")
    files = _list_source_files(pair)
    if not files:
        raise FileNotFoundError(f"no .jsonl files in {folder}")

    # ── try incremental first ──
    if not force_full:
        try:
            incremental = _try_incremental_build(folder, files, pair, model)
            if incremental is not None:
                return incremental
        except Exception as exc:
            print(f"[tm] incremental build failed ({exc}) — falling back to full", flush=True)

    # ── full rebuild ──
    rows = _load_jsonl_rows(files, folder)
    if not rows:
        raise ValueError(f"no usable rows in {folder} (all sources empty?)")
    sources = [r["source"] for r in rows]
    print(f"[tm] FULL build pair={pair} model={model} rows={len(sources)}", flush=True)
    vecs = _embed_many(sources, model)
    manifest = _write_index_artifacts(folder, pair, model, rows, vecs)
    print(f"[tm] built - n_rows={len(rows)} dim={int(vecs.shape[1])}", flush=True)
    return manifest


def _try_incremental_build(folder: Path, files: list[Path], pair: str,
                            model: str) -> dict | None:
    """Try to keep existing vectors for unchanged files, embed only new/changed files.
    Returns manifest if successful, None if not possible (missing artifacts / model mismatch)."""
    meta_path = folder / _META_FILENAME
    manifest_path = folder / _MANIFEST_FILENAME
    vec_path = folder / _VECTORS_FILENAME
    if not (meta_path.exists() and manifest_path.exists() and vec_path.exists()):
        return None   # no prior build artifacts — must full build

    old_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if old_manifest.get("model") != model:
        return None   # model changed → vectors incompatible, must re-embed all

    old_meta = [json.loads(ln) for ln in meta_path.open(encoding="utf-8") if ln.strip()]
    old_vecs = np.load(vec_path)
    if len(old_meta) != old_vecs.shape[0]:
        return None   # corrupted — full rebuild

    old_hashes: dict[str, str] = old_manifest.get("file_hashes", {})

    def _rel_key(fp: Path) -> str:
        try:
            return fp.relative_to(folder).as_posix()
        except ValueError:
            return fp.name

    current_hashes = {_rel_key(fp): _file_hash(fp) for fp in files}

    unchanged = {n for n in current_hashes if old_hashes.get(n) == current_hashes[n]}
    changed_or_new = set(current_hashes) - unchanged
    deleted = set(old_hashes) - set(current_hashes)

    if not changed_or_new and not deleted:
        print(f"[tm] no file changes for pair={pair} — skip rebuild", flush=True)
        return old_manifest

    print(f"[tm] INCREMENTAL pair={pair}: unchanged={len(unchanged)} "
          f"changed/new={len(changed_or_new)} deleted={len(deleted)}", flush=True)

    # keep rows from unchanged files
    keep_indices = [i for i, m in enumerate(old_meta)
                    if m.get("source_file") in unchanged]
    kept_rows = [old_meta[i] for i in keep_indices]
    # strip "row" field (will be re-assigned in writer)
    kept_rows = [{k: v for k, v in r.items() if k != "row"} for r in kept_rows]
    kept_vecs = old_vecs[keep_indices] if keep_indices else np.zeros((0, old_vecs.shape[1]),
                                                                       dtype=old_vecs.dtype)

    # load + embed rows from changed/new files only
    changed_files = [fp for fp in files if _rel_key(fp) in changed_or_new]
    new_rows = _load_jsonl_rows(changed_files, folder) if changed_files else []
    new_sources = [r["source"] for r in new_rows]
    if new_sources:
        print(f"[tm] embedding {len(new_sources)} new/changed rows "
              f"(from {len(changed_files)} files)", flush=True)
        new_vecs = _embed_many(new_sources, model)
    else:
        new_vecs = np.zeros((0, old_vecs.shape[1]), dtype=old_vecs.dtype)

    all_rows = kept_rows + new_rows
    all_vecs = np.vstack([kept_vecs, new_vecs]) if new_sources else kept_vecs

    if not all_rows:
        raise ValueError(f"incremental result is empty — refuse to write")

    manifest = _write_index_artifacts(folder, pair, model, all_rows, all_vecs)
    print(f"[tm] incremental done - n_rows={len(all_rows)} kept={len(kept_rows)} "
          f"added={len(new_rows)}", flush=True)
    return manifest


def build_all_indexes(model: str = OLLAMA_MODEL_EMBED) -> list[dict]:
    """Rebuild every pair folder under TM_DIR. Stops on first failure and re-raises
    with the failing pair name embedded in the message."""
    pairs = _list_pairs()
    if not pairs:
        raise FileNotFoundError(f"no pair folders under {TM_DIR}")
    manifests: list[dict] = []
    for pair in pairs:
        try:
            manifests.append(build_index(pair, model))
            invalidate_cache(pair)
        except Exception as exc:
            raise RuntimeError(f"build failed at pair='{pair}': {exc}") from exc
    return manifests


_index_cache: dict[str, tuple[faiss.Index, list[dict], dict]] = {}
_source_tokens_cache: dict[str, list[set[str]]] = {}


def _get_source_tokens(pair: str, meta: list[dict]) -> list[set[str]]:
    """Token sets per row, computed once per session (~30ms for 18k rows)."""
    if pair in _source_tokens_cache:
        return _source_tokens_cache[pair]
    cache = [_tokens(m.get("source") or "") for m in meta]
    _source_tokens_cache[pair] = cache
    print(f"[tm] cached {len(cache)} source-token sets for pair={pair}", flush=True)
    return cache


def load_index(pair: str) -> tuple[faiss.Index, list[dict], dict]:
    """Load Faiss + meta into RAM (cached per pair). Caller should call needs_rebuild() first."""
    if pair in _index_cache:
        return _index_cache[pair]
    folder = _pair_folder(pair)
    idx_path = folder / _INDEX_FILENAME
    meta_path = folder / _META_FILENAME
    manifest_path = _manifest_path(pair)
    if not (idx_path.exists() and meta_path.exists() and manifest_path.exists()):
        raise FileNotFoundError(f"TM index not built yet for pair={pair} — call build_index() first")
    index = faiss.read_index(str(idx_path))
    meta: list[dict] = []
    with meta_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                meta.append(json.loads(line))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    _index_cache[pair] = (index, meta, manifest)
    return _index_cache[pair]


def invalidate_cache(pair: str | None = None) -> None:
    """Drop cached index — call after rebuild or when ENV changes."""
    if pair is None:
        _index_cache.clear()
        _source_tokens_cache.clear()
    else:
        _index_cache.pop(pair, None)
        _source_tokens_cache.pop(pair, None)


def _aggregate_hits(per_query: list[list[tuple[int, float]]],
                    bonus_alpha: float = TM_BONUS_ALPHA) -> list[tuple[int, float, int, float]]:
    """Each per_query[i] is [(row, score), ...] for query i.
    Returns list of (row, final_score, hits, max_score) sorted desc by final_score.
    final_score = max_score + alpha * log(1 + hits)  → bonus tails off as hits grow."""
    by_row: dict[int, list[float]] = {}
    for hits in per_query:
        seen_in_query: set[int] = set()
        for row, score in hits:
            if row in seen_in_query:
                continue
            seen_in_query.add(row)
            by_row.setdefault(row, []).append(float(score))
    out: list[tuple[int, float, int, float]] = []
    for row, scores in by_row.items():
        max_s = max(scores)
        hits = len(scores)
        final = max_s + bonus_alpha * math.log(1 + hits)
        out.append((row, final, hits, max_s))
    out.sort(key=lambda t: t[1], reverse=True)
    return out


_WHITESPACE_RE = re.compile(r"\s+")
_NON_WORD_RE = re.compile(r"[^\w\s]")


def _normalize_for_dedup(s: str) -> str:
    """Strip punctuation + whitespace + lowercase + 50-char prefix — catches near-duplicates
    that differ only in trailing punctuation / minor wording (e.g. the same catalog footer
    repeated across sections)."""
    s = (s or "").strip().lower()
    s = _NON_WORD_RE.sub("", s)
    s = _WHITESPACE_RE.sub(" ", s).strip()
    return s[:50]


_TOKEN_RE = re.compile(
    r"[A-Za-z]{2,}"           # Latin ≥2 (รองรับ abbrev เช่น JK, OL)
    r"|[一-鿿々〆]+"            # Kanji runs (รวม 々 iteration mark) — 1 char ขึ้นไป (kanji หายาก match แม่นยำ)
    r"|[゠-ヿ]{2,}"             # Katakana runs ≥2 (กัน single ア/イ ที่ common เกิน)
    r"|[぀-ゟ]{3,}"             # Hiragana runs ≥3 (กัน particles เช่น だ/は/に/が)
    r"|[ก-๛]{2,}"              # Thai ≥2 (เผื่อ tm pair ที่ source เป็นไทย)
)
# Stopwords — common function words that match everywhere and create false overlap.
# Kept small and conservative; don't include domain words like "use" or "set".
_STOPWORDS = frozenset({
    "the", "and", "for", "with", "from", "your", "yours", "are", "was", "were",
    "this", "that", "these", "those", "what", "which", "when", "where",
    "all", "any", "more", "than", "too", "but", "not", "only",
    "into", "out", "via", "etc", "such", "also", "have", "has", "had",
})


def _tokens(s: str) -> set[str]:
    """Lowercased ≥3-letter word tokens, with English stopwords removed."""
    return {t.lower() for t in _TOKEN_RE.findall(s or "") if t.lower() not in _STOPWORDS}


def _is_junk_source(s: str) -> bool:
    """Drop TM entries that are headings / product codes / cluster artifacts.
    Heading-with-colon ('Intended Use:', 'Material:') is the biggest offender because
    nomic-embed-text clusters them at near-identical cosine ~0.99, dominating top-K."""
    if not s:
        return True
    s = s.strip()
    if len(s) < 3:
        return True
    if s.endswith(":") or s.endswith("·"):
        return True
    alpha_count = sum(1 for c in s if c.isalpha())
    if alpha_count < 4:
        return True
    if ":" in s and " " not in s and len(s) < 30:
        # product-code shape: "Plug:DVOPM20026", "Code:ABC123"
        rhs = s.split(":", 1)[1]
        if rhs:
            cap_digit = sum(1 for c in rhs if c.isdigit() or (c.isalpha() and c.isupper()))
            if cap_digit >= len(rhs) * 0.5:
                return True
    return False


def suggest(texts: list[str], pair: str = "en-vn",
            top_k_per_query: int = TM_TOP_K_PER_QUERY,
            final_k: int = TM_FINAL_K,
            bonus_alpha: float = TM_BONUS_ALPHA,
            auto_build: bool = True,
            model: str = OLLAMA_MODEL_EMBED,
            domain_filter: list[str] | None = None) -> dict:
    """Embed each non-empty input text → faiss top-K per query → aggregate → top final_k rows.
    Returns {rules_text, hits, stats}. Auto-builds index if hashes changed (unless disabled)."""
    queries = [t for t in (texts or []) if t and t.strip()]
    if not queries:
        return {"rules_text": "", "hits": [], "stats": {"reason": "no input texts"}}

    if auto_build:
        need, reason = needs_rebuild(pair, model)
        if need:
            print(f"[tm] auto-rebuild pair={pair}: {reason}", flush=True)
            build_index(pair, model)
            invalidate_cache(pair)

    index, meta, manifest = load_index(pair)
    src_tokens_cache = _get_source_tokens(pair, meta)

    # domain filter — restrict pool ก่อน scoring (เร็วกว่า + ลด false-positive cosine)
    allowed_rows: set[int] | None = None
    if domain_filter:
        allowed_set = set(domain_filter)
        allowed_rows = {i for i, m in enumerate(meta) if (m.get("domain") or "general") in allowed_set}
        if not allowed_rows:
            return {"rules_text": "", "hits": [], "stats": {"reason": f"no rows match domain filter {domain_filter}",
                                                              "n_index_rows": len(meta)}}

    q_vecs = _embed_many(queries, model)
    if q_vecs.shape[1] != manifest.get("dim"):
        raise RuntimeError(
            f"query dim {q_vecs.shape[1]} != index dim {manifest.get('dim')} "
            f"(model mismatch — rebuild required)")
    k = max(1, min(top_k_per_query, index.ntotal))
    scores, ids = index.search(q_vecs, k)

    # Per-row aggregated cosine: max_cos + hits count across queries
    cos_per_row: dict[int, list[float]] = {}
    for qi in range(len(queries)):
        seen_in_q: set[int] = set()
        for j in range(k):
            row = int(ids[qi][j])
            if row < 0 or row in seen_in_q:
                continue
            if allowed_rows is not None and row not in allowed_rows:
                continue
            seen_in_q.add(row)
            cos_per_row.setdefault(row, []).append(float(scores[qi][j]))

    # Lexical pool — keep row only if its source tokens overlap with some query's tokens.
    # ตัด false-positive cosine จาก embedding clusters ที่ไม่แชร์คำกับ query เลย.
    q_tokens: list[set[str]] = [_tokens(q) for q in queries]
    all_query_tokens: set[str] = set()
    for qt in q_tokens:
        all_query_tokens |= qt
    # lex_per_row[row] = (best_ratio, best_absolute_count)
    lex_per_row: dict[int, tuple[float, int]] = {}
    for row, st in enumerate(src_tokens_cache):
        if not st:
            continue
        if allowed_rows is not None and row not in allowed_rows:
            continue
        # Fast reject: no source token appears anywhere in any query → skip
        if not (st & all_query_tokens):
            continue
        best_ratio = 0.0
        best_abs = 0
        for qt in q_tokens:
            if not qt:
                continue
            inter = st & qt
            if not inter:
                continue
            ratio = len(inter) / len(st)
            if ratio > best_ratio or (ratio == best_ratio and len(inter) > best_abs):
                best_ratio = ratio
                best_abs = len(inter)
        if best_abs > 0:
            lex_per_row[row] = (best_ratio, best_abs)

    # Only rows with lexical anchoring qualify (token overlap > 0).
    # Score balances exact-term matches AND longer-context entries so both surface:
    #   lex_ratio        → "Stainless Steel" gets 1.0 (all source tokens match)
    #   abs_overlap/5    → multi-token matches outrank single-token shared keyword
    #   cosine           → semantic similarity backup (noisier with nomic-embed-text)
    #   length bonus     → tie-break favors entries with more sentence context for LLM
    #   hits bonus       → terms appearing across many OCR rows = doc-level vocab
    re_ranked: list[tuple[int, float, int, float, float, int, int]] = []
    for row, (lex_ratio, abs_overlap) in lex_per_row.items():
        if row < 0 or row >= len(meta):
            continue
        src_str = meta[row].get("source") or ""
        src_len = len(src_str.strip())
        cos_list = cos_per_row.get(row, [])
        max_cos = max(cos_list) if cos_list else 0.0
        n_hits = len(cos_list)
        final = (
            0.7 * lex_ratio
            + 0.3 * min(abs_overlap, 5) / 5.0
            + 0.4 * max_cos
            + 0.15 * min(1.0, src_len / 50.0)
            + bonus_alpha * math.log(1 + n_hits)
        )
        re_ranked.append((row, final, n_hits, max_cos, lex_ratio, abs_overlap, src_len))
    re_ranked.sort(key=lambda t: t[1], reverse=True)

    seen_sources: set[str] = set()
    hits: list[dict] = []
    n_skipped_junk = 0
    for row, final, n_hits, max_s, lex_ratio, abs_overlap, src_len in re_ranked:
        m = meta[row]
        if not m.get("target"):
            continue
        if _is_junk_source(m["source"]):
            n_skipped_junk += 1
            continue
        norm = _normalize_for_dedup(m["source"])
        if norm in seen_sources:
            continue
        seen_sources.add(norm)
        hits.append({
            "row": row,
            "tu_id": m.get("tu_id"),
            "source_file": m.get("source_file"),
            "source": m["source"],
            "target": m["target"],
            "final_score": round(final, 4),
            "max_score": round(max_s, 4),
            "lex_score": round(lex_ratio, 3),
            "abs_overlap": abs_overlap,
            "src_len": src_len,
            "n_hits": n_hits,
        })
        if len(hits) >= final_k:
            break

    rules_text = _format_rules(hits)

    per_query_debug: list[dict] = []
    for qi, qtext in enumerate(queries):
        # top cosine hit for this query (raw, before lex anchoring)
        top_rid = int(ids[qi][0]) if k > 0 and ids[qi][0] >= 0 else -1
        top_sc = float(scores[qi][0]) if top_rid >= 0 else None
        per_query_debug.append({
            "q": qtext[:200],
            "top_score": round(top_sc, 4) if top_sc is not None else None,
            "top_row": top_rid if top_rid >= 0 else None,
            "top_source": meta[top_rid]["source"][:200] if 0 <= top_rid < len(meta) else None,
            "n_query_tokens": len(q_tokens[qi]),
        })

    return {
        "rules_text": rules_text,
        "hits": hits,
        "per_query_debug": per_query_debug,
        "stats": {
            "pair": pair,
            "model": model,
            "n_queries": len(queries),
            "n_index_rows": index.ntotal,
            "top_k_per_query": k,
            "final_k": final_k,
            "n_returned": len(hits),
            "bonus_alpha": bonus_alpha,
            "n_skipped_junk": n_skipped_junk,
        },
    }


def _format_rules(hits: list[dict]) -> str:
    """Glossary-style lines for the system prompt: source → target, prefixed with a brief intro."""
    if not hits:
        return ""
    lines = [
        "Use these reference translations from the project Translation Memory as guidance. "
        "Preserve terminology, capitalization, and phrasing where the source matches; adapt "
        "wording when context differs. Do not copy a target verbatim if the source is only "
        "loosely related.",
        "",
    ]
    for h in hits:
        src = _WHITESPACE_RE.sub(" ", h["source"]).strip()
        tgt = _WHITESPACE_RE.sub(" ", h["target"]).strip()
        lines.append(f'- "{src}" → "{tgt}"')
    return "\n".join(lines)
