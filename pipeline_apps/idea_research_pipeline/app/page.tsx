"use client";

import { useMemo, useState } from "react";
import QuestionList from "@/components/QuestionList";
import ReportView from "@/components/ReportView";
import ResearchGrid, { type ResearchRow } from "@/components/ResearchGrid";
import Stage, { type StageState } from "@/components/Stage";
import {
  MIN_APPROVED_QUESTIONS,
  type CritiqueFinding,
  type Question,
  type Report,
  type ReportEvent,
  type ReportOutcome,
  type ReportRound,
  type ResearchEvent,
  type ResearchResult,
} from "@/lib/types";

type Phase =
  | "idle"
  | "questioning"
  | "approving"
  | "researching"
  | "reporting"
  | "done";

const EXAMPLE =
  "We keep hearing from support that people lose track of which of our integrations are actually still connected and working. I want some kind of health dashboard that shows every connected integration, flags the broken ones, and maybe tells them how to fix it. Not sure if this is a real problem or just loud customers.";

/** Reads a newline-delimited JSON stream, dispatching each event as it lands. */
async function readNdjson<T>(
  response: Response,
  onEvent: (event: T) => void
): Promise<void> {
  if (!response.body) throw new Error("The server returned an empty stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Everything up to the last newline is complete; the tail may be a
    // half-delivered object, so it waits for the next chunk.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onEvent(JSON.parse(trimmed) as T);
    }
  }

  const tail = buffer.trim();
  if (tail) onEvent(JSON.parse(tail) as T);
}

