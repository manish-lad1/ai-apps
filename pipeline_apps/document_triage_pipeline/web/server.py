"""A local web front end for the pipeline. Same three stages, no terminal.

Everything here is a thin wrapper over the stage modules — the UI is a
different way to drive the pipeline, not a second implementation of it.
`run_demo.py` still works and still does exactly what it did.

Two corpora are served: the curated demo documents, and whatever the user
uploads. See corpora.py for why they are kept apart.

Stage 1 takes the better part of a minute, so the long-running stages stream
progress as server-sent events rather than leaving a POST hanging. The stage
functions are synchronous, so each runs on a worker thread and pushes events
into a queue that the SSE generator drains.

Bound to 127.0.0.1. Nothing here reaches off the machine.
"""

from __future__ import annotations

import json
import queue
import shutil
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

import corpora
import document_text
import stage1_ingest
import stage2_index
import stage3_agentframework
import stage3_ask
import tools
from corpora import MAX_UPLOAD_BYTES, Corpus
from foundry_endpoint import (
    CHAT_ALIAS,
    CHAT_COMPARISON_ALIAS,
    FoundryUnavailable,
    connect,
    discover_service_url,
    resolve_model_id,
    unload,
)
from schemas import Manifest

INDEX_HTML = Path(__file__).resolve().parent / "index.html"

app = FastAPI(title="Document Triage Pipeline", docs_url=None, redoc_url=None)

# Stage 3 keeps its models and index warm between questions — reloading the
# index per question is the difference between instant and a few seconds.
_ask_state: dict = {}
_ask_lock = threading.Lock()


class AskRequest(BaseModel):
    question: str
    corpus: str = "demo"
    model: str = CHAT_ALIAS
    # "raw" is the openai client on phi-4-mini; "agent-framework" is Microsoft
    # Agent Framework on qwen3-4b. Same retrieval, same prompt, different
    # generation stack.
    engine: str = "raw"


def _corpus(key: str) -> Corpus:
    try:
        return corpora.get(key)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _invalidate(corpus_key: str) -> None:
    with _ask_lock:
        if _ask_state.get("corpus") == corpus_key:
            _ask_state.clear()


def _sse(kind: str, payload: dict) -> str:
    return f"event: {kind}\ndata: {json.dumps(payload)}\n\n"


def _stream_stage(target, kwargs: dict) -> Iterator[str]:
    """Run a blocking stage on a thread, relaying its events as SSE.

    A sentinel is pushed when the worker exits so the generator terminates
    even if the stage raised before emitting "finished".
    """
    events: queue.Queue = queue.Queue()
    DONE = object()

    def on_event(kind: str, payload: dict) -> None:
        events.put((kind, payload))

    def worker() -> None:
        started = time.perf_counter()
        try:
            target(**kwargs, quiet=True, on_event=on_event)
            events.put(("elapsed", {"seconds": round(time.perf_counter() - started, 1)}))
        except FoundryUnavailable as exc:
            events.put(("error", {"message": f"Foundry Local unavailable: {exc}"}))
        except FileNotFoundError as exc:
            events.put(("error", {"message": str(exc)}))
        except Exception as exc:  # noqa: BLE001 - surface anything to the UI
            events.put(("error", {"message": f"{type(exc).__name__}: {exc}"}))
        finally:
            events.put((DONE, None))

    threading.Thread(target=worker, daemon=True).start()

    while True:
        kind, payload = events.get()
        if kind is DONE:
            break
        yield _sse(kind, payload)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return INDEX_HTML.read_text(encoding="utf-8")


def _corpus_state(corpus: Corpus) -> dict:
    corpus.ensure()

    manifest_summary = None
    if corpus.manifest_path.exists():
        manifest = Manifest.model_validate_json(
            corpus.manifest_path.read_text(encoding="utf-8")
        )
        manifest_summary = {
            "model_id": manifest.model_id,
            "triaged": len(manifest.records),
            "failed": len(manifest.failures),
        }

    index_summary = None
    if corpus.index_path.exists():
        built = stage2_index.load_index(corpus.index_path)
        index_summary = {
            "chunks": len(built.chunks),
            "dimensions": built.dimensions,
            "embedding_model_id": built.embedding_model_id,
        }

    return {
        "key": corpus.key,
        "label": corpus.label,
        "writable": corpus.writable,
        "documents": len(tools.list_files(corpus.directory)),
        "manifest": manifest_summary,
        "index": index_summary,
    }


@app.get("/api/state")
def state() -> dict:
    try:
        service_url = discover_service_url()
        service_error = None
    except FoundryUnavailable as exc:
        service_url = None
        service_error = str(exc)

    return {
        "service_url": service_url,
        "service_error": service_error,
        "corpora": [_corpus_state(c) for c in corpora.ALL.values()],
        "models": {"chat": CHAT_ALIAS, "comparison": CHAT_COMPARISON_ALIAS},
        "supported_formats": sorted(
            s.lstrip(".") for s in document_text.SUPPORTED_SUFFIXES
        ),
        "max_upload_mb": MAX_UPLOAD_BYTES // (1024 * 1024),
    }


