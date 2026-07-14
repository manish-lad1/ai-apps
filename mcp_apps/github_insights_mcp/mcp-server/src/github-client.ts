import { Octokit } from "octokit";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * A shaped, predictable error for anything that goes wrong talking to
 * GitHub — callers (tool handlers) turn this into a structured MCP tool
 * error instead of letting a raw Octokit exception / stack trace surface.
 */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "rate_limit" | "not_found" | "unknown",
    public readonly status?: number
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export function createGitHubClient(): Octokit {
  const token = process.env.GITHUB_TOKEN?.trim();
  // No token required to start — unauthenticated calls just get the lower
  // (60 req/hr) GitHub rate limit instead of 5,000/hr.
  return new Octokit(token ? { auth: token } : {});
}

/**
 * Wraps an Octokit call and converts its errors into a GitHubApiError with
 * a clear, caller-facing message. Every tool handler should route its
 * Octokit calls through this rather than letting exceptions propagate raw.
 */
export async function withGitHubErrorHandling<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw shapeError(err);
  }
}

function shapeError(err: unknown): GitHubApiError {
  const status = (err as { status?: number } | undefined)?.status;
  const rawMessage = err instanceof Error ? err.message : String(err);

  if (status === 403 || status === 429) {
    const headers = (err as { response?: { headers?: Record<string, string> } } | undefined)
      ?.response?.headers;
    const remaining = headers?.["x-ratelimit-remaining"];
    if (status === 429 || remaining === "0") {
      return new GitHubApiError(
        "GitHub API rate limit exceeded. Set the GITHUB_TOKEN environment variable to raise the " +
          "limit from 60 to 5,000 requests/hour, then try again.",
        "rate_limit",
        status
      );
    }
    return new GitHubApiError(`GitHub API request forbidden (403): ${rawMessage}`, "unknown", status);
  }

  if (status === 404) {
    return new GitHubApiError(
      "The requested GitHub resource was not found. Check that the owner, repo, path, or number " +
        "is correct, and that the repo is public (or GITHUB_TOKEN has access to it).",
      "not_found",
      status
    );
  }

  return new GitHubApiError(
    `GitHub API request failed${status ? ` (${status})` : ""}: ${rawMessage}`,
    "unknown",
    status
  );
}

/**
 * Converts any error (a GitHubApiError from withGitHubErrorHandling, or
 * anything else unexpected) into a valid MCP tool error result. Every tool
 * handler must go through this in its catch block — the SDK doesn't let
 * exceptions escape into a raw stack trace on the wire, but this keeps the
 * error message itself clear and structured too.
 */
export function toToolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const kind = err instanceof GitHubApiError ? err.kind : "unknown";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, kind }, null, 2),
      },
    ],
  };
}

/** Wraps a successful structured result in the shape MCP tool calls expect. */
export function toToolResult(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
