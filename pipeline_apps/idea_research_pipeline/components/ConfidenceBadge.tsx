import type { Confidence } from "@/lib/types";

const STYLES: Record<Confidence, { label: string; className: string }> = {
  high: { label: "high", className: "bg-conf-high-bg text-conf-high" },
  medium: { label: "medium", className: "bg-conf-medium-bg text-conf-medium" },
  low: { label: "low", className: "bg-conf-low-bg text-conf-low" },
  unresearched: {
    label: "unresearched",
    className: "bg-conf-none-bg text-conf-none",
  },
};

/**
 * Renders the DERIVED confidence. The tooltip carries the rule that produced
 * it, because a confidence label with no visible basis is exactly the kind of
 * unfalsifiable number this project is arguing against.
 */
export default function ConfidenceBadge({
  confidence,
  reason,
}: {
  confidence: Confidence;
  reason?: string;
}) {
  const style = STYLES[confidence] ?? STYLES.unresearched;
  return (
    <span
      title={reason}
      className={`label rounded px-1.5 py-0.5 ${style.className}`}
    >
      {style.label}
    </span>
  );
}