@app.get("/api/corpus/{corpus_key}")
def corpus_files(corpus_key: str) -> dict:
    corpus = _corpus(corpus_key)
    corpus.ensure()

    files = []
    for name in tools.list_files(corpus.directory):
        source = corpus.directory / name
        entry = {
            "filename": name,
            "bytes": source.stat().st_size,
            "format": source.suffix.lower().lstrip(".") or "?",
        }
        try:
            text = document_text.cached_text(corpus.directory, name)
            entry["characters"] = len(text)
            entry["preview"] = text[:180].strip()
        except document_text.UnsupportedDocument as exc:
            entry["characters"] = 0
            entry["preview"] = ""
            entry["error"] = str(exc)
        files.append(entry)

    return {"corpus": corpus.key, "files": files}


@app.get("/api/document/{corpus_key}/{filename}")
def document(corpus_key: str, filename: str) -> dict:
    corpus = _corpus(corpus_key)
    try:
        return {
            "filename": filename,
            "text": tools.read_file(corpus.directory, filename),
        }
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except document_text.UnsupportedDocument as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc


@app.get("/api/manifest/{corpus_key}")
def manifest(corpus_key: str) -> dict:
    corpus = _corpus(corpus_key)
    if not corpus.manifest_path.exists():
        raise HTTPException(status_code=404, detail="Stage 1 has not run yet.")
    return json.loads(corpus.manifest_path.read_text(encoding="utf-8"))


@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...)) -> dict:
    """Accept documents into the uploads corpus.

    Uploads only ever land in the writable corpus — the demo corpus is
    version-controlled content and the eval suite depends on it.
    """
    corpus = corpora.UPLOADS
    corpus.ensure()

    accepted, rejected = [], []

    for upload_file in files:
        raw_name = upload_file.filename or ""
        try:
            name = corpora.safe_filename(raw_name)
        except ValueError as exc:
            rejected.append({"filename": raw_name, "reason": str(exc)})
            continue

        if not document_text.is_supported(name):
            rejected.append(
                {
                    "filename": name,
                    "reason": f"Unsupported format. Supported: "
                    f"{document_text.describe_supported()}.",
                }
            )
            continue

        name = corpora.unique_filename(corpus.directory, name)
        destination = corpus.directory / name

        # Stream to disk with a running size check, so an oversized file is
        # stopped partway rather than after it has all been buffered.
        written = 0
        try:
            with destination.open("wb") as sink:
                while chunk := await upload_file.read(1024 * 1024):
                    written += len(chunk)
                    if written > MAX_UPLOAD_BYTES:
                        raise ValueError(
                            f"Larger than the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit."
                        )
                    sink.write(chunk)
        except ValueError as exc:
            destination.unlink(missing_ok=True)
            rejected.append({"filename": name, "reason": str(exc)})
            continue

        # Parse it now rather than at stage time, so a corrupt or scanned file
        # is reported while the user is still looking at the upload box.
        try:
            text = document_text.cached_text(corpus.directory, name)
        except document_text.UnsupportedDocument as exc:
            destination.unlink(missing_ok=True)
            document_text.forget(corpus.directory, name)
            rejected.append({"filename": name, "reason": str(exc)})
            continue

        accepted.append(
            {"filename": name, "bytes": written, "characters": len(text)}
        )

    # Anything already built is now stale.
    if accepted:
        _invalidate(corpus.key)

    return {"accepted": accepted, "rejected": rejected}


@app.delete("/api/upload/{filename}")
def delete_upload(filename: str) -> dict:
    corpus = corpora.UPLOADS
    target = (corpus.directory / filename).resolve()
    if target.parent != corpus.directory.resolve():
        raise HTTPException(status_code=400, detail="Refusing to delete outside uploads.")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="No such upload.")

    target.unlink()
    document_text.forget(corpus.directory, filename)
    _invalidate(corpus.key)
    return {"deleted": filename}


@app.post("/api/uploads/clear")
def clear_uploads() -> dict:
    corpus = corpora.UPLOADS
    removed = 0
    if corpus.directory.is_dir():
        removed = len(tools.list_files(corpus.directory))
        shutil.rmtree(corpus.directory)
    corpus.ensure()
    corpus.manifest_path.unlink(missing_ok=True)
    corpus.index_path.unlink(missing_ok=True)
    _invalidate(corpus.key)
    return {"removed": removed}


