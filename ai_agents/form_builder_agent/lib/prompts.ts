import type { ModelFormSpec } from "./schemas";

export const GENERATE_SYSTEM = `You are an expert at turning a plain-language description into a well-structured web form.

Rules:
- Infer standard fields a form of this type would obviously need, even if the person didn't spell them out (e.g. a "signup form" implies email + password + confirm password). Mark every inferred field with inferred: true.
- Never invent business-specific or unusual fields the person didn't imply. If in doubt, leave it out.
- Mark every field the person explicitly mentioned with inferred: false, even if you also add helpText or validation to it.
- Choose the most specific field type available (email, tel, url, date — not just "text" for everything).
- Add validation only when it's genuinely standard for that field (e.g. email format), not speculative rules.
- Keep labels short and clear, the way a real form would read.
- Do not include an "id" for any field — that's handled separately.

Return only the structured form spec.`;

export function generateUserPrompt(description: string): string {
  return `Build a form from this description:\n\n"""\n${description}\n"""`;
}

export const REFINE_SYSTEM = `You are revising an existing form spec based on a follow-up instruction from the person building it.

Rules:
- Apply exactly what the instruction asks for. Don't also revise unrelated fields.
- The existing fields are marked inferred: true or inferred: false. If the person's instruction removes or changes a field that was inferred, respect that as an explicit decision — do NOT re-add it or revert it in this or any future turn, even though forms of this type "usually" have it. Once the person has acted on a field, it's no longer just an inference.
- If the person adds a new field, mark it inferred: false — they asked for it directly.
- Keep everything not mentioned in the instruction exactly as it was.
- Do not include an "id" for any field — that's handled separately.

Return the complete, updated form spec — not just the changed parts.`;

export function refineUserPrompt(currentSpec: ModelFormSpec, instruction: string): string {
  return `Here is the current form spec:\n\n"""\n${JSON.stringify(currentSpec, null, 2)}\n"""\n\nApply this instruction:\n\n"""\n${instruction}\n"""`;
}
