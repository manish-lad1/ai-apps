import { generateStructured } from "@/lib/llm-provider";
import {
  refineResultSchema,
  stripIds,
  withGeneratedIds,
  type FormSpec,
  type ModelRefineResult,
} from "@/lib/schemas";
import { REFINE_SYSTEM, refineUserPrompt } from "@/lib/prompts";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const spec = body?.spec as FormSpec | undefined;
    const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";

    if (!spec || !Array.isArray(spec.fields)) {
      return Response.json({ error: "A current form spec is required." }, { status: 400 });
    }
    if (!instruction) {
      return Response.json({ error: "Please provide an instruction." }, { status: 400 });
    }

    const result = await generateStructured<ModelRefineResult>({
      systemPrompt: REFINE_SYSTEM,
      userPrompt: refineUserPrompt(stripIds(spec), instruction),
      schema: refineResultSchema,
    });

    return Response.json({ spec: withGeneratedIds(result.spec), summary: result.summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return Response.json({ error: message }, { status: 500 });
  }
}
