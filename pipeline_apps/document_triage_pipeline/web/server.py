"""A local web front end for the pipeline. Same three stages, no terminal.

Everything here is a thin wrapper over the stage modules — the UI is a
different way to drive the pipeline, not a second implementation of it.
`run_demo.py` still works and still does exactly what it did.

Stage 1 takes the better part of a minute, so the long-running stages stream
progress as server-sent events rather than leaving a POST hanging. The stage
functions are synchronous, so each runs on a worker thread and pushes events
into a queue that the SSE generator drains.

Bound to 127.0.0.1. Nothing here reaches off the machine.
"""

from __future__ import annotations

import json
import queue
import threading
import time
from collections.abc import Iterator
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

import stage1_ingest
import stage2_index
import stage3_ask
import tools
from foundry_endpoint import (
    CHAT_ALIAS,
    CHAT_COMPARISON_ALIAS,
    FoundryUnavailable,
    discover_service_url,
)
from schemas import Manifest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DOCUMENTS_DIR = PROJECT_ROOT / "documents"
OUTPUT_DIR = PROJECT_ROOT / "output"
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"
INDEX_PATH = OUTPUT_DIR / "index.json"
INDEX_HTML = Path(__file__).resolve().parent / "index.html"

app = FastAPI(title="Document Triage Pipeline", docs_url=None, redoc_url=None)

# Stage 3 keeps its models and index warm between questions — reloading a
# 347 KB index per question is the difference between 3.5s and instant.
_ask_state: dict = {}
_ask_lock = threading.Lock()


class AskRequest(BaseModel):
    question: str
    model: str = CHAT_ALIAS


def _sse(kind: str, payload: dict) -> str:
    """Format one server-sent event."""
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


@app.get("/api/state")
def state() -> dict:
    """What the UI needs on load: service health and what has been built."""
    try:
        service_url = discover_service_url()
        service_error = None
    except FoundryUnavailable as exc:
        service_url = None
        service_error = str(exc)

    manifest_summary = None
    if MANIFEST_PATH.exists():
        manifest = Manifest.model_validate_json(
            MANIFEST_PATH.read_text(encoding="utf-8")
        )
        manifest_summary = {
            "model_id": manifest.model_id,
            "triaged": len(manifest.records),
            "failed": len(manifest.failures),
        }

    index_summary = None
    if INDEX_PATH.exists():
        built = stage2_index.load_index(INDEX_PATH)
        index_summary = {
            "chunks": len(built.chunks),
            "dimensions": built.dimensions,
            "embedding_model_id": built.embedding_model_id,
        }

    return {
        "service_url": service_url,
        "service_error": service_error,
        "documents": len(tools.list_files(DOCUMENTS_DIR)),
        "manifest": manifest_summary,
        "index": index_summary,
        "models": {"chat": CHAT_ALIAS, "comparison": CHAT_COMPARISON_ALIAS},
    }


@app.get("/api/corpus")
def corpus() -> dict:
    files = []
    for name in tools.list_files(DOCUMENTS_DIR):
        text = tools.read_file(DOCUMENTS_DIR, name)
        files.append(
            {
                "filename": name,
                "characters": len(text),
                "preview": text[:180].strip(),
            }
        )
    return {"files": files}


@app.get("/api/document/{filename}")
def document(filename: str) -> dict:
    try:
        return {"filename": filename, "text": tools.read_file(DOCUMENTS_DIR, filename)}
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/manifest")
def manifest() -> dict:
    if not MANIFEST_PATH.exists():
        raise HTTPException(status_code=404, detail="Stage 1 has not run yet.")
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


@app.post("/api/stage1")
def stage1(model: str = CHAT_ALIAS) -> StreamingResponse:
    # A new manifest invalidates the warm Stage 3 state.
    with _ask_lock:
        _ask_state.clear()
    return StreamingResponse(
        _stream_stage(
            stage1_ingest.run,
            {
                "documents_dir": DOCUMENTS_DIR,
                "output_path": MANIFEST_PATH,
                "alias": model,
            },
        ),
        media_type="text/event-stream",
    )


@app.post("/api/stage2")
def stage2() -> StreamingResponse:
    with _ask_lock:
        _ask_state.clear()
    return StreamingResponse(
        _stream_stage(
            stage2_index.run,
            {
                "documents_dir": DOCUMENTS_DIR,
                "manifest_path": MANIFEST_PATH,
                "index_path": INDEX_PATH,
            },
        ),
        media_type="text/event-stream",
    )


@app.post("/api/ask")
def ask(request: AskRequest) -> dict:
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Ask something.")
    if not INDEX_PATH.exists():
        raise HTTPException(
            status_code=409, detail="No index yet — run stages 1 and 2 first."
        )

    with _ask_lock:
        if _ask_state.get("model") != request.model:
            _ask_state.clear()
        if not _ask_state:
            try:
                clients = stage3_ask.open_clients(request.model, quiet=True)
            except FoundryUnavailable as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            _ask_state.update(
                {
                    "model": request.model,
                    "clients": clients,
                    "index": stage2_index.load_index(INDEX_PATH),
                }
            )

        chat_client, chat_model_id, embed_client, embed_model_id = _ask_state["clients"]
        built = _ask_state["index"]

    started = time.perf_counter()
    answer = stage3_ask.ask(
        question, built, chat_client, chat_model_id, embed_client, embed_model_id
    )
    elapsed = time.perf_counter() - started

    # Deduplicate sources while preserving retrieval rank.
    ordered_sources: list[str] = []
    for name in answer.sources:
        if name not in ordered_sources:
            ordered_sources.append(name)

    return {
        "question": answer.question,
        "answer": answer.text,
        "refused": answer.refused,
        "sources": ordered_sources,
        "retrieved": [
            {"filename": name, "score": score}
            for name, score in zip(answer.sources, answer.scores)
        ],
        "seconds": round(elapsed, 2),
        "model_id": chat_model_id,
    }
