I'm building "Form Builder Agent" — an agent that turns a plain-language description into a real, working, live-rendered form, then lets you refine it conversationally and export the code. This project lives inside a monorepo but is fully self-contained here.

## What's already built (do not change the approach in these files, only extend)

- `lib/llm-provider.ts` — provider-agnostic `generateStructured({ systemPrompt, userPrompt, schema })`, works with Ollama (local) or Claude API, switched via `LLM_PROVIDER` env var. Has a retry-once-on-degenerate-output guard built in.
- `lib/repetition-guard.ts` — detects repetitive/corrupted model output.
- `lib/schemas.ts` — the `FormSpec` / `FormField` types and JSON Schema. Read this file carefully before writing any code — a few decisions matter:
  - The model NEVER produces field `id`s. `withGeneratedIds()` attaches them deterministically (slugified label + dedup) after generation. `stripIds()` removes them before sending a spec back to the model. Always pass specs through these two functions at the right points — never let a raw model response with a stray `id` field flow through, and never send a spec with `id`s back to the model.
  - Each field has `inferred: boolean` — true if the model added it because forms of this type usually need it, false if the user explicitly asked for it. This matters for the refinement UI (see below).
- `lib/prompts.ts` — system/user prompts for generate and refine.
- `app/api/generate/route.ts` — POST `{ description: string }` → `{ spec: FormSpec }`
- `app/api/refine/route.ts` — POST `{ spec: FormSpec, instruction: string }` → `{ spec: FormSpec }`

## What I need you to build

### 1. `components/FormRenderer.tsx`
Takes a `FormSpec` and renders a real, live, working form:
- Map each `FormField.type` to a real input: text/email/tel/url/password/number → `<input type="...">`, textarea → `<textarea>`, select → `<select>`, multi_select → a multi-select control, radio → radio group, checkbox → single checkbox, checkbox_group → checkbox group, switch → a toggle.
- Apply `required`, `placeholder`, and `validation` (minLength/maxLength/min/max/pattern) as real HTML validation attributes, not just visual decoration.
- Show `helpText` below each field, small and muted.
- The form should be genuinely fillable and validate on submit (can just show a success state on valid submit — no real backend needed).
- Visually distinguish inferred fields subtly (e.g. a small dot or "suggested" label) — don't make this loud, just noticeable on close inspection.

### 2. `components/RefinementChat.tsx`
A chat-style panel:
- Text input + send button for follow-up instructions ("add a phone field", "make email required").
- Shows a running history of instructions sent (not full conversation transcript, just what the user asked for — this is a command log, not a chatbot transcript).
- Calls `/api/refine` with the current spec + instruction, replaces the spec with the response, appends to history.
- Loading state while a refine call is in flight.
- Clear error display if a call fails (reuse the error-message pattern, not a silent failure).

### 3. `lib/export.ts` — pure functions, NO LLM calls
- `exportAsJSX(spec: FormSpec): string` — generates a clean, complete, working React functional component as a string (Tailwind classes, real `<input>`/`<select>`/etc., controlled or uncontrolled is your call, but it must be code someone could paste into a real project and have it work).
- `exportAsHTML(spec: FormSpec): string` — generates plain semantic HTML with native validation attributes (required, pattern, minlength, etc.), no framework dependency.
- These are template functions over the FormSpec object. They must NOT call generateStructured or any LLM — the whole point is that export is instant and 100% consistent with what's on screen, since it's the same data.

### 4. `app/page.tsx` — wire it together
- Initial state: a text input for the first description ("describe the form you want"), an example-prompt button.
- Once a spec exists: two-panel layout — form preview on one side, refinement chat on the other. (Design this well — distinctive, not a generic AI-tool template look. Avoid the common "warm cream background + serif font + terracotta accent" AI-generated aesthetic. Pick a clear visual identity and commit to it.)
- Export buttons ("Copy as JSX", "Copy as HTML") that copy `lib/export.ts` output to the clipboard, with a brief confirmation state.
- A "start over" action that clears the spec and returns to the initial state.

## Verification before you consider this done

Run all three and fix anything they surface:
```bash
npx tsc --noEmit
npx eslint app lib components
npm run build
```

Also do a final read-through of `lib/schemas.ts` and confirm your UI code respects the `id`-handling and `inferred`-flag rules above — those are the two things most likely to get silently violated if skimmed.
