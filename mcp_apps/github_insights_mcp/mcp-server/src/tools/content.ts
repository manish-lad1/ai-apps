import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Octokit } from "octokit";
import { toToolError, toToolResult, withGitHubErrorHandling } from "../github-client.js";
import {
  getFileContentShape,
  getReadmeShape,
  getRepoStructureShape,
  searchCodeShape,
} from "../types.js";

const MAX_FILE_BYTES = 100 * 1024;

function decodeBase64(content: string): string {
  return Buffer.from(content, "base64").toString("utf-8");
}

export function registerContentTools(server: McpServer, octokit: Octokit) {
  server.registerTool(
    "get_repo_structure",
    {
      title: "Get repo structure",
      description:
        "Returns the file/directory tree at a given path in a repo (default: full recursive tree from the root).",
      inputSchema: getRepoStructureShape,
    },
    async ({ owner, repo, path, ref }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const resolvedRef = ref ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

          if (!path || path === "." || path === "/") {
            const { data } = await octokit.rest.git.getTree({
              owner,
              repo,
              tree_sha: resolvedRef,
              recursive: "1",
            });
            return {
              path: "/",
              ref: resolvedRef,
              truncated: data.truncated,
              entries: data.tree.map((entry) => ({
                path: entry.path,
                type: entry.type === "tree" ? "dir" : entry.type === "blob" ? "file" : entry.type,
                size: entry.size,
                sha: entry.sha,
              })),
            };
          }

          const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: resolvedRef });
          const entries = Array.isArray(data) ? data : [data];
          return {
            path,
            ref: resolvedRef,
            truncated: false,
            entries: entries.map((entry) => ({
              path: entry.path,
              type: entry.type === "dir" ? "dir" : "file",
              size: entry.size,
              sha: entry.sha,
            })),
          };
        });
        return toToolResult(result);
      } catch (err) {
        return toToolError(err);
      }
    }
  );

  server.registerTool(
    "get_file_content",
    {
      title: "Get file content",
      description: "Returns the decoded content of a single file. Files over ~100KB are rejected with a clear message rather than truncated silently.",
      inputSchema: getFileContentShape,
    },
    async ({ owner, repo, path, ref }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });

          if (Array.isArray(data)) {
            throw new Error(`"${path}" is a directory, not a file. Use get_repo_structure instead.`);
          }
          if (data.type !== "file") {
            throw new Error(`"${path}" is a ${data.type}, not a file.`);
          }
          if (data.size > MAX_FILE_BYTES) {
            return {
              path,
              size: data.size,
              truncated: true,
              content: null,
              message: `File is ${data.size} bytes, over the ${MAX_FILE_BYTES}-byte cap. Content was not returned.`,
            };
          }

          let content: string;
          if (data.content) {
            content = decodeBase64(data.content);
          } else {
            // Contents API omits `content` for some large files even under the
            // cap; fall back to the blob API using the same sha.
            const blob = await octokit.rest.git.getBlob({ owner, repo, file_sha: data.sha });
            content = decodeBase64(blob.data.content);
          }

          return {
            path,
            size: data.size,
            sha: data.sha,
            truncated: false,
            content,
          };
        });
        return toToolResult(result);
      } catch (err) {
        return toToolError(err);
      }
    }
  );

  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description: "Searches code within a single repo via the GitHub code search API.",
      inputSchema: searchCodeShape,
    },
    async ({ owner, repo, query }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const { data } = await octokit.rest.search.code({
            q: `${query} repo:${owner}/${repo}`,
          });
          return {
            total_count: data.total_count,
            incomplete_results: data.incomplete_results,
            items: data.items.map((item) => ({
              path: item.path,
              sha: item.sha,
              score: item.score,
              html_url: item.html_url,
            })),
          };
        });
        return toToolResult(result);
      } catch (err) {
        return toToolError(err);
      }
    }
  );

  server.registerTool(
    "get_readme",
    {
      title: "Get README",
      description: "Fetches and decodes a repo's README file.",
      inputSchema: getReadmeShape,
    },
    async ({ owner, repo, ref }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const { data } = await octokit.rest.repos.getReadme({ owner, repo, ref });
          return {
            path: data.path,
            sha: data.sha,
            content: decodeBase64(data.content),
          };
        });
        return toToolResult(result);
      } catch (err) {
        return toToolError(err);
      }
    }
  );
}
