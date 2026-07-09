import { generateStructured } from "@/lib/llm-provider";
import { buildPrdSchema, type Prd } from "@/lib/schemas";
import { DRAFT_SYSTEM, draftUserPrompt } from "@/lib/prompts";
import { errorMessage, isFramework, withComputedScore } from "@/lib/route-helpers";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const idea = typeof body?.idea === "string" ? body.idea.trim() : "";
    const framework = body?.framework;

    if (!idea) {
      return Response.json(
        { error: "Please provide a feature idea." },
        { status: 400 }
      );
    }
    if (!isFramework(framework)) {
      return Response.json(
        { error: "framework must be 'moscow' or 'rice'." },
        { status: 400 }
      );
    }

    const prd = await generateStructured<Prd>({
      systemPrompt: DRAFT_SYSTEM,
      userPrompt: draftUserPrompt(idea, framework),
      schema: buildPrdSchema(framework),
    });

    return Response.json({ prd: withComputedScore(prd) });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
