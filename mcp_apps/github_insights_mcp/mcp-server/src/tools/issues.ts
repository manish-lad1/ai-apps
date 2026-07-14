import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Octokit } from "octokit";
import { toToolError, toToolResult, withGitHubErrorHandling } from "../github-client.js";
import {
  getIssueDetailsShape,
  getPrDetailsShape,
  listIssuesShape,
  listPullRequestsShape,
  searchIssuesShape,
} from "../types.js";

export function registerIssueTools(server: McpServer, octokit: Octokit) {
  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "Returns a filtered list of issues (state/labels/assignee). Pull requests are excluded, even though GitHub's API mixes them into the same endpoint by default.",
      inputSchema: listIssuesShape,
    },
    async ({ owner, repo, state, labels, assignee }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const { data } = await octokit.rest.issues.listForRepo({
            owner,
            repo,
            state: state ?? "open",
            labels: labels?.join(","),
            assignee,
            per_page: 100,
          });

          const issuesOnly = data.filter((issue) => !issue.pull_request);

          return {
            total: issuesOnly.length,
            issues: issuesOnly.map((issue) => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
              assignees: issue.assignees?.map((a) => a.login) ?? [],
              comments: issue.comments,
              created_at: issue.created_at,
              updated_at: issue.updated_at,
              html_url: issue.html_url,
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
    "get_issue_details",
    {
      title: "Get issue details",
      description: "Returns a single issue's full detail plus its comment thread.",
      inputSchema: getIssueDetailsShape,
    },
    async ({ owner, repo, issue_number }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const [{ data: issue }, comments] = await Promise.all([
            octokit.rest.issues.get({ owner, repo, issue_number }),
            octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 }),
          ]);

          return {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            body: issue.body,
            labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
            assignees: issue.assignees?.map((a) => a.login) ?? [],
            author: issue.user?.login ?? null,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            html_url: issue.html_url,
            comments: comments.map((c) => ({
              author: c.user?.login ?? null,
              body: c.body ?? "",
              created_at: c.created_at,
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
    "list_pull_requests",
    {
      title: "List pull requests",
      description: "Returns a filtered PR list (state/base branch) with basic diff stats (files changed, +/- lines) for each.",
      inputSchema: listPullRequestsShape,
    },
    async ({ owner, repo, state, base }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const { data } = await octokit.rest.pulls.list({
            owner,
            repo,
            state: state ?? "open",
            base,
            per_page: 30,
          });

          // The list endpoint doesn't include diff stats, so fetch each PR's
          // detail for additions/deletions/changed_files. Bounded to one page
          // (<=30 PRs) to keep this call from fanning out unboundedly.
          const withStats = await Promise.all(
            data.map(async (pr) => {
              const { data: full } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
              return {
                number: pr.number,
                title: pr.title,
                state: pr.state,
                draft: pr.draft ?? false,
                author: pr.user?.login ?? null,
                base: pr.base.ref,
                head: pr.head.ref,
                additions: full.additions,
                deletions: full.deletions,
                changed_files: full.changed_files,
                created_at: pr.created_at,
                updated_at: pr.updated_at,
                html_url: pr.html_url,
              };
            })
          );

          return { total: withStats.length, pull_requests: withStats };
        });
        return toToolResult(result);
      } catch (err) {
        return toToolError(err);
      }
    }
  );

  server.registerTool(
    "get_pr_details",
    {
      title: "Get PR details",
      description: "Returns a single PR's full detail: files changed, review status, and comments.",
      inputSchema: getPrDetailsShape,
    },
    async ({ owner, repo, pr_number }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const [{ data: pr }, files, reviews, comments] = await Promise.all([
            octokit.rest.pulls.get({ owner, repo, pull_number: pr_number }),
            octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pr_number, per_page: 100 }),
            octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: pr_number, per_page: 100 }),
            octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: pr_number, per_page: 100 }),
          ]);

          return {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            merged: pr.merged,
            draft: pr.draft ?? false,
            body: pr.body,
            author: pr.user?.login ?? null,
            base: pr.base.ref,
            head: pr.head.ref,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            merged_at: pr.merged_at,
            html_url: pr.html_url,
            files: files.map((f) => ({
              path: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              changes: f.changes,
            })),
            reviews: reviews.map((r) => ({
              author: r.user?.login ?? null,
              state: r.state,
              submitted_at: r.submitted_at,
            })),
            comments: comments.map((c) => ({
              author: c.user?.login ?? null,
              body: c.body ?? "",
              created_at: c.created_at,
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
    "search_issues",
    {
      title: "Search issues and PRs",
      description: "Cross issue/PR search scoped to a single repo.",
      inputSchema: searchIssuesShape,
    },
    async ({ owner, repo, query }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const { data } = await octokit.rest.search.issuesAndPullRequests({
            q: `${query} repo:${owner}/${repo}`,
          });
          return {
            total_count: data.total_count,
            incomplete_results: data.incomplete_results,
            items: data.items.map((item) => ({
              number: item.number,
              title: item.title,
              state: item.state,
              is_pull_request: Boolean(item.pull_request),
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
}
