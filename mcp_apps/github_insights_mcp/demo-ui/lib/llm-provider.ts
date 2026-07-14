import Anthropic from "@anthropic-ai/sdk";

/**
 * A single, provider-agnostic entry point for running one turn of a
 * tool-calling chat loop. Everything else in the app calls
 * generateChatTurn() — nothing outside this file knows whether it's
 * talking to a local Ollama model or the Claude API.
 *
 * Switch providers with the LLM_PROVIDER env var: "ollama" | "anthropic".
 * The actual multi-turn loop (calling MCP tools, feeding results back)
 * lives in app/api/chat/route.ts — this file only knows how to make one
 * provider call and normalize the response.
 */

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | {
      role: "tool_results";
      results: { toolCallId: string; toolName: string; content: string; isError: boolean }[];
    };

export type NormalizedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AssistantTurn = { role: "assistant"; content: string; toolCalls?: ToolCall[] };

export type GenerateChatTurnArgs = {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: NormalizedTool[];
};

export async function generateChatTurn(args: GenerateChatTurnArgs): Promise<AssistantTurn> {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  return provider === "ollama" ? generateWithOllama(args) : generateWithAnthropic(args);
}

// ---------------------------------------------------------------------------
// Ollama (local dev only)
// ---------------------------------------------------------------------------

async function generateWithOllama({ systemPrompt, messages, tools }: GenerateChatTurnArgs): Promise<AssistantTurn> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "gemma3:12b";

  const ollamaMessages = [
    { role: "system", content: systemPrompt },
    ...messages.flatMap((msg) => toOllamaMessages(msg)),
  ];

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: ollamaMessages,
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      stream: false,
      options: {
        // Tool results (repo trees, file contents) can be large; give the
        // model real context headroom rather than the small default.
        num_ctx: 16384,
        num_predict: 2048,
        temperature: 0.3,
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
  const message = data?.message ?? {};
  const rawToolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> =
    message.tool_calls ?? [];

  const toolCalls: ToolCall[] = rawToolCalls.map((tc, i) => ({
    id: `ollama-call-${Date.now()}-${i}`,
    name: tc.function.name,
    args: tc.function.arguments ?? {},
  }));

  return {
    role: "assistant",
    content: message.content ?? "",
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function toOllamaMessages(msg: ChatMessage): Array<{ role: string; content: string; tool_calls?: unknown }> {
  if (msg.role === "user") {
    return [{ role: "user", content: msg.content }];
  }
  if (msg.role === "assistant") {
    return [
      {
        role: "assistant",
        content: msg.content,
        ...(msg.toolCalls
          ? {
              tool_calls: msg.toolCalls.map((tc) => ({
                function: { name: tc.name, arguments: tc.args },
              })),
            }
          : {}),
      },
    ];
  }
  // tool_results: Ollama expects one "tool" role message per result.
  return msg.results.map((r) => ({ role: "tool", content: r.content }));
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

function isSonnetModel(model: string): boolean {
  return model.toLowerCase().includes("sonnet");
}

async function generateWithAnthropic({ systemPrompt, messages, tools }: GenerateChatTurnArgs): Promise<AssistantTurn> {
  const client = getAnthropicClient();
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

  const anthropicMessages: Anthropic.MessageParam[] = messages.map((msg) => {
    if (msg.role === "user") {
      return { role: "user", content: msg.content };
    }
    if (msg.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const tc of msg.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      }
      return { role: "assistant", content: blocks };
    }
    // tool_results -> one user message with all tool_result blocks, which
    // is the shape Claude expects immediately following a tool_use turn.
    return {
      role: "user",
      content: msg.results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolCallId,
        content: r.content,
        is_error: r.isError,
      })),
    };
  });

  const createParams: Anthropic.MessageCreateParams = {
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: anthropicMessages,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    })),
  };

  // Claude Sonnet models run with adaptive thinking on by default, and
  // max_tokens caps thinking + response text COMBINED — an unbudgeted
  // thinking pass has previously eaten the token budget meant for tool-call
  // output in this repo's other projects (see prd_critique_agent). We don't
  // need hidden reasoning for a tool-calling loop, so turn it off.
  if (isSonnetModel(model)) {
    createParams.thinking = { type: "disabled" };
  }

  const response = await client.messages.create(createParams);

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to generate a response for this input.");
  }

  const textParts = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolCalls: ToolCall[] = response.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, args: block.input as Record<string, unknown> }));

  return {
    role: "assistant",
    content: textParts,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}
