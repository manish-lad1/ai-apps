import type { Prd, Priority } from "@/lib/schemas";

const MOSCOW_LABEL: Record<string, string> = {
  must_have: "Must have",
  should_have: "Should have",
  could_have: "Could have",
  wont_have: "Won't have",
};

function PriorityBlock({ priority }: { priority: Priority }) {
  if (priority.framework === "moscow") {
    return (
      <div>
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-semibold text-ink">
            {MOSCOW_LABEL[priority.level] ?? priority.level}
          </span>
          <span className="label text-muted">MoSCoW</span>
        </div>
        <p className="mt-1.5 text-sm text-ink-soft leading-relaxed">
          {priority.rationale}
        </p>
      </div>
    );
  }

  const cells: Array<[string, string | number]> = [
    ["Reach", priority.reach],
    ["Impact", priority.impact],
    ["Confidence", `${priority.confidence}%`],
    ["Effort", `${priority.effort} pm`],
  ];

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="text-lg font-semibold text-ink">
          Score {priority.score}
        </span>
        <span className="label text-muted">RICE</span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-md border border-line bg-line">
        {cells.map(([k, v]) => (
          <div key={k} className="bg-card px-3 py-2">
            <div className="label text-muted">{k}</div>
            <div className="mt-0.5 text-sm font-medium text-ink">{v}</div>
          </div>
        ))}
      </div>
      <p className="mt-2.5 text-sm text-ink-soft leading-relaxed">
        {priority.rationale}
      </p>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-line pt-4">
      <h3 className="label text-muted mb-2.5">{label}</h3>
      {children}
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  if (!items?.length) {
    return <p className="text-sm text-muted italic">None specified.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-sm text-ink-soft leading-relaxed">
          <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function PrdView({ prd }: { prd: Prd }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-ink">
          {prd.title}
        </h2>
        <p className="mt-2 text-sm text-ink-soft leading-relaxed">
          {prd.problem_statement}
        </p>
      </div>

      <Section label="Goals">
        <BulletList items={prd.goals} />
      </Section>

      <Section label="Success metrics">
        <BulletList items={prd.success_metrics} />
      </Section>

      <Section label="User stories">
        <div className="space-y-3">
          {prd.user_stories.map((s, i) => (
            <div
              key={i}
              className="rounded-lg border border-line bg-paper p-3.5"
            >
              <p className="text-sm font-medium text-ink">
                <span className="text-muted">{s.persona}</span> {s.story}
              </p>
              <div className="mt-2.5">
                <div className="label text-muted mb-1.5">
                  Acceptance criteria
                </div>
                <BulletList items={s.acceptance_criteria} />
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section label="Edge cases">
        <BulletList items={prd.edge_cases} />
      </Section>

      <Section label="Open questions">
        <BulletList items={prd.open_questions} />
      </Section>

      <Section label="Priority">
        <PriorityBlock priority={prd.priority} />
      </Section>
    </div>
  );
}
