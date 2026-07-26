import Anthropic from "@anthropic-ai/sdk";
import { RESULTS_PER_SEARCH } from "./config";
import { anthropicModel, getAnthropicClient } from "./llm-provider";

/**
 * A single, provider-agnostic entry point for running one web search. Research
 * agents call search() — nothing outside this file knows whether the query went
 * to Tavily's REST API or Claude's server-side web_search tool.
 *
 * Switch providers with the SEARCH_PROVIDER env var: "tavily" | "anthropic".
 *
 * This exists because a research agent that answers from model knowledge is
 * worthless: it produces confident, unfalsifiable prose with no URLs behind it.
 * Every claim in Stage 2 traces back to something this function returned.
 */

export type SearchResult = {
  title: string;
  url: string;
  /** Extracted page text. Populated by Tavily; empty on the Anthropic path. */
  snippet: string;
};

export type SearchResponse = {
  query: string;
  /**
   * The canonical URL list for this query. Both providers populate this, and
   * it is what the research agent is allowed to cite — a URL that never
   * appeared here cannot end up in a source list.
   */
  results: SearchResult[];
  /**
   * The evidence text the agent actually reasons over, assembled differently
   * per provider but serving the same role in both:
   *   - Tavily:    the extracted page content for each result, labelled by URL.
   *   - Anthropic: Claude's own read of the pages it searched, with the URLs
   *                inline. (Claude's web_search returns page content encrypted
   *                and server-side only, so there is no raw text to hand back —
   *                its written summary IS the extracted evidence.)
   * Either way it is grounded in a real search, never in training data.
   */
  digest: string;
};

export function activeSearchProvider(): "tavily" | "anthropic" {
  const raw = (process.env.SEARCH_PROVIDER ?? "anthropic").toLowerCase();
  return raw === "tavily" ? "tavily" : "anthropic";
}

export async function search(query: string): Promise<SearchResponse> {
  return activeSearchProvider() === "tavily"
    ? searchWithTavily(query)
    : searchWithAnthropic(query);
}

// ---------------------------------------------------------------------------
// Tavily (free tier — the dev path)
// ---------------------------------------------------------------------------

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
};

async function searchWithTavily(query: string): Promise<SearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY is not set. Get a free key (1,000 searches/month, no card) at https://app.tavily.com, then add it to .env.local — or set SEARCH_PROVIDER=anthropic."
    );
  }

  const depth = process.env.TAVILY_SEARCH_DEPTH === "advanced" ? "advanced" : "basic";
  // Overridable so the app can be pointed at a compatible gateway or proxy —
  // and so the pipeline can be exercised end-to-end against a local stub
  // without burning real search quota.
  const baseUrl = (process.env.TAVILY_BASE_URL ?? "https://api.tavily.com").replace(
    /\/+$/,
    ""
  );

  const res = await fetch(`${baseUrl}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: depth,
      max_results: RESULTS_PER_SEARCH,
      // We want raw evidence to reason over, not Tavily's own synthesized
      // answer — an LLM-written answer from the search provider would quietly
      // become a second, unaudited reasoning step in the pipeline.
      include_answer: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Tavily rejected the API key (${res.status}). Check TAVILY_API_KEY. ${body}`);
    }
    if (res.status === 429) {
      throw new Error(
        `Tavily rate limit / monthly quota reached (429). The free tier is 1,000 searches per month. ${body}`
      );
    }
    throw new Error(`Tavily search failed (${res.status}). ${body}`);
  }

  const data = await res.json();
  const raw: TavilyResult[] = Array.isArray(data?.results) ? data.results : [];

  const results: SearchResult[] = raw
    .filter((r): r is TavilyResult & { url: string } => typeof r.url === "string" && r.url.length > 0)
    .map((r) => ({
      title: r.title?.trim() || r.url,
      url: r.url,
      snippet: (r.content ?? "").trim(),
    }));

  const digest = results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
    .join("\n\n");

  return { query, results, digest };
}

