"""The contract between a small local model and the rest of the pipeline.

A 3.8 GB model drifts on free-form output: it invents document types, returns
"N/A" where a number belongs, and occasionally answers in prose. Validation is
what turns that into something deterministic enough to demo live. Every record
passes through ManifestRecord before it reaches output/manifest.json.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator


class DocumentType(StrEnum):
    """The closed set of types Stage 1 is allowed to return."""

    OFFER_LETTER = "offer_letter"
    INVOICE = "invoice"
    CONTRACT = "contract"
    MEDICAL_NOTE = "medical_note"
    ID_DOCUMENT = "id_document"
    UNKNOWN = "unknown"


class ExtractedFields(BaseModel):
    """Fields worth pulling out of any document type.

    All optional: an invoice has no patient, a medical note has no amount.
    Absent is meaningful; a hallucinated value is not.
    """

    model_config = ConfigDict(extra="ignore")

    person_name: str | None = Field(
        default=None, description="The main individual the document concerns."
    )
    organisation: str | None = Field(
        default=None, description="The issuing or counterparty organisation."
    )
    reference: str | None = Field(
        default=None, description="Invoice number, agreement reference, or similar."
    )
    date: str | None = Field(
        default=None, description="The document's principal date, ISO format if possible."
    )
    amount: str | None = Field(
        default=None, description="The principal monetary amount, with currency."
    )

    @field_validator("*", mode="before")
    @classmethod
    def blank_to_none(cls, value: object) -> object:
        """Small models say "N/A" and "unknown" instead of omitting a field."""
        if isinstance(value, str):
            cleaned = value.strip()
            if cleaned.lower() in {"", "n/a", "na", "none", "null", "unknown", "not specified"}:
                return None
            return cleaned
        return value


class ManifestRecord(BaseModel):
    """One triaged document. This is what Stage 2 and Stage 3 build on."""

    model_config = ConfigDict(extra="ignore")

    filename: str
    document_type: DocumentType
    summary: str = Field(min_length=10, description="One or two sentences, plain English.")
    contains_pii: bool
    pii_types: list[str] = Field(
        default_factory=list,
        description="Categories of personal data present, e.g. name, date_of_birth.",
    )
    fields: ExtractedFields = Field(default_factory=ExtractedFields)

    @field_validator("document_type", mode="before")
    @classmethod
    def coerce_document_type(cls, value: object) -> object:
        """Accept near-misses like "Offer Letter" or "invoice " before failing."""
        if isinstance(value, str):
            normalised = value.strip().lower().replace(" ", "_").replace("-", "_")
            if normalised in set(DocumentType):
                return normalised
            return DocumentType.UNKNOWN.value
        return value

    @field_validator("pii_types", mode="before")
    @classmethod
    def coerce_pii_types(cls, value: object) -> object:
        """Models sometimes return a comma-separated string instead of a list."""
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    @classmethod
    def from_tool_arguments(cls, filename: str, payload: dict) -> "ManifestRecord":
        """Build a record from write_manifest's flat argument object.

        The tool schema is flat because small models reliably leave nested
        objects empty; the nesting is reassembled here instead.
        """
        return cls.model_validate(
            {
                "filename": filename,
                "document_type": payload.get("document_type"),
                "summary": payload.get("summary"),
                "contains_pii": payload.get("contains_pii"),
                "pii_types": payload.get("pii_types", []),
                "fields": {
                    "person_name": payload.get("person_name"),
                    "organisation": payload.get("organisation"),
                    "reference": payload.get("reference"),
                    "date": payload.get("date"),
                    "amount": payload.get("amount"),
                },
            }
        )


class FailedRecord(BaseModel):
    """A document the model could not be made to describe validly.

    Recorded explicitly rather than dropped — a silently shorter manifest is
    the worst possible outcome on stage.
    """

    filename: str
    error: str
    raw_output: str | None = None


class Manifest(BaseModel):
    """The whole of Stage 1's output."""

    model_id: str
    records: list[ManifestRecord] = Field(default_factory=list)
    failures: list[FailedRecord] = Field(default_factory=list)


class Chunk(BaseModel):
    """One embedded passage, carrying its Stage 1 metadata forward."""

    chunk_id: str
    filename: str
    text: str
    embedding: list[float]
    document_type: DocumentType
    contains_pii: bool


class Index(BaseModel):
    """The whole of Stage 2's output. Small enough to keep as one JSON file."""

    embedding_model_id: str
    dimensions: int
    chunks: list[Chunk] = Field(default_factory=list)
