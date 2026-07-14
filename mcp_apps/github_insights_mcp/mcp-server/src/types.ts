import { z } from "zod";

/**
 * Every tool takes owner + repo — the server is never hardcoded to one
 * repository. These are ZodRawShapes (plain objects of Zod types), not
 * z.object() instances, because that's what McpServer.registerTool expects
 * for inputSchema.
 */
export const repoRefShape = {
  owner: z.string().min(1).describe("Repository owner (user or org), e.g. 'octokit'"),
  repo: z.string().min(1).describe("Repository name, e.g. 'octokit.js'"),
};

export const getRepoStructureShape = {
  ...repoRefShape,
  path: z
    .string()
    .optional()
    .describe("Directory path to list within the repo. Defaults to the repo root."),
  ref: z
    .string()
    .optional()
    .describe("Branch, tag, or commit SHA to read from. Defaults to the repo's default branch."),
};

export const getFileContentShape = {
  ...repoRefShape,
  path: z.string().min(1).describe("Path to the file within the repo, e.g. 'src/index.ts'."),
  ref: z
    .string()
    .optional()
    .describe("Branch, tag, or commit SHA to read from. Defaults to the repo's default branch."),
};

export const searchCodeShape = {
  ...repoRefShape,
  query: z.string().min(1).describe("Code search query, e.g. 'function getUser'."),
};

export const getReadmeShape = {
  ...repoRefShape,
  ref: z
    .string()
    .optional()
    .describe("Branch, tag, or commit SHA to read from. Defaults to the repo's default branch."),
};

export const summarizeChangelogShape = {
  ...repoRefShape,
  from: z.string().min(1).describe("Starting ref: tag, branch, or commit SHA."),
  to: z.string().min(1).describe("Ending ref: tag, branch, or commit SHA."),
};

export const getCommitActivityShape = {
  ...repoRefShape,
  since: z
    .string()
    .optional()
    .describe("ISO 8601 date-time. Only commits after this date are included."),
  until: z
    .string()
    .optional()
    .describe("ISO 8601 date-time. Only commits before this date are included."),
};

export const getContributorStatsShape = {
  ...repoRefShape,
};

export const getReleaseNotesDraftShape = {
  ...repoRefShape,
  since_tag: z
    .string()
    .optional()
    .describe("Tag to draft release notes since. Defaults to the repo's latest release."),
};

export const listIssuesShape = {
  ...repoRefShape,
  state: z.enum(["open", "closed", "all"]).optional().describe("Issue state filter. Defaults to 'open'."),
  labels: z
    .array(z.string())
    .optional()
    .describe("Only return issues with all of these labels."),
  assignee: z.string().optional().describe("Only return issues assigned to this username."),
};

export const getIssueDetailsShape = {
  ...repoRefShape,
  issue_number: z.number().int().positive().describe("The issue number."),
};

export const listPullRequestsShape = {
  ...repoRefShape,
  state: z.enum(["open", "closed", "all"]).optional().describe("PR state filter. Defaults to 'open'."),
  base: z.string().optional().describe("Only return PRs targeting this base branch."),
};

export const getPrDetailsShape = {
  ...repoRefShape,
  pr_number: z.number().int().positive().describe("The pull request number."),
};

export const searchIssuesShape = {
  ...repoRefShape,
  query: z.string().min(1).describe("Search query text, combined with repo scoping automatically."),
};
