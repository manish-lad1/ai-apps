import { NextResponse } from "next/server";
import { critiqueReport } from "@/agents/report-critic";
import { generateReport, reviseReport } from "@/agents/report-generator";
import { maxReportRevisionRounds } from "@/lib/config";
import {
  errorMessage,
  ndjsonStream,
  requireIdea,
  requireResearchResults,
} from "@/lib/route-helpers";
import type { CritiqueFinding, ReportEvent, ReportOutcome, ReportRound } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * Stage 3. Runs the asymmetric generator/critic loop and streams it round by
 * round, so the UI can show the critique arriving and the report being revised
 * rather than just the final artifact.
 *
 * Every round's draft AND the critique it drew is kept and returned — the
 * history is the teaching material, and a loop you can't inspect is
 * indistinguishable from a single call that took longer.
 */
export async function POST(request: Request) {
  let idea: string;
  let results;
  try {
    const body = await request.json();
    idea = requireIdea(body?.idea);
    results = requireResearchResults(body?.results);
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }

  const researchResults = results;
  const maxRounds = maxReportRevisionRounds();

  return ndjsonStream<ReportEvent>(
    async (emit) => {
      const history: ReportRound[] = [];

      emit({ type: "drafting", round: 1 });
      let report = await generateReport(idea, researchResults);
      emit({ type: "draft_done", round: 1, report });

      let outcome: ReportOutcome = "escalated";
      let outstandingObjections: CritiqueFinding[] = [];

      for (let round = 1; round <= maxRounds; round++) {
        emit({ type: "critiquing", round });
        const critique = await critiqueReport(idea, researchResults, report, round);
        emit({ type: "critique_done", round, critique });

        history.push({ round, report, critique });

        if (critique.approved) {
          outcome = "approved";
          outstandingObjections = [];
          break;
        }

        // Cap reached without approval. Escalate to the user with the report
        // and the critic's remaining objections — never silently auto-approve,
        // which would hand over a report the reviewer had actually rejected
        // while making it look signed off.
        if (round === maxRounds) {
          outcome = "escalated";
          outstandingObjections = critique.findings;
          break;
        }

        emit({ type: "drafting", round: round + 1 });
        report = await reviseReport(idea, researchResults, report, critique);
        emit({ type: "draft_done", round: round + 1, report });
      }

      emit({
        type: "complete",
        outcome,
        rounds: history,
        finalReport: report,
        outstandingObjections,
      });
    },
    (message) => ({ type: "error", message })
  );
}