export default function Home() {
  const [idea, setIdea] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const [questions, setQuestions] = useState<Question[]>([]);
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());

  const [rows, setRows] = useState<ResearchRow[]>([]);
  const [results, setResults] = useState<ResearchResult[]>([]);
  const [concurrency, setConcurrency] = useState(5);

  const [reportRounds, setReportRounds] = useState<ReportRound[]>([]);
  const [reportActivity, setReportActivity] = useState<string | null>(null);
  const [finalReport, setFinalReport] = useState<Report | null>(null);
  const [outcome, setOutcome] = useState<ReportOutcome>("approved");
  const [objections, setObjections] = useState<CritiqueFinding[]>([]);
  /**
   * Bumped every time a report finishes, and used as ReportView's `key` so a
   * re-run remounts it with a fresh editor rather than leaving edits from a
   * report that no longer exists.
   */
  const [reportRunId, setReportRunId] = useState(0);

  const approvedQuestions = useMemo(
    () => questions.filter((q) => approvedIds.has(q.id)),
    [questions, approvedIds]
  );
  const gateOpen = approvedQuestions.length >= MIN_APPROVED_QUESTIONS;
  const busy =
    phase === "questioning" || phase === "researching" || phase === "reporting";

  // -------------------------------------------------------------------------
  // Stage 1
  // -------------------------------------------------------------------------

  async function runQuestionGeneration() {
    if (!idea.trim() || busy) return;
    setError(null);
    setPhase("questioning");
    setQuestions([]);
    setApprovedIds(new Set());
    setRows([]);
    setResults([]);
    setReportRounds([]);
    setFinalReport(null);
    setObjections([]);

    try {
      const res = await fetch("/api/generate-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Question generation failed.");

      const generated: Question[] = data.questions;
      setQuestions(generated);
      // Everything starts approved — the gate is about giving the human the
      // final say, not about making them re-approve reasonable output.
      setApprovedIds(new Set(generated.map((q) => q.id)));
      setPhase("approving");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  }

  async function addCustomQuestion(text: string) {
    const res = await fetch("/api/generate-questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customQuestion: text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? "Couldn't add that question.");

    const question: Question = data.question;
    setQuestions((prev) => [...prev, question]);
    setApprovedIds((prev) => new Set(prev).add(question.id));
  }

  function toggleQuestion(id: string) {
    setApprovedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function editQuestion(id: string, text: string) {
    setQuestions((prev) =>
      prev.map((q) => (q.id === id ? { ...q, question: text } : q))
    );
  }

  function deleteQuestion(id: string) {
    setQuestions((prev) => prev.filter((q) => q.id !== id));
    setApprovedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Stage 2
  // -------------------------------------------------------------------------

  function applyResearchEvent(event: ResearchEvent) {
    if (event.type === "started") {
      setConcurrency(event.concurrency);
      return;
    }

    if (event.type === "done") {
      setResults((prev) => [...prev, event.result]);
    }

    setRows((prev) =>
      prev.map((row) => {
        if (row.question.id !== event.questionId) return row;
        switch (event.type) {
          case "round_start":
            return { ...row, round: event.round };
          case "searching":
            return {
              ...row,
              status: "searching",
              round: event.round,
              trace: [...row.trace, `→ search  "${event.query}"`],
            };
          case "search_done":
            return {
              ...row,
              trace: [
                ...row.trace,
                `  ${event.resultCount} result${event.resultCount === 1 ? "" : "s"}`,
              ],
            };
          case "assessing":
            return {
              ...row,
              status: "assessing",
              trace: [...row.trace, "⋯ assessing whether that's enough"],
            };
          case "insufficient":
            return {
              ...row,
              trace: [...row.trace, `↺ still thin — ${event.reason}`],
            };
          case "done":
            return {
              ...row,
              status: "done",
              result: event.result,
              trace: [
                ...row.trace,
                `✓ ${event.result.confidence} · ${event.result.sources.length} sources · ${event.result.roundsUsed} round(s)`,
              ],
            };
          case "error":
            return {
              ...row,
              status: "error",
              error: event.message,
              trace: [...row.trace, `✕ ${event.message}`],
            };
          default:
            return row;
        }
      })
    );
  }

  async function runResearch() {
    if (!gateOpen || busy) return;
    setError(null);
    setPhase("researching");
    setResults([]);
    setReportRounds([]);
    setFinalReport(null);
    setObjections([]);
    setRows(
      approvedQuestions.map((question) => ({
        question,
        status: "queued",
        round: 0,
        trace: [],
        result: null,
        error: null,
      }))
    );

    try {
      const res = await fetch("/api/run-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questions: approvedQuestions }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Research failed to start.");
      }

      await readNdjson<ResearchEvent>(res, (event) => {
        if (event.type === "error" && event.questionId === "*") {
          setError(event.message);
          return;
        }
        applyResearchEvent(event);
      });

      setPhase("approving");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Research failed.");
      setPhase("approving");
    }
  }

  // -------------------------------------------------------------------------
  // Stage 3
  // -------------------------------------------------------------------------

  async function runReport() {
    if (results.length === 0 || busy) return;
    setError(null);
    setPhase("reporting");
    setReportRounds([]);
    setFinalReport(null);
    setObjections([]);
    setReportActivity("Drafting the report…");

    try {
      const res = await fetch("/api/generate-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea, results }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Report generation failed to start.");
      }

      await readNdjson<ReportEvent>(res, (event) => {
        switch (event.type) {
          case "drafting":
            setReportActivity(
              event.round === 1
                ? "Drafting the report…"
                : `Revising the report (round ${event.round})…`
            );
            break;
          case "draft_done":
            setReportActivity(`Draft ${event.round} written.`);
            break;
          case "critiquing":
            setReportActivity(`Reviewing draft ${event.round} against the rubric…`);
            break;
          case "critique_done":
            setReportRounds((prev) => [
              ...prev.filter((r) => r.round !== event.round),
              {
                round: event.round,
                // Filled in by the "complete" event, which carries the paired
                // draft; this keeps the live list ordered as critiques land.
                report: prev.find((r) => r.round === event.round)?.report ?? {
                  summary: "",
                  per_question_reports: [],
                  open_contradictions: [],
                  overall_recommendation: { verdict: "go_narrower", rationale: "" },
                  sources: [],
                },
                critique: event.critique,
              },
            ]);
            setReportActivity(
              event.critique.approved
                ? `Draft ${event.round} approved.`
                : `Draft ${event.round} sent back with ${event.critique.findings.length} objection(s).`
            );
            break;
          case "complete":
            setReportRounds(event.rounds);
            setFinalReport(event.finalReport);
            setOutcome(event.outcome);
            setObjections(event.outstandingObjections);
            setReportRunId((id) => id + 1);
            setReportActivity(null);
            break;
          case "error":
            setError(event.message);
            setReportActivity(null);
            break;
        }
      });

      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report generation failed.");
      setReportActivity(null);
      setPhase("approving");
    }
  }

  // -------------------------------------------------------------------------
  // Stage states
  // -------------------------------------------------------------------------

  const questionState: StageState =
    phase === "questioning" ? "working" : questions.length > 0 ? "done" : "idle";

  const gateState: StageState =
    questions.length === 0
      ? "idle"
      : results.length > 0 || phase === "researching"
        ? "done"
        : gateOpen
          ? "working"
          : "blocked";

  const researchState: StageState =
    phase === "researching"
      ? "working"
      : results.length > 0
        ? "done"
        : "idle";

  const reportState: StageState =
    phase === "reporting" ? "working" : finalReport ? "done" : "idle";

  const started = phase !== "idle" || questions.length > 0;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-14 sm:py-20">
      <header className="max-w-2xl">
        <p className="label text-research">Research Pipeline</p>
        <h1 className="mt-3 text-3xl font-semibold leading-[1.1] tracking-tight text-ink sm:text-4xl">
          From a raw idea to a sourced go / no-go.
        </h1>
        <p className="mt-4 text-base leading-relaxed text-ink-soft">
          An idea goes in one end and a cited recommendation comes out the other,
          through four gates: questions get generated, <em>you</em> approve them,
          independent agents research each one in parallel, and a reviewer agent
          argues with the report until it holds up.
        </p>
      </header>

      {/* input */}
      <div className="mt-9 rounded-2xl border border-line bg-card p-4 shadow-sm sm:p-5">
        <label htmlFor="idea" className="label text-muted">
          The idea
        </label>
        <textarea
          id="idea"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="A rough paragraph is plenty — the kind of thing you'd bring to a product review with no data behind it yet."
          rows={4}
          disabled={busy}
          className="mt-2 w-full resize-y rounded-lg border border-line bg-paper px-3.5 py-3 text-sm text-ink outline-none placeholder:text-muted/70 focus:border-line-strong focus:ring-2 focus:ring-ink/5 disabled:opacity-60"
        />

        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          {!idea.trim() && !busy && (
            <button
              type="button"
              onClick={() => setIdea(EXAMPLE)}
              className="label text-muted transition-colors hover:text-ink"
            >
              Try an example
            </button>
          )}
          <button
            type="button"
            onClick={runQuestionGeneration}
            disabled={!idea.trim() || busy}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {phase === "questioning"
              ? "Generating…"
              : started
                ? "Start over"
                : "Generate questions"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-sev-high/30 bg-conf-low-bg px-4 py-3 text-sm text-sev-high">
          {error}
        </div>
      )}

      {started && (
        <div className="mt-12">
          <Stage
            index="01"
            title="Question generation"
            accent="ask"
            state={questionState}
            meta={
              questions.length > 0 ? (
                <span className="label text-muted">
                  {questions.length} generated
                </span>
              ) : undefined
            }
          >
            {questions.length > 0 && (
              <p className="text-sm leading-relaxed text-ink-soft">
                The agent decided this idea needed {questions.length}{" "}
                questions. It picks the count from the idea&apos;s complexity —
                there is no fixed number, and a category can legitimately come
                back empty.
              </p>
            )}
          </Stage>

          <Stage
            index="02"
            title="Your approval"
            accent="ask"
            state={gateState}
            meta={
              questions.length > 0 ? (
                <span className="label text-muted">
                  {approvedQuestions.length}/{questions.length} approved
                </span>
              ) : undefined
            }
          >
            {questions.length > 0 && (
              <>
                <QuestionList
                  questions={questions}
                  approvedIds={approvedIds}
                  disabled={busy}
                  onToggle={toggleQuestion}
                  onEdit={editQuestion}
                  onDelete={deleteQuestion}
                  onAdd={addCustomQuestion}
                />
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={runResearch}
                    disabled={!gateOpen || busy}
                    className="rounded-lg bg-research px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {phase === "researching"
                      ? "Researching…"
                      : results.length > 0
                        ? "Re-run research"
                        : `Run research on ${approvedQuestions.length} question${
                            approvedQuestions.length === 1 ? "" : "s"
                          }`}
                  </button>
                </div>
              </>
            )}
          </Stage>

          <Stage
            index="03"
            title="Parallel research"
            accent="research"
            state={researchState}
            meta={
              rows.length > 0 ? (
                <span className="label text-muted">
                  {rows.length} independent agents
                </span>
              ) : undefined
            }
          >
            {rows.length > 0 && (
              <>
                <p className="mb-3 text-sm leading-relaxed text-ink-soft">
                  One agent per question, running concurrently. None of them can
                  see each other&apos;s work — that independence is what lets
                  stage 04 catch it when two of them disagree.
                </p>
                <ResearchGrid rows={rows} concurrency={concurrency} />

                {results.length > 0 && phase !== "researching" && (
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={runReport}
                      disabled={busy}
                      className="rounded-lg bg-report px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {finalReport ? "Re-generate report" : "Generate report"}
                    </button>
                  </div>
                )}
              </>
            )}
          </Stage>

          <Stage
            index="04"
            title="Report & critique loop"
            accent="report"
            state={reportState}
            isLast
            meta={
              reportRounds.length > 0 ? (
                <span className="label text-muted">
                  {reportRounds.length} round
                  {reportRounds.length === 1 ? "" : "s"}
                </span>
              ) : undefined
            }
          >
            {reportActivity && (
              <p className="text-sm text-ink-soft">{reportActivity}</p>
            )}

            {finalReport && (
              <ReportView
                key={reportRunId}
                idea={idea}
                report={finalReport}
                outcome={outcome}
                outstandingObjections={objections}
                rounds={reportRounds}
              />
            )}
          </Stage>
        </div>
      )}

      <footer className="mt-16 border-t border-line pt-6">
        <p className="label text-muted">
          Ollama + a free search API in dev, or Claude + its web search tool in
          production. Nothing is saved — close the tab and the run is gone.
        </p>
      </footer>
    </main>
  );
}
