import type { Critique, CritiquePoint } from "@/lib/schemas";

const SEVERITY_STYLE: Record<
  CritiquePoint["severity"],
  { dot: string; text: string; order: number }
> = {
  high: { dot: "bg-sev-high", text: "text-sev-high", order: 0 },
  medium: { dot: "bg-sev-med", text: "text-sev-med", order: 1 },
  low: { dot: "bg-sev-low", text: "text-sev-low", order: 2 },
};

export default function CritiqueView({ critique }: { critique: Critique }) {
  const points = [...critique.points].sort(
    (a, b) => SEVERITY_STYLE[a.severity].order - SEVERITY_STYLE[b.severity].order
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft leading-relaxed border-l-2 border-critique pl-3">
        {critique.summary}
      </p>

      <ul className="space-y-2.5">
        {points.map((p, i) => {
          const style = SEVERITY_STYLE[p.severity];
          return (
            <li
              key={i}
              className="rounded-lg border border-line bg-paper p-3.5"
            >
              <div className="flex items-center gap-2.5">
                <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                <span className={`label ${style.text}`}>{p.severity}</span>
                <span className="label text-muted">· {p.section}</span>
              </div>
              <p className="mt-2 text-sm font-medium text-ink leading-relaxed">
                {p.issue}
              </p>
              <p className="mt-1.5 text-sm text-ink-soft leading-relaxed">
                <span className="label text-refine mr-1.5">Fix</span>
                {p.suggestion}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
