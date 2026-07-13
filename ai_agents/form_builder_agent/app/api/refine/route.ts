import { generateStructured } from "@/lib/llm-provider";
import {
  formSpecSchema,
  stripIds,
  withGeneratedIds,
  type FormSpec,
  type ModelFormSpec,
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

    const modelSpec = await generateStructured<ModelFormSpec>({
      systemPrompt: REFINE_SYSTEM,
      userPrompt: refineUserPrompt(stripIds(spec), instruction),
      schema: formSpecSchema,
    });

    return Response.json({ spec: withGeneratedIds(modelSpec) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return Response.json({ error: message }, { status: 500 });
  }
}
