import Anthropic from "@anthropic-ai/sdk";
import { isDegenerate } from "./repetition-guard";

/**
 * A single, provider-agnostic entry point for getting structured JSON out of
 * an LLM. Every agent in this pipeline calls generateStructured() — nothing
 * outside this file knows whether it's talking to a local Ollama model or the
 * Claude API.
 *
 * Switch providers with the LLM_PROVIDER env var: "ollama" | "claude".
 * ("anthropic" is accepted as an alias for "claude", matching the env var
 * value used by this repo's earlier projects.)
 */

export type GenerateStructuredArgs = {
  /** System-level instructions / persona for the call. */
  systemPrompt: string;
  /** The actual task content for this step of the pipeline. */
  userPrompt: string;
  /** JSON Schema describing the shape we require back. */
  schema: Record<string, unknown>;
  /**
   * Output budget. Report generation needs far more room than a confidence
   * assessment, and the whole point of setting it per-call is that we never
   * leave it to a silent default — see the thinking-budget note below.
   */
  maxTokens?: number;
};

type RawResult<T> = { raw: string; parsed: T };

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Appended to every system prompt. Claude Opus 5 with thinking disabled can
 * occasionally leak internal `<thinking>` tags into its visible output, and
 * the documented mitigation is a *generic* instruction — naming the tags
 * specifically measurably underperforms this phrasing.
 */
const NO_INTERNAL_TAGS =
  "Do not include internal or system XML tags in your response.";

export function activeLlmProvider(): "ollama" | "claude" {
  const raw = (process.env.LLM_PROVIDER ?? "claude").toLowerCase();
  return raw === "ollama" ? "ollama" : "claude";
}

export async function generateStructured<T>(args: GenerateStructuredArgs): Promise<T> {
  const call =
    activeLlmProvider() === "ollama" ? generateWithOllama<T> : generateWithClaude<T>;

  const withGuardrail: GenerateStructuredArgs = {
    ...args,
    systemPrompt: `${args.systemPrompt}\n\n${NO_INTERNAL_TAGS}`,
  };

  // Two real degeneration modes — token-repetition loops and near-duplicate
  // list entries — can still be perfectly valid JSON, so schema validation
  // alone won't catch them. Give it one retry before surfacing a clear error,
  // since these are often non-deterministic.
  const first = await call(withGuardrail);
  if (!isDegenerate(first.raw, first.parsed)) {
    return first.parsed;
  }

  console.warn(
    "[llm-provider] Degenerate output detected (repetition loop or duplicate entries). Retrying once…"
  );
  const second = await call(withGuardrail);
  if (!isDegenerate(second.raw, second.parsed)) {
    return second.parsed;
  }

  throw new Error(
    "The model produced repetitive/degenerate output twice in a row (a known failure mode with some local models under structured-output constraints). Try again, or switch models — see README for details."
  );
}

// ---------------------------------------------------------------------------
// Ollama (local dev only)
// ---------------------------------------------------------------------------

async function generateWithOllama<T>({
  systemPrompt,
  userPrompt,
  schema,
  maxTokens = DEFAULT_MAX_TOKENS,
}: GenerateStructuredArgs): Promise<RawResult<T>> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "gemma3:12b";

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      // Ollama takes a raw JSON Schema directly in `format` and constrains
      // generation to match it.
      format: schema,
      // Gemma-family models with a reasoning mode leak thinking tokens into
      // schema-constrained JSON, and can spend the whole output budget on
      // hidden reasoning and return empty content. Turning it off is not
      // optional here — it's the fix for a bug this repo has hit twice.
      think: false,
      options: {
        // Ollama's default context is small (~4k) and shared between the
        // prompt and the response. A research prompt carries a full page of
        // search results, which easily overruns it and truncates the JSON
        // mid-string. Give it real headroom.
        num_ctx: 16384,
        // Allow a long completion so the model can finish and close the JSON.
        // The schema keeps output structurally valid *as it generates*, but it
        // can't stop the token cap cutting generation off mid-structure.
        num_predict: maxTokens,
        // Lower temperature = steadier, more reliable structured output.
        temperature: 0.4,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Ollama request failed (${res.status}). Is "ollama serve" running and has "${model}" been pulled? ${body}`
    );
  }

  const data = await res.json();
  const content = data?.message?.content ?? "";
  try {
    return { raw: content, parsed: JSON.parse(content) as T };
  } catch {
    // If this still fires, the output was truncated or malformed. Surfacing a
    // clear message beats a raw "Unterminated string" from JSON.parse.
    throw new Error(
      `The local model returned invalid JSON (likely truncated). Try again, or raise num_ctx/num_predict in lib/llm-provider.ts. First 200 chars: ${content.slice(
        0,
        200
      )}`
    );
  }
}

// ---------------------------------------------------------------------------
// Claude (production)
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local (or your deployment's env vars)."
      );
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

export function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
}

async function generateWithClaude<T>({
  systemPrompt,
  userPrompt,
  schema,
  maxTokens = DEFAULT_MAX_TOKENS,
}: GenerateStructuredArgs): Promise<RawResult<T>> {
  const client = getAnthropicClient();
  const model = anthropicModel();

  const response = await client.messages.create({
    model,
    // max_tokens is a hard cap on thinking + response text COMBINED, and on
    // Claude Opus 5 thinking is ON by default — so an unbudgeted thinking pass
    // silently eats the budget meant for the JSON and truncates it mid-string.
    // These calls are schema-constrained extraction and synthesis with no
    // tools attached, so hidden reasoning buys us little: turn it off and give
    // the whole budget to the response. (Disabling thinking is accepted on
    // Opus 5 at effort "high" or below, which is the default.)
    thinking: { type: "disabled" },
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    // Structured Outputs: constrains Claude's response to match this JSON
    // Schema exactly, so no parsing gymnastics or retries on malformed JSON.
    output_config: {
      format: {
        type: "json_schema",
        schema,
      },
    },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to generate a response for this input.");
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Expected a text block in Claude's response but found none.");
  }

  try {
    return { raw: textBlock.text, parsed: JSON.parse(textBlock.text) as T };
  } catch {
    throw new Error(
      `Claude returned invalid JSON (stop_reason: ${response.stop_reason}). This usually means the response was ` +
        `truncated — try raising maxTokens for this call. First 200 chars: ${textBlock.text.slice(
          0,
          200
        )}`
    );
  }
}
