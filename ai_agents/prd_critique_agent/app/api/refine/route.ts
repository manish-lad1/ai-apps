import { generateStructured } from "@/lib/llm-provider";
import { buildPrdSchema, type Critique, type Prd } from "@/lib/schemas";
import { REFINE_SYSTEM, refineUserPrompt } from "@/lib/prompts";
import { errorMessage, isFramework, withComputedScore } from "@/lib/route-helpers";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const prd = body?.prd as Prd | undefined;
    const critique = body?.critique as Critique | undefined;
    const framework = body?.framework;

    if (!prd || typeof prd !== "object" || !prd.title) {
      return Response.json(
        { error: "A draft PRD is required to refine." },
        { status: 400 }
      );
    }
    if (!critique || typeof critique !== "object" || !Array.isArray(critique.points)) {
      return Response.json(
        { error: "A critique is required to refine against." },
        { status: 400 }
      );
    }
    if (!isFramework(framework)) {
      return Response.json(
        { error: "framework must be 'moscow' or 'rice'." },
        { status: 400 }
      );
    }

    const refined = await generateStructured<Prd>({
      systemPrompt: REFINE_SYSTEM,
      userPrompt: refineUserPrompt(prd, critique, framework),
      schema: buildPrdSchema(framework),
    });

    return Response.json({ prd: withComputedScore(refined) });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
