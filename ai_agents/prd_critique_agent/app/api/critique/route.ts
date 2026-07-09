import { generateStructured } from "@/lib/llm-provider";
import { critiqueSchema, type Critique, type Prd } from "@/lib/schemas";
import { CRITIQUE_SYSTEM, critiqueUserPrompt } from "@/lib/prompts";
import { errorMessage } from "@/lib/route-helpers";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const prd = body?.prd as Prd | undefined;

    if (!prd || typeof prd !== "object" || !prd.title) {
      return Response.json(
        { error: "A draft PRD is required to critique." },
        { status: 400 }
      );
    }

    const critique = await generateStructured<Critique>({
      systemPrompt: CRITIQUE_SYSTEM,
      userPrompt: critiqueUserPrompt(prd),
      schema: critiqueSchema,
    });

    return Response.json({ critique });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
