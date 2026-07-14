import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Octokit } from "octokit";
import { toToolError, toToolResult, withGitHubErrorHandling } from "../github-client.js";
import {
  getCommitActivityShape,
  getContributorStatsShape,
  getReleaseNotesDraftShape,
  summarizeChangelogShape,
} from "../types.js";

const CONVENTIONAL_COMMIT_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "revert",
] as const;

const CONVENTIONAL_COMMIT_RE = /^(\w+)(\([^)]*\))?!?:\s?/;

function commitType(message: string): string {
  const firstLine = message.split("\n")[0] ?? "";
  const match = firstLine.match(CONVENTIONAL_COMMIT_RE);
  const type = match?.[1]?.toLowerCase();
  return type && (CONVENTIONAL_COMMIT_TYPES as readonly string[]).includes(type) ? type : "other";
}

// Caps on paginated fetches so a single tool call can't run away against a
// huge repo history — generous enough for real portfolio-scale usage.
const MAX_COMMITS = 1000;
const MAX_PR_PAGES = 5;

function isoWeekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

export function registerActivityTools(server: McpServer, octokit: Octokit) {
  server.registerTool(
    "summarize_changelog",
    {
      title: "Summarize changelog",
      description:
        "Fetches commits between two refs (tags, SHAs, or branches) and returns them grouped by conventional-commit type (feat/fix/chore/docs/etc.), with an 'other' bucket for anything that doesn't match. Returns structured data, not prose.",
      inputSchema: summarizeChangelogShape,
    },
    async ({ owner, repo, from, to }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const { data } = await octokit.rest.repos.compareCommits({
            owner,
            repo,
            base: from,
            head: to,
          });

          const grouped: Record<string, Array<{ sha: string; message: string; author: string | null; date: string | null }>> =
            {};
          for (const commit of data.commits) {
            const type = commitType(commit.commit.message);
            grouped[type] ??= [];
            grouped[type].push({
              sha: commit.sha,
              message: commit.commit.message.split("\n")[0] ?? "",
              author: commit.author?.login ?? commit.commit.author?.name ?? null,
              date: commit.commit.author?.date ?? null,
            });
          }

          return {
            from,
            to,
            total_commits: data.total_commits,
            ahead_by: data.ahead_by,
            behind_by: data.behind_by,
            grouped,
          };
        });
        return toToolResult(result);
      } catch (err) {
        return toToolError(err);
      }
    }
  );

  server.registerTool(
    "get_commit_activity",
    {
      title: "Get commit activity",
      description:
        "Returns commit counts bucketed by day, by week, and by author, for charting or summarizing activity over a time window.",
      inputSchema: getCommitActivityShape,
    },
    async ({ owner, repo, since, until }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const commits: Array<{ sha: string; date: string; author: string }> = [];

          for await (const response of octokit.paginate.iterator(octokit.rest.repos.listCommits, {
            owner,
            repo,
            since,
            until,
            per_page: 100,
          })) {
            for (const commit of response.data) {
              commits.push({
                sha: commit.sha,
                date: commit.commit.author?.date ?? commit.commit.committer?.date ?? "",
                author: commit.author?.login ?? commit.commit.author?.name ?? "unknown",
              });
            }
            if (commits.length >= MAX_COMMITS) break;
          }

          const byDay: Record<string, number> = {};
          const byWeek: Record<string, number> = {};
          const byAuthor: Record<string, number> = {};

          for (const commit of commits) {
            if (!commit.date) continue;
            const day = commit.date.slice(0, 10);
            byDay[day] = (byDay[day] ?? 0) + 1;
            byWeek[isoWeekStart(new Date(commit.date))] = (byWeek[isoWeekStart(new Date(commit.date))] ?? 0) + 1;
            byAuthor[commit.author] = (byAuthor[commit.author] ?? 0) + 1;
          }

          return {
            since: since ?? null,
            until: until ?? null,
            total_commits: commits.length,
            truncated: commits.length >= MAX_COMMITS,
            by_day: byDay,
            by_week: byWeek,
            by_author: byAuthor,
          };
        });
        return toToolResult(result);
      } catch (err) {
        return toToolError(err);
      }
    }
  );

  server.registerTool(
    "get_contributor_stats",
    {
      title: "Get contributor stats",
      description: "Returns the contributor list with commit counts, via the GitHub contributors API.",
      inputSchema: getContributorStatsShape,
    },
    async ({ owner, repo }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          const contributors = await octokit.paginate(octokit.rest.repos.listContributors, {
            owner,
            repo,
            per_page: 100,
          });

          return {
            total_contributors: contributors.length,
            contributors: contributors.map((c) => ({
              login: c.login,
              contributions: c.contributions,
              html_url: c.html_url,
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
    "get_release_notes_draft",
    {
      title: "Draft release notes",
      description:
        "Returns merged PRs since a given tag (or since the latest release if omitted), grouped by label — a structured starting point for release notes, not prose.",
      inputSchema: getReleaseNotesDraftShape,
    },
    async ({ owner, repo, since_tag }) => {
      try {
        const result = await withGitHubErrorHandling(async () => {
          let sinceDate: string;
          let sinceRef: string;

          if (since_tag) {
            const { data: tagRef } = await octokit.rest.git.getRef({ owner, repo, ref: `tags/${since_tag}` });
            const commitSha = tagRef.object.sha;
            const { data: commit } = await octokit.rest.repos.getCommit({ owner, repo, ref: commitSha });
            sinceDate = commit.commit.author?.date ?? commit.commit.committer?.date ?? "";
            sinceRef = since_tag;
          } else {
            const { data: release } = await octokit.rest.repos.getLatestRelease({ owner, repo });
            sinceDate = release.published_at ?? release.created_at;
            sinceRef = release.tag_name;
          }

          const mergedPrs: Array<{
            number: number;
            title: string;
            author: string | null;
            merged_at: string;
            labels: string[];
            html_url: string;
          }> = [];

          let page = 0;
          for await (const response of octokit.paginate.iterator(octokit.rest.pulls.list, {
            owner,
            repo,
            state: "closed",
            sort: "updated",
            direction: "desc",
            per_page: 100,
          })) {
            page += 1;
            let sawBelowThreshold = false;
            for (const pr of response.data) {
              if (!pr.merged_at) continue;
              if (pr.merged_at < sinceDate) {
                sawBelowThreshold = true;
                continue;
              }
              mergedPrs.push({
                number: pr.number,
                title: pr.title,
                author: pr.user?.login ?? null,
                merged_at: pr.merged_at,
                labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
                html_url: pr.html_url,
              });
            }
            if (sawBelowThreshold || page >= MAX_PR_PAGES) break;
          }

          const grouped: Record<string, typeof mergedPrs> = {};
          for (const pr of mergedPrs) {
            const labels = pr.labels.length > 0 ? pr.labels : ["unlabeled"];
            for (const label of labels) {
              grouped[label] ??= [];
              grouped[label].push(pr);
            }
          }

          return {
            since_tag: sinceRef,
            since_date: sinceDate,
            total_merged_prs: mergedPrs.length,
            grouped_by_label: grouped,
          };
        });
        return toToolResult(result);
      } catch (err) {
        return toToolError(err);
      }
    }
  );
}
