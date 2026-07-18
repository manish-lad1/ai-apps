/**
 * A single, provider-agnostic entry point for text generation. Everything else
 * in the app calls generateText() — nothing outside this file knows whether
 * it's talking to a local Ollama model or the Claude API.
 *
 * Switch providers with the LLM_PROVIDER env var: "ollama" | "anthropic".
 *
 * This mirrors the pattern from prd_critique_agent's llm-provider.ts, but for a
 * RAG answer we want grounded *prose* with citations, not schema-constrained
 * JSON — so this returns a plain string rather than parsed structured output.
 * (Kept as a local copy per the "each project self-contained" convention — we
 * don't import across project folders.)
 */

import Anthropic from "@anthropic-ai/sdk";

export type GenerateTextArgs = {
  systemPrompt: string;
  userPrompt: string;
};

export function getLlmProvider(): "ollama" | "anthropic" {
  return process.env.LLM_PROVIDER === "ollama" ? "ollama" : "anthropic";
}

export async function generateText(args: GenerateTextArgs): Promise<string> {
  return getLlmProvider() === "ollama"
    ? generateWithOllama(args)
    : generateWithAnthropic(args);
}

// ---------------------------------------------------------------------------
// Ollama (local dev)
// ---------------------------------------------------------------------------

async function generateWithOllama({
  systemPrompt,
  userPrompt,
}: GenerateTextArgs): Promise<string> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "gemma4:12b";

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
      // Turn off "thinking" for reasoning-capable local models (e.g. gemma4).
      // With it on, the model can spend its whole num_predict budget on hidden
      // reasoning and return an EMPTY answer on longer retrieved contexts — the
      // same thinking-vs-output-budget failure documented in prd_critique_agent.
      // Ollama ignores this field for models without a thinking mode.
      think: false,
      options: {
        // Retrieved context can be several chunks long; give the context window
        // real headroom so the prompt isn't silently truncated.
        num_ctx: 16384,
        num_predict: 1536,
        // Low temperature keeps the answer close to the retrieved sources rather
        // than inviting the model to embellish from general knowledge.
        temperature: 0.2,
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
  return (data?.message?.content ?? "").trim();
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
        "ANTHROPIC_API_KEY is not set. Add it to .env.local (or set LLM_PROVIDER=ollama for local dev)."
      );
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

async function generateWithAnthropic({
  systemPrompt,
  userPrompt,
}: GenerateTextArgs): Promise<string> {
  const client = getAnthropicClient();
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

  const response = await client.messages.create({
    model,
    // We don't need hidden reasoning for a grounded-answer task, and adaptive
    // thinking (on by default) would eat into the max_tokens budget meant for
    // the answer — same failure mode documented in prd_critique_agent. Off.
    thinking: { type: "disabled" },
    max_tokens: 1536,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to generate a response for this input.");
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Expected a text block in Claude's response but found none.");
  }
  return textBlock.text.trim();
}
