"""The three tools Stage 1 gives the model, and their implementations.

Each tool is two things kept side by side on purpose: the JSON schema the
model sees, and the Python that actually runs. Keeping them in one file makes
the pairing obvious when this is on a projector.

A note on how these get called. The endpoint verification for this project
found that Phi-4-mini never volunteers a tool call — with tool_choice="auto"
it produced 0 calls in 10 attempts and instead replied "I'm unable to read
files directly". With tool_choice naming a function it produced 10 well-formed
calls out of 10. So the pipeline names the tool it wants at each step rather
than letting the model decide. The model still supplies the arguments, which
is the part that needs a model.

A second note, which matters more than it looks. Foundry Local forwards the
*structure* of these schemas to the model — property names, types, enum
values, and the required list — but not the `description` strings. Writing
careful descriptions here changed nothing; moving the same words into the
system prompt fixed a misclassification immediately. The descriptions below
are therefore documentation for the reader, and every instruction the model
actually needs lives in stage1_ingest.SYSTEM_PROMPT.
"""

from __future__ import annotations

import json
from pathlib import Path

import document_text
from schemas import DocumentType

# Cap on how much of a document goes into a single prompt. The model advertises
# a 131072 context, but that is a ceiling, not a budget — the demo keeps prompts
# in the low thousands of tokens so latency stays presentable.
MAX_DOCUMENT_CHARS = 6000


# --------------------------------------------------------------------------
# Tool schemas — what the model sees
# --------------------------------------------------------------------------

LIST_FILES_TOOL = {
    "type": "function",
    "function": {
        "name": "list_files",
        "description": "List every document filename available in the corpus.",
        "parameters": {"type": "object", "properties": {}},
    },
}

READ_FILE_TOOL = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read the full text of one document from the corpus.",
        "parameters": {
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "The exact filename, copied verbatim from the request.",
                }
            },
            "required": ["filename"],
        },
    },
}

# The extracted fields are deliberately FLAT rather than nested under a
# "fields" object. With a nested object Phi-4-mini returned the object empty on
# all 10 documents while still writing a good summary — it classifies fine but
# will not populate a sub-object. Flattened, the same model fills them in.
WRITE_MANIFEST_TOOL = {
    "type": "function",
    "function": {
        "name": "write_manifest",
        "description": (
            "Record the triage result for one document: what kind of document "
            "it is, a short summary, whether it contains personal data, and the "
            "key values extracted from it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "document_type": {
                    "type": "string",
                    "enum": [t.value for t in DocumentType],
                    "description": (
                        "The single best-fitting type. "
                        "offer_letter: an offer of employment to a named person. "
                        "invoice: a demand for payment with amounts due. "
                        "contract: an agreement between parties, including NDAs "
                        "and master services agreements. "
                        "medical_note: clinical notes, consultations, discharge "
                        "summaries. "
                        "id_document: identity or personal-record documents such "
                        "as passports, driving licences, and HR records built "
                        "around government identifiers. "
                        "unknown: use only if none of the above fit."
                    ),
                },
                "summary": {
                    "type": "string",
                    "description": "One or two plain sentences describing the document.",
                },
                "contains_pii": {
                    "type": "boolean",
                    "description": (
                        "True only if the document identifies a specific "
                        "individual person, for example by their name together "
                        "with a date of birth, home address, medical detail, or "
                        "government identifier. Company names, company addresses, "
                        "and business bank details are NOT personal data. A "
                        "signatory's name alone on a commercial contract is NOT "
                        "enough to make this true."
                    ),
                },
                "pii_types": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Categories of personal data present. Use values from: "
                        "name, date_of_birth, address, phone, email, "
                        "passport_number, driving_licence, national_insurance, "
                        "nhs_number, bank_details, medical_information, salary. "
                        "Empty list if contains_pii is false."
                    ),
                },
                "person_name": {
                    "type": "string",
                    "description": "The main individual the document concerns, if any.",
                },
                "organisation": {
                    "type": "string",
                    "description": "The issuing or counterparty organisation, if any.",
                },
                "reference": {
                    "type": "string",
                    "description": (
                        "The document's own reference: invoice number, agreement "
                        "reference, record number, or licence number."
                    ),
                },
                "date": {
                    "type": "string",
                    "description": (
                        "The document's principal date in YYYY-MM-DD form: the "
                        "issue date, invoice date, effective date, or date seen."
                    ),
                },
                "amount": {
                    "type": "string",
                    "description": (
                        "The principal monetary amount including currency, for "
                        "example 'GBP 4,820.00'. Omit if the document states none."
                    ),
                },
            },
            # Every field is required, including the ones that are often
            # absent from a document. Phi-4-mini emits ONLY the properties
            # listed here — with the extraction fields optional it returned
            # just the first three on all 10 documents. The convention is an
            # empty string for "the document does not say", which the schema
            # layer turns back into None.
            "required": [
                "document_type",
                "summary",
                "contains_pii",
                "pii_types",
                "person_name",
                "organisation",
                "reference",
                "date",
                "amount",
            ],
        },
    },
}

STAGE1_TOOLS = [LIST_FILES_TOOL, READ_FILE_TOOL, WRITE_MANIFEST_TOOL]


# --------------------------------------------------------------------------
# Tool implementations — what actually runs
# --------------------------------------------------------------------------


def list_files(documents_dir: Path) -> list[str]:
    """Return the corpus filenames, sorted so runs are reproducible.

    Anything document_text can read counts, so an uploaded PDF sits alongside
    the demo corpus's .txt files and flows through the same pipeline. Hidden
    files and the .extracted cache directory are skipped.
    """
    if not documents_dir.is_dir():
        return []

    return sorted(
        path.name
        for path in documents_dir.iterdir()
        if path.is_file()
        and not path.name.startswith(".")
        and document_text.is_supported(path.name)
    )


def read_file(documents_dir: Path, filename: str) -> str:
    """Read one document as text, truncated to the per-call cap.

    The filename is resolved against the corpus directory and rejected if it
    escapes — the model supplies this argument, so it is untrusted input.
    """
    candidate = (documents_dir / filename).resolve()
    if candidate.parent != documents_dir.resolve():
        raise ValueError(f"Refusing to read outside the corpus: {filename!r}")
    if not candidate.is_file():
        raise FileNotFoundError(f"No such document: {filename!r}")

    text = document_text.cached_text(documents_dir, filename)
    if len(text) > MAX_DOCUMENT_CHARS:
        return text[:MAX_DOCUMENT_CHARS] + "\n[truncated]"
    return text


def dispatch(documents_dir: Path, name: str, arguments: str) -> str:
    """Run a tool the model asked for and return its result as a string.

    Tool results go back to the model as message content, so everything is
    serialised to text here.
    """
    try:
        parsed = json.loads(arguments) if arguments.strip() else {}
    except json.JSONDecodeError:
        return f"ERROR: arguments were not valid JSON: {arguments!r}"

    try:
        if name == "list_files":
            return "\n".join(list_files(documents_dir))
        if name == "read_file":
            return read_file(documents_dir, parsed["filename"])
    except (ValueError, FileNotFoundError, KeyError) as exc:
        return f"ERROR: {exc}"

    return f"ERROR: unknown tool {name!r}"
