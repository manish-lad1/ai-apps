"""Run the eval suite against both chat models and print a comparison table.

    python evals/run_evals.py

This is what decides which model goes on stage. It is deliberately not
pre-judged anywhere in this repo: run it on the machine you will present
from, because the answer depends on that machine's memory and GPU.

Only one chat model is resident at a time — this laptop cannot hold both —
so the harness unloads the previous model before loading the next.
"""

from __future__ import annotations

import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

# Allow `python evals/run_evals.py` from the project root.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import console  # noqa: E402
import stage1_ingest  # noqa: E402
import stage2_index  # noqa: E402
import stage3_ask  # noqa: E402
from evals.cases import (  # noqa: E402
    CLASSIFICATION_CASES,
    EXTRACTION_CASES,
    GROUNDING_CASES,
    total_cases,
)
from foundry_endpoint import (  # noqa: E402
    CHAT_ALIAS,
    CHAT_COMPARISON_ALIAS,
    connect,
    ensure_loaded,
    resolve_model_id,
    unload,
)

DOCUMENTS_DIR = PROJECT_ROOT / "documents"
OUTPUT_DIR = PROJECT_ROOT / "output"
INDEX_PATH = OUTPUT_DIR / "index.json"

MODELS_UNDER_TEST = [CHAT_ALIAS, CHAT_COMPARISON_ALIAS]

CATEGORIES = ["classification", "extraction", "grounding_answer", "grounding_refusal"]


@dataclass
class CaseResult:
    category: str
    name: str
    passed: bool
    detail: str
    seconds: float


@dataclass
class ModelResult:
    alias: str
    model_id: str
    results: list[CaseResult] = field(default_factory=list)

    def in_category(self, category: str) -> list[CaseResult]:
        return [r for r in self.results if r.category == category]

    def pass_rate(self, category: str) -> tuple[int, int]:
        subset = self.in_category(category)
        return sum(1 for r in subset if r.passed), len(subset)

    def median_latency(self, category: str) -> float:
        subset = self.in_category(category)
        return statistics.median([r.seconds for r in subset]) if subset else 0.0

    @property
    def overall(self) -> tuple[int, int]:
        return sum(1 for r in self.results if r.passed), len(self.results)

    @property
    def overall_median_latency(self) -> float:
        return statistics.median([r.seconds for r in self.results]) if self.results else 0.0


def score_stage1(alias: str, model_id: str) -> tuple[list[CaseResult], object]:
    """Run Stage 1 once, then score classification and extraction from it."""
    console.info("Running Stage 1 over the corpus...")
    started = time.perf_counter()
    manifest = stage1_ingest.run(
        DOCUMENTS_DIR,
        OUTPUT_DIR / f"manifest_{alias}.json",
        alias=alias,
        quiet=True,
    )
    elapsed = time.perf_counter() - started

    by_filename = {record.filename: record for record in manifest.records}
    # Stage 1 makes two model calls per document, so attribute an average
    # per-document cost rather than pretending each case was timed separately.
    per_document = elapsed / max(len(manifest.records) + len(manifest.failures), 1)

    results: list[CaseResult] = []

    for case in CLASSIFICATION_CASES:
        record = by_filename.get(case.filename)
        if record is None:
            results.append(
                CaseResult("classification", case.name, False, "no record produced", per_document)
            )
            continue
        got = record.document_type.value
        passed = got in case.accepted_types
        results.append(
            CaseResult("classification", case.name, passed, f"got {got}", per_document)
        )

    for case in EXTRACTION_CASES:
        record = by_filename.get(case.filename)
        if record is None:
            results.append(
                CaseResult("extraction", case.name, False, "no record produced", per_document)
            )
            continue
        got = getattr(record.fields, case.field_name) or ""
        passed = case.expected_substring.lower() in got.lower()
        results.append(
            CaseResult("extraction", case.name, passed, f"got {got!r}", per_document)
        )

    return results, manifest


