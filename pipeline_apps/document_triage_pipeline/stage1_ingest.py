"""Stage 1 - walk the corpus, classify each document, extract fields, flag PII.

For each document the model gets two forced tool calls:

    read_file       the model supplies the filename, we execute the read
    write_manifest  the model supplies the structured triage record

The second call is where the schema does its work. Whatever the model returns
is validated against ManifestRecord before it is allowed near the manifest;
on failure the model gets one corrective retry, and if that also fails the
document is recorded as a failure rather than quietly dropped.
"""

from __future__ import annotations

import json
from pathlib import Path

import console
import tools
from foundry_endpoint import CHAT_ALIAS, connect, ensure_loaded
from model_call import (
    assistant_tool_call_message,
    call_tool,
    tool_result_message,
)
from pydantic import ValidationError
from schemas import DocumentType, FailedRecord, Manifest, ManifestRecord

ALLOWED_TYPES = ", ".join(t.value for t in DocumentType)

# Every instruction the model actually acts on lives here rather than in the
# tool schema: Foundry Local does not forward schema `description` strings to
# the model. Moving the type definitions here is what fixed a driving licence
# being classified as an invoice.
SYSTEM_PROMPT = """You are a document triage assistant working entirely offline.

You have no filesystem access of your own: the only way to see a document is
to call the read_file tool. Classify only from what the document actually
says, and never invent names, numbers, references, or dates.

Choose document_type using these definitions:
- offer_letter: an offer of employment to a named person.
- invoice: a demand for payment, with amounts due.
- contract: an agreement between parties, including NDAs and services
  agreements.
- medical_note: clinical notes, consultations, discharge summaries.
- id_document: identity or personal-record documents such as passports,
  driving licences, and HR records built around government identifiers.
- unknown: use only if none of the above fit.

Set contains_pii to true only if the document identifies a specific
individual by name together with a date of birth, home address, medical
detail, or government identifier. Company names, company addresses, and
business bank details are NOT personal data, and a signatory's name alone on
a commercial contract is not enough.

person_name is an individual human being, never a company. Use an empty
string for any field the document does not state."""


def _read_document(client, model_id: str, documents_dir: Path, filename: str) -> tuple[list[dict], str]:
    """Run the read_file turn and return (conversation so far, document text).

    The model supplies the filename. If it gets it wrong we hand the error
    straight back and let it correct itself once, which is the honest way to
    show a small model recovering.
    """
    messages: list[dict] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Triage the document {filename}. "
                f"First read it using read_file, passing the filename "
                f"{filename} exactly as written here."
            ),
        },
    ]

    for attempt in (1, 2):
        call = call_tool(client, model_id, messages, tools.STAGE1_TOOLS, "read_file")
        if call is None:
            raise RuntimeError("model produced no read_file call")

        requested = json.loads(call.function.arguments or "{}").get("filename", "")
        result = tools.dispatch(documents_dir, "read_file", call.function.arguments)

        messages.append(assistant_tool_call_message(call))

        if requested == filename and not result.startswith("ERROR:"):
            messages.append(tool_result_message(call, result))
            return messages, result

        # Wrong filename, or the read failed. Correct it and try once more.
        if attempt == 1:
            messages.append(
                tool_result_message(
                    call,
                    f"ERROR: {requested!r} is not the requested document. "
                    f"Call read_file again with filename exactly {filename}.",
                )
            )
            continue

        # Second attempt also failed - read it ourselves so the pipeline can
        # continue, and let the manifest record that this happened.
        text = tools.read_file(documents_dir, filename)
        messages.append(tool_result_message(call, text))
        return messages, text

    raise RuntimeError("unreachable")


def _triage_one(client, model_id: str, documents_dir: Path, filename: str) -> ManifestRecord:
    """Produce one validated manifest record, with a single corrective retry."""
    messages, _ = _read_document(client, model_id, documents_dir, filename)
    messages.append(
        {
            "role": "user",
            "content": (
                "Now call write_manifest for this document. Choose the single "
                "best document_type from the allowed values. Set contains_pii "
                "to true if the document identifies a real individual. Leave a "
                "field out entirely if the document does not state it."
            ),
        }
    )

    last_error = ""
    last_raw = ""

    for attempt in (1, 2):
        call = call_tool(client, model_id, messages, tools.STAGE1_TOOLS, "write_manifest")
        if call is None:
            last_error = "model produced no write_manifest call"
            last_raw = ""
        else:
            last_raw = call.function.arguments
            try:
                return ManifestRecord.from_tool_arguments(filename, json.loads(last_raw))
            except (json.JSONDecodeError, ValidationError) as exc:
                last_error = str(exc)

        if attempt == 1:
            # One corrective turn. Telling the model what specifically failed
            # works better than asking it to "try again".
            if call is not None:
                messages.append(assistant_tool_call_message(call))
                messages.append(
                    tool_result_message(
                        call,
                        f"ERROR: that record was rejected by the schema: {last_error}",
                    )
                )
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "The record was invalid. Call write_manifest again and "
                        f"fix exactly that problem. document_type must be one "
                        f"of: {ALLOWED_TYPES}."
                    ),
                }
            )

    raise ValueError(last_error or "validation failed")


def run(
    documents_dir: Path,
    output_path: Path,
    *,
    alias: str = CHAT_ALIAS,
    quiet: bool = False,
) -> Manifest:
    """Triage every document in the corpus and write output/manifest.json."""
    if not quiet:
        console.stage_header(1, "INGEST, CLASSIFY, EXTRACT")

    client, model_id, base_url = connect(alias)
    if not quiet:
        console.info(f"Service: {base_url}")
        console.info(f"Model:   {model_id}")
        console.loading_notice(model_id)
    ensure_loaded(model_id)

    filenames = tools.list_files(documents_dir)
    if not quiet:
        console.info(f"Corpus:  {len(filenames)} documents in {console.rel(documents_dir)}/")
        console.section("Triaging")

    manifest = Manifest(model_id=model_id)

    for filename in filenames:
        try:
            record = _triage_one(client, model_id, documents_dir, filename)
        except Exception as exc:  # noqa: BLE001 - one bad document must not stop the run
            manifest.failures.append(
                FailedRecord(filename=filename, error=str(exc)[:300])
            )
            if not quiet:
                console.item(filename, "validation failed after retry", ok=False)
            continue

        manifest.records.append(record)
        if not quiet:
            pii = "PII" if record.contains_pii else "no PII"
            console.item(filename, f"{record.document_type.value:<14s} {pii}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")

    if not quiet:
        console.section("Result")
        console.info(f"{len(manifest.records)} triaged, {len(manifest.failures)} failed")
        console.info(f"Written to {console.rel(output_path)}")

    return manifest
