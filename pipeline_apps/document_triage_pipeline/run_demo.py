"""Run the whole pipeline. One command on stage, not three.

    python run_demo.py                 all three stages
    python run_demo.py --stage 1       just ingest and classify
    python run_demo.py --stage 2       just chunk and embed
    python run_demo.py --stage 3       just the default questions
    python run_demo.py --ask "..."     ask one question of the existing index
    python run_demo.py --model qwen3-4b   run against the comparison model

The per-stage flags exist for recovery: if something fails live, the stage
that already succeeded left its output on disk and does not need redoing.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import console
import stage1_ingest
import stage2_index
import stage3_ask
from foundry_endpoint import CHAT_ALIAS, FoundryUnavailable

HERE = Path(__file__).parent
DOCUMENTS_DIR = HERE / "documents"
OUTPUT_DIR = HERE / "output"
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"
INDEX_PATH = OUTPUT_DIR / "index.json"

# Chosen to show three different things: a single-document lookup, a question
# that can only be answered by combining two documents, and a question whose
# answer is deliberately absent.
DEFAULT_QUESTIONS = [
    "What is the total due on invoice INV-2026-0412?",
    "What is the hourly rate in the agreement that invoice INV-BW-2291 was issued against?",
    "What medication was Ravi Shah started on?",
    "What is Amelia Hart's home address?",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Local-first document triage and RAG pipeline."
    )
    parser.add_argument(
        "--stage",
        type=int,
        choices=(1, 2, 3),
        help="Run a single stage instead of all three.",
    )
    parser.add_argument(
        "--ask",
        metavar="QUESTION",
        help="Ask one question against the existing index and exit.",
    )
    parser.add_argument(
        "--model",
        default=CHAT_ALIAS,
        help=f"Chat model alias to use (default: {CHAT_ALIAS}).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()

    try:
        if args.ask:
            stage3_ask.run(INDEX_PATH, [args.ask], alias=args.model)
            return 0

        if args.stage in (None, 1):
            with console.timed("Stage 1"):
                stage1_ingest.run(DOCUMENTS_DIR, MANIFEST_PATH, alias=args.model)

        if args.stage in (None, 2):
            with console.timed("Stage 2"):
                stage2_index.run(DOCUMENTS_DIR, MANIFEST_PATH, INDEX_PATH)

        if args.stage in (None, 3):
            with console.timed("Stage 3"):
                stage3_ask.run(INDEX_PATH, DEFAULT_QUESTIONS, alias=args.model)

    except FoundryUnavailable as exc:
        print()
        print(f"   Foundry Local is not available: {exc}")
        return 1
    except FileNotFoundError as exc:
        print()
        print(f"   {exc}")
        return 1

    print()
    print("=" * console.WIDTH)
    print(f"  DONE in {time.perf_counter() - started:.1f}s — everything ran locally")
    print("=" * console.WIDTH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