def score_stage3(alias: str) -> list[CaseResult]:
    """Ask every grounding question against the shared index."""
    console.info("Running Stage 3 questions...")
    index = stage2_index.load_index(INDEX_PATH)
    chat_client, chat_model_id, embed_client, embed_model_id = stage3_ask.open_clients(
        alias, quiet=True
    )

    results: list[CaseResult] = []
    for case in GROUNDING_CASES:
        started = time.perf_counter()
        answer = stage3_ask.ask(
            case.question, index, chat_client, chat_model_id, embed_client, embed_model_id
        )
        elapsed = time.perf_counter() - started

        if case.expects_refusal:
            passed = answer.refused
            category = "grounding_refusal"
        else:
            passed = (
                not answer.refused
                and case.expected_substring.lower() in answer.text.lower()
            )
            category = "grounding_answer"

        results.append(
            CaseResult(category, case.name, passed, f"got {answer.text[:60]!r}", elapsed)
        )

    return results


def evaluate(alias: str, other_aliases: list[str]) -> ModelResult:
    console.banner(f"EVALUATING {alias}")

    # This machine cannot hold both chat models, so free the other one first.
    client, model_id, _ = connect(alias)
    for other in other_aliases:
        unload(resolve_model_id(client, other))
    console.loading_notice(model_id)
    ensure_loaded(model_id)

    result = ModelResult(alias=alias, model_id=model_id)
    stage1_results, _ = score_stage1(alias, model_id)
    result.results.extend(stage1_results)
    result.results.extend(score_stage3(alias))

    passed, total = result.overall
    console.info(f"{alias}: {passed}/{total} passed")
    return result


def print_case_detail(results: list[ModelResult]) -> None:
    console.section("Per-case results")
    header = f"   {'case':<52s}" + "".join(f"{r.alias:>14s}" for r in results)
    print(header)
    print("   " + "-" * (52 + 14 * len(results)))

    names = [r.name for r in results[0].results]
    for position, name in enumerate(names):
        marks = ""
        for model_result in results:
            case_result = model_result.results[position]
            marks += f"{'pass' if case_result.passed else 'FAIL':>14s}"
        print(f"   {name[:52]:<52s}{marks}")


def print_comparison(results: list[ModelResult]) -> None:
    console.banner("MODEL COMPARISON")
    for model_result in results:
        console.info(f"{model_result.alias:<12s} -> {model_result.model_id}")

    console.section("Pass rate by category")
    header = f"   {'category':<20s}" + "".join(f"{r.alias:>22s}" for r in results)
    print(header)
    print("   " + "-" * (20 + 22 * len(results)))

    for category in CATEGORIES:
        row = f"   {category:<20s}"
        for model_result in results:
            passed, total = model_result.pass_rate(category)
            percent = (100 * passed / total) if total else 0.0
            median = model_result.median_latency(category)
            row += f"{f'{passed}/{total} ({percent:.0f}%) {median:.1f}s':>22s}"
        print(row)

    print("   " + "-" * (20 + 22 * len(results)))
    row = f"   {'OVERALL':<20s}"
    for model_result in results:
        passed, total = model_result.overall
        percent = (100 * passed / total) if total else 0.0
        median = model_result.overall_median_latency
        row += f"{f'{passed}/{total} ({percent:.0f}%) {median:.1f}s':>22s}"
    print(row)
    print()
    console.info("Latency shown is the median per case in that category.")


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    if not INDEX_PATH.exists():
        console.info(
            "output/index.json not found — building it first "
            "(embeddings do not depend on the chat model under test)."
        )
        stage1_ingest.run(DOCUMENTS_DIR, OUTPUT_DIR / "manifest.json", quiet=True)
        stage2_index.run(
            DOCUMENTS_DIR, OUTPUT_DIR / "manifest.json", INDEX_PATH, quiet=True
        )

    console.info(f"{total_cases()} cases per model, {len(MODELS_UNDER_TEST)} models")

    results = []
    for alias in MODELS_UNDER_TEST:
        others = [a for a in MODELS_UNDER_TEST if a != alias]
        results.append(evaluate(alias, others))

    print_case_detail(results)
    print_comparison(results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
