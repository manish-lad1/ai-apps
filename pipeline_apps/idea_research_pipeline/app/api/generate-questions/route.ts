import { NextResponse } from "next/server";
import { categorizeQuestion, generateQuestions } from "@/agents/question-generator";
import { errorMessage, requireIdea } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Stage 1, plus the categorisation half of the approval gate.
 *
 * POST { idea }             -> { questions }
 * POST { customQuestion }   -> { question }   (category inferred, same logic)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (typeof body?.customQuestion === "string") {
      const text = body.customQuestion.trim();
      if (!text) {
        return NextResponse.json({ error: "The question can't be empty." }, { status: 400 });
      }
      if (text.length > 500) {
        return NextResponse.json(
          { error: "Keep custom questions under 500 characters." },
          { status: 400 }
        );
      }
      return NextResponse.json({ question: await categorizeQuestion(text) });
    }

    const idea = requireIdea(body?.idea);
    return NextResponse.json({ questions: await generateQuestions(idea) });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}
