"use client";

type RepoSelectorProps = {
  repoInput: string;
  onRepoInputChange: (value: string) => void;
  githubToken: string;
  onGithubTokenChange: (value: string) => void;
  disabled?: boolean;
};

export function RepoSelector({
  repoInput,
  onRepoInputChange,
  githubToken,
  onGithubTokenChange,
  disabled,
}: RepoSelectorProps) {
  return (
    <div className="shrink-0 border-b border-line bg-card px-6 py-4 flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="repo" className="label text-muted">
          Repository
        </label>
        <input
          id="repo"
          type="text"
          value={repoInput}
          onChange={(e) => onRepoInputChange(e.target.value)}
          placeholder="manish-lad1/ai-apps"
          disabled={disabled}
          className="w-64 rounded-md border border-line-strong bg-paper px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="token" className="label text-muted">
          GitHub token{" "}
          <span className="normal-case tracking-normal font-sans text-muted/80">
            (optional — raises the rate limit, never stored)
          </span>
        </label>
        <input
          id="token"
          type="password"
          value={githubToken}
          onChange={(e) => onGithubTokenChange(e.target.value)}
          placeholder="ghp_..."
          autoComplete="off"
          disabled={disabled}
          className="w-56 rounded-md border border-line-strong bg-paper px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
        />
      </div>
    </div>
  );
}
