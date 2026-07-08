import Anthropic from "@anthropic-ai/sdk";
import { isDegenerate } from "./repetition-guard";

/**
 * A single, provider-agnostic entry point for getting structured JSON
 * out of an LLM. Everything else in the app calls generateStructured() —
 * nothing outside this file knows whether it's talking to a local Ollama
 * model or the Claude API.
 *
 * Switch providers with the LLM_PROVIDER env var: "ollama" | "anthropic".
 */

export type GenerateStructuredArgs = {
  /** System-level instructions / persona for the call. */
  systemPrompt: string;
  /** The actual task content for this step of the loop. */
  userPrompt: string;
  /** JSON Schema describing the shape we require back. */
  schema: Record<string, unknown>;
};

type RawResult<T> = { raw: string; parsed: T };

export async function generateStructured<T>(
  args: GenerateStructuredArgs
): Promise<T> {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  const call = provider === "ollama" ? generateWithOllama<T> : generateWithAnthropic<T>;

  // Eval testing found two real degeneration modes — token-repetition loops
  // and near-duplicate list entries — that can still be perfectly valid JSON,
  // so schema validation alone won't catch them. Give it one retry before
  // surfacing a clear error, since these are often non-deterministic.
  const first = await call(args);
  if (!isDegenerate(first.raw, first.parsed)) {
    return first.parsed;
  }

  console.warn(
    "[llm-provider] Degenerate output detected (repetition loop or duplicate entries). Retrying once…"
  );
  const second = await call(args);
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
}: GenerateStructuredArgs): Promise<RawResult<T>> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "gemma4:e4b";

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
      options: {
        // Ollama's default context is small (~4k) and shared between the
        // prompt and the response. A full PRD — especially the refine step,
        // whose prompt already contains the draft + critique — easily
        // overruns it, truncating the JSON mid-string. Give it real headroom.
        num_ctx: 16384,
        // Allow a long completion so the model can finish and close the JSON.
        // The schema keeps output structurally valid *as it generates*, but it
        // can't stop the token cap from cutting generation off mid-structure —
        // so this needs to be comfortably larger than a full PRD.
        num_predict: 8192,
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
    // If this still fires, the output was truncated or malformed. Surfacing
    // a clear message beats a raw "Unterminated string" from JSON.parse.
    throw new Error(
      `The local model returned invalid JSON (likely truncated). Try again, or raise num_ctx/num_predict in lib/llm-provider.ts. First 200 chars: ${content.slice(
        0,
        200
      )}`
    );
  }
}

// ---------------------------------------------------------------------------
// Anthropic (production)
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
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

async function generateWithAnthropic<T>({
  systemPrompt,
  userPrompt,
  schema,
}: GenerateStructuredArgs): Promise<RawResult<T>> {
  const client = getAnthropicClient();
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
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

  return { raw: textBlock.text, parsed: JSON.parse(textBlock.text) as T };
}
