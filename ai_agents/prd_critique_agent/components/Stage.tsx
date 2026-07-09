type StageState = "idle" | "working" | "done";
type Accent = "draft" | "critique" | "refine";

// Full literal class strings so Tailwind's scanner keeps them.
const ACCENT: Record<
  Accent,
  { filled: string; border: string; borderSoft: string; text: string }
> = {
  draft: {
    filled: "bg-draft",
    border: "border-draft",
    borderSoft: "border-draft/30",
    text: "text-draft",
  },
  critique: {
    filled: "bg-critique",
    border: "border-critique",
    borderSoft: "border-critique/30",
    text: "text-critique",
  },
  refine: {
    filled: "bg-refine",
    border: "border-refine",
    borderSoft: "border-refine/30",
    text: "text-refine",
  },
};

export default function Stage({
  index,
  title,
  accent,
  state,
  isLast = false,
  children,
}: {
  index: string;
  title: string;
  accent: Accent;
  state: StageState;
  isLast?: boolean;
  children?: React.ReactNode;
}) {
  const a = ACCENT[accent];
  const active = state !== "idle";

  return (
    <div className="flex gap-4 sm:gap-5">
      {/* Spine rail */}
      <div className="flex flex-col items-center">
        <div
          className={[
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 font-mono text-xs font-semibold transition-colors duration-500",
            state === "done"
              ? `${a.filled} ${a.border} text-white`
              : state === "working"
                ? `${a.border} ${a.text} node-working`
                : "border-line-strong text-muted",
          ].join(" ")}
          aria-hidden
        >
          {index}
        </div>
        {!isLast && (
          <div
            className={[
              "w-0.5 flex-1 transition-colors duration-500",
              state === "done" ? a.filled : "bg-line",
            ].join(" ")}
          />
        )}
      </div>

      {/* Stage content */}
      <div className={isLast ? "flex-1 pb-2" : "flex-1 pb-8"}>
        <div className="flex items-center gap-2.5 pt-1.5">
          <h2 className={`label ${active ? a.text : "text-muted"}`}>{title}</h2>
          {state === "working" && (
            <span className="label text-muted">working…</span>
          )}
        </div>

        {state === "idle" ? (
          <p className="mt-2 text-sm text-muted/70">Waiting.</p>
        ) : state === "working" ? (
          <div className="mt-3 space-y-2">
            <div className="h-3 w-2/3 animate-pulse rounded bg-line" />
            <div className="h-3 w-full animate-pulse rounded bg-line" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-line" />
          </div>
        ) : (
          <div
            className={`stage-in mt-3 rounded-xl border bg-card p-4 sm:p-5 shadow-sm ${a.borderSoft}`}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