@app.post("/api/stage1/{corpus_key}")
def stage1(corpus_key: str, model: str = CHAT_ALIAS) -> StreamingResponse:
    corpus = _corpus(corpus_key)
    corpus.ensure()

    if not tools.list_files(corpus.directory):
        raise HTTPException(
            status_code=409,
            detail="No documents in this corpus yet — upload some first.",
        )

    _invalidate(corpus.key)
    return StreamingResponse(
        _stream_stage(
            stage1_ingest.run,
            {
                "documents_dir": corpus.directory,
                "output_path": corpus.manifest_path,
                "alias": model,
            },
        ),
        media_type="text/event-stream",
    )


@app.post("/api/stage2/{corpus_key}")
def stage2(corpus_key: str) -> StreamingResponse:
    corpus = _corpus(corpus_key)
    _invalidate(corpus.key)
    return StreamingResponse(
        _stream_stage(
            stage2_index.run,
            {
                "documents_dir": corpus.directory,
                "manifest_path": corpus.manifest_path,
                "index_path": corpus.index_path,
            },
        ),
        media_type="text/event-stream",
    )


def _evict_other_chat_model(keep_alias: str) -> None:
    """Unload the chat model the other engine uses, to make room for this one."""
    other = CHAT_COMPARISON_ALIAS if keep_alias == CHAT_ALIAS else CHAT_ALIAS
    try:
        client, _, _ = connect(keep_alias)
        unload(resolve_model_id(client, other))
    except FoundryUnavailable:
        pass


def _open_engine(engine: str, model_alias: str) -> dict:
    """Bring up one answering engine, evicting the other model only if needed.

    Both chat models plus the embedding model fit comfortably on a 24 GB
    machine, and when they do, switching engines mid-demo is instant. Evicting
    on every switch would cost a ten-second model load each time for nothing.

    So the eviction is a fallback rather than a precaution: try to open the
    engine, and only if that fails — which is what running out of memory looks
    like from here — free the other model and try once more.
    """

    def build() -> dict:
        if engine == "agent-framework":
            answerer = stage3_agentframework.AgentFrameworkAnswerer()
            answerer.open()
            return {"answerer": answerer, "model_id": answerer.chat_model_id}
        clients = stage3_ask.open_clients(model_alias, quiet=True)
        return {"clients": clients, "model_id": clients[1]}

    try:
        return build()
    except Exception:  # noqa: BLE001 - retry once with the other model evicted
        _evict_other_chat_model(
            CHAT_COMPARISON_ALIAS if engine == "agent-framework" else model_alias
        )
        return build()


@app.post("/api/ask")
def ask(request: AskRequest) -> dict:
    corpus = _corpus(request.corpus)
    question = request.question.strip()

    if not question:
        raise HTTPException(status_code=400, detail="Ask something.")
    if request.engine not in ("raw", "agent-framework"):
        raise HTTPException(status_code=400, detail=f"Unknown engine {request.engine!r}.")
    if not corpus.index_path.exists():
        raise HTTPException(
            status_code=409,
            detail=f"No index for {corpus.label} yet — run stages 1 and 2 first.",
        )

    # Foundry's port is ephemeral. If the service restarts mid-session the
    # cached clients point at a dead port, so the discovered URL is part of
    # the cache key — a restart transparently rebuilds them instead of
    # failing every question until the web server is restarted too.
    try:
        current_url = discover_service_url()
    except FoundryUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    with _ask_lock:
        stale = (
            _ask_state.get("model") != request.model
            or _ask_state.get("corpus") != corpus.key
            or _ask_state.get("engine") != request.engine
            or _ask_state.get("service_url") != current_url
        )
        if stale:
            _ask_state.clear()

        if not _ask_state:
            try:
                engine_state = _open_engine(request.engine, request.model)
            except FoundryUnavailable as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc

            _ask_state.update(
                {
                    "model": request.model,
                    "corpus": corpus.key,
                    "engine": request.engine,
                    "service_url": current_url,
                    "index": stage2_index.load_index(corpus.index_path),
                    **engine_state,
                }
            )

        built = _ask_state["index"]
        chat_model_id = _ask_state["model_id"]

    started = time.perf_counter()
    if request.engine == "agent-framework":
        answer = _ask_state["answerer"].ask(question, built)
    else:
        chat_client, _, embed_client, embed_model_id = _ask_state["clients"]
        answer = stage3_ask.ask(
            question, built, chat_client, chat_model_id, embed_client, embed_model_id
        )
    elapsed = time.perf_counter() - started

    ordered_sources: list[str] = []
    for name in answer.sources:
        if name not in ordered_sources:
            ordered_sources.append(name)

    return {
        "question": answer.question,
        "answer": answer.text,
        "refused": answer.refused,
        "corpus": corpus.key,
        "engine": request.engine,
        "engine_label": (
            "Agent Framework" if request.engine == "agent-framework" else "raw openai client"
        ),
        "sources": ordered_sources,
        "retrieved": [
            {"filename": name, "score": score}
            for name, score in zip(answer.sources, answer.scores)
        ],
        "seconds": round(elapsed, 2),
        "model_id": chat_model_id,
    }