// ---------------------------------------------------------------------------
// Anthropic web search (production path)
// ---------------------------------------------------------------------------

/**
 * The `_20260209` web search tool adds dynamic filtering (Claude filters
 * results before they reach its context) and is available on Opus 5 / 4.8 /
 * 4.7 / 4.6, Sonnet 5 / 4.6, and Fable 5. Anything older takes the basic
 * variant, which is otherwise identical from our side.
 */
function webSearchToolType(model: string): "web_search_20260209" | "web_search_20250305" {
  const m = model.toLowerCase();
  const supportsDynamicFiltering =
    m.includes("opus-5") ||
    m.includes("opus-4-8") ||
    m.includes("opus-4-7") ||
    m.includes("opus-4-6") ||
    m.includes("sonnet-5") ||
    m.includes("sonnet-4-6") ||
    m.includes("fable-5") ||
    m.includes("mythos-5");
  return supportsDynamicFiltering ? "web_search_20260209" : "web_search_20250305";
}

const SEARCH_SYSTEM_PROMPT = `You are a search executor inside a research pipeline. You are NOT the analyst.

Run web searches for the user's query and report what the sources actually say.

Rules:
- You MUST use the web_search tool. Never answer from prior knowledge.
- Report only what the retrieved pages state. Do not add your own analysis,
  opinions, or conclusions beyond what a source supports.
- For each relevant source, write a short paragraph covering what it says and
  include its full URL inline on its own line as "URL: <the url>".
- Include specific figures, dates, and named entities when the source gives
  them — downstream steps need checkable detail, not vague summary.
- If the searches turn up nothing useful, say so plainly. An honest "no usable
  sources" is a valid and useful result. Do not pad.`;

/**
 * Claude runs the search server-side, so this is one API round trip that may
 * internally involve several searches. Long server-tool turns can stop with
 * `pause_turn`; we resume by echoing the turn back, capped so a pathological
 * case can't loop forever.
 */
const MAX_PAUSE_TURN_RESUMES = 3;

async function searchWithAnthropic(query: string): Promise<SearchResponse> {
  const client = getAnthropicClient();
  const model = anthropicModel();

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Search the web for: ${query}` },
  ];

  let response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SEARCH_SYSTEM_PROMPT,
    // Thinking stays ON here (the model's default). This call attaches a tool,
    // and disabling thinking is what causes Claude to occasionally write a tool
    // call out as plain text instead of invoking it — which would silently skip
    // the search and return nothing. Low effort keeps the spend sane.
    output_config: { effort: "low" },
    tools: [
      {
        type: webSearchToolType(model),
        name: "web_search",
        max_uses: 5,
      },
    ],
    messages,
  });

  for (let resume = 0; response.stop_reason === "pause_turn"; resume++) {
    if (resume >= MAX_PAUSE_TURN_RESUMES) break;
    messages.push({ role: "assistant", content: response.content });
    response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: SEARCH_SYSTEM_PROMPT,
      output_config: { effort: "low" },
      tools: [{ type: webSearchToolType(model), name: "web_search", max_uses: 5 }],
      messages,
    });
  }

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined to run a web search for: "${query}"`);
  }

  return {
    query,
    results: extractSearchResults(response.content),
    digest: response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim(),
  };
}

/**
 * Pulls the canonical result list out of the response's web_search_tool_result
 * blocks. These are the real search hits — reading them directly means the URL
 * list is never something the model paraphrased or invented.
 *
 * A failed search comes back as a result block whose `content` is a single
 * error object rather than an array, so the shape has to be checked before
 * iterating; there is no thrown exception to catch.
 */
function extractSearchResults(content: Anthropic.ContentBlock[]): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    if (!Array.isArray(block.content)) continue; // error object, not results

    for (const item of block.content) {
      if (item.type !== "web_search_result") continue;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push({
        title: item.title || item.url,
        url: item.url,
        // Claude's web_search returns page content encrypted for server-side
        // use only — there is no plaintext to expose here. The digest carries
        // the evidence text instead.
        snippet: "",
      });
    }
  }

  return results;
}
