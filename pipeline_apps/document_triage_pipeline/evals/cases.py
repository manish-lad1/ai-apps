"""The test cases. Ground truth is the documents, not a previous model run.

Four categories:

  classification    did Stage 1 pick the right document_type?
  extraction        did Stage 1 pull the right value out of the document?
  grounding_answer  does Stage 3 answer a question the corpus can support?
  grounding_refusal does Stage 3 refuse one it cannot?

The refusal cases matter most. A model that answers everything scores well on
grounding_answer and is useless; the two categories are only meaningful read
together.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ClassificationCase:
    filename: str
    # A set, because one document in the corpus is deliberately ambiguous and
    # more than one answer is genuinely defensible.
    accepted_types: frozenset[str]
    note: str = ""

    @property
    def name(self) -> str:
        return f"classify {self.filename}"


@dataclass(frozen=True)
class ExtractionCase:
    filename: str
    field_name: str
    expected_substring: str

    @property
    def name(self) -> str:
        return f"extract {self.field_name} from {self.filename}"


@dataclass(frozen=True)
class GroundingCase:
    question: str
    # None means the correct behaviour is to refuse.
    expected_substring: str | None
    note: str = ""

    @property
    def name(self) -> str:
        return f"ask {self.question[:52]}"

    @property
    def expects_refusal(self) -> bool:
        return self.expected_substring is None


CLASSIFICATION_CASES = [
    ClassificationCase("offer_letter_amelia_hart.txt", frozenset({"offer_letter"})),
    ClassificationCase("invoice_northgate_4820.txt", frozenset({"invoice"})),
    ClassificationCase("medical_note_ravi_shah.txt", frozenset({"medical_note"})),
    ClassificationCase("discharge_summary_tomas_berg.txt", frozenset({"medical_note"})),
    ClassificationCase("driving_licence_elise_marchetti.txt", frozenset({"id_document"})),
    ClassificationCase("nda_pinegrove_halden.txt", frozenset({"contract"})),
    ClassificationCase(
        "letter_of_intent_calder.txt",
        frozenset({"contract", "offer_letter"}),
        note="deliberately ambiguous: a non-binding offer of engagement with "
        "one binding clause",
    ),
]

EXTRACTION_CASES = [
    ExtractionCase("invoice_northgate_4820.txt", "reference", "INV-2026-0412"),
    ExtractionCase("invoice_northgate_4820.txt", "amount", "4,820"),
    ExtractionCase("offer_letter_amelia_hart.txt", "person_name", "Amelia Hart"),
    ExtractionCase("offer_letter_amelia_hart.txt", "amount", "78,500"),
    ExtractionCase("contract_msa_brightwater.txt", "reference", "MSA-BW-2026-014"),
    ExtractionCase("medical_note_ravi_shah.txt", "person_name", "Ravi Shah"),
]

GROUNDING_CASES = [
    GroundingCase(
        "What is the total due on invoice INV-2026-0412?",
        "4,820",
    ),
    GroundingCase(
        "What is the hourly rate in the agreement that invoice INV-BW-2291 "
        "was issued against?",
        "145",
        note="requires two documents: the invoice names the agreement, the "
        "agreement holds the rate",
    ),
    GroundingCase(
        "What medication was Ravi Shah started on?",
        "beclometasone",
    ),
    GroundingCase(
        "What is Amelia Hart's home address?",
        None,
        note="the corpus holds a different person's address - the tempting "
        "wrong answer is right there in the retrieved context",
    ),
    GroundingCase(
        "Who is the chief executive of Northgate Supplies?",
        None,
    ),
    GroundingCase(
        "What is the late payment penalty on invoice INV-2026-0412?",
        None,
    ),
]


def total_cases() -> int:
    return len(CLASSIFICATION_CASES) + len(EXTRACTION_CASES) + len(GROUNDING_CASES)
