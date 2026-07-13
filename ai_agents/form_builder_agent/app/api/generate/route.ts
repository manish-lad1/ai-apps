import { generateStructured } from "@/lib/llm-provider";
import { formSpecSchema, withGeneratedIds, type ModelFormSpec } from "@/lib/schemas";
import { GENERATE_SYSTEM, generateUserPrompt } from "@/lib/prompts";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const description = typeof body?.description === "string" ? body.description.trim() : "";

    if (!description) {
      return Response.json({ error: "Please describe the form you want." }, { status: 400 });
    }

    const modelSpec = await generateStructured<ModelFormSpec>({
      systemPrompt: GENERATE_SYSTEM,
      userPrompt: generateUserPrompt(description),
      schema: formSpecSchema,
    });

    return Response.json({ spec: withGeneratedIds(modelSpec) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return Response.json({ error: message }, { status: 500 });
  }
}
