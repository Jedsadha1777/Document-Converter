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


def _pair_folder(pair: str) -> Path:
    return Path(TM_DIR) / pair


def _is_tm_file(p: Path) -> bool:
    return p.is_file() and p.suffix.lower() in (".jsonl", ".json") and not p.name.startswith("_")


def _list_source_files(pair: str) -> list[Path]:
    folder = _pair_folder(pair)
    if not folder.exists():
        return []
    return sorted([p for p in folder.iterdir() if _is_tm_file(p)])


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_jsonl_rows(files: list[Path]) -> list[dict]:
    """Read every .jsonl file → flat list of {tu_id, source_file, source, target}.
    Skip rows missing `source` or with empty/whitespace source."""
    out: list[dict] = []
    for fp in files:
        with fp.open("r", encoding="utf-8") as f:
            for ln_no, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    print(f"[tm] skip bad jsonl: {fp.name}:{ln_no}", flush=True)
                    continue
                src = (obj.get("source") or "").strip()
                if not src:
                    continue
                out.append({
                    "tu_id": obj.get("tu_id"),
                    "source_file": fp.name,
                    "source": src,
                    "target": (obj.get("target") or "").strip(),
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
    return {p.name: _file_hash(p) for p in _list_source_files(pair)}


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


def build_index(pair: str, model: str = OLLAMA_MODEL_EMBED) -> dict:
    """Embed all rows → save Faiss IndexFlatIP + meta jsonl + manifest. Returns stats."""
    folder = _pair_folder(pair)
    if not folder.exists():
        raise FileNotFoundError(f"TM folder not found: {folder}")
    files = _list_source_files(pair)
    if not files:
        raise FileNotFoundError(f"no .jsonl files in {folder}")

    rows = _load_jsonl_rows(files)
    if not rows:
        raise ValueError(f"no usable rows in {folder} (all sources empty?)")

    sources = [r["source"] for r in rows]
    print(f"[tm] building index pair={pair} model={model} rows={len(sources)}", flush=True)
    vecs = _embed_many(sources, model)
    dim = int(vecs.shape[1])

    index = faiss.IndexFlatIP(dim)
    index.add(vecs)
    faiss.write_index(index, str(folder / _INDEX_FILENAME))

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
    print(f"[tm] built - n_rows={len(rows)} dim={dim}", flush=True)
    return manifest


_index_cache: dict[str, tuple[faiss.Index, list[dict], dict]] = {}


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
    else:
        _index_cache.pop(pair, None)


def status(pair: str, model: str = OLLAMA_MODEL_EMBED) -> dict:
    files = _list_source_files(pair)
    manifest = _read_manifest(pair)
    need, reason = needs_rebuild(pair, model)
    return {
        "pair": pair,
        "folder": str(_pair_folder(pair)),
        "n_files": len(files),
        "files": [p.name for p in files],
        "indexed": manifest is not None and not need,
        "needs_rebuild": need,
        "rebuild_reason": reason,
        "manifest": manifest,
        "current_model": model,
    }


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


def _normalize_for_dedup(s: str) -> str:
    return _WHITESPACE_RE.sub(" ", (s or "").strip().lower())


def suggest(texts: list[str], pair: str = "en-vn",
            top_k_per_query: int = TM_TOP_K_PER_QUERY,
            final_k: int = TM_FINAL_K,
            bonus_alpha: float = TM_BONUS_ALPHA,
            auto_build: bool = True,
            model: str = OLLAMA_MODEL_EMBED) -> dict:
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

    q_vecs = _embed_many(queries, model)
    if q_vecs.shape[1] != manifest.get("dim"):
        raise RuntimeError(
            f"query dim {q_vecs.shape[1]} != index dim {manifest.get('dim')} "
            f"(model mismatch — rebuild required)")
    k = max(1, min(top_k_per_query, index.ntotal))
    scores, ids = index.search(q_vecs, k)

    per_query: list[list[tuple[int, float]]] = []
    for i in range(len(queries)):
        per_query.append([
            (int(ids[i][j]), float(scores[i][j]))
            for j in range(k)
            if ids[i][j] >= 0  # faiss returns -1 for empty slots
        ])

    ranked = _aggregate_hits(per_query, bonus_alpha=bonus_alpha)
    seen_sources: set[str] = set()
    hits: list[dict] = []
    for row, final, n_hits, max_s in ranked:
        if row < 0 or row >= len(meta):
            continue
        m = meta[row]
        if not m.get("target"):
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
            "n_hits": n_hits,
        })
        if len(hits) >= final_k:
            break

    rules_text = _format_rules(hits)

    per_query_debug: list[dict] = []
    for qi, qtext in enumerate(queries):
        top = per_query[qi][0] if per_query[qi] else None
        if top is None:
            per_query_debug.append({"q": qtext[:200], "top_score": None, "top_row": None, "top_source": None})
            continue
        rid, sc = top
        per_query_debug.append({
            "q": qtext[:200],
            "top_score": round(sc, 4),
            "top_row": rid,
            "top_source": meta[rid]["source"][:200] if 0 <= rid < len(meta) else None,
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
