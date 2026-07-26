import { generateStructured } from "@/lib/llm-provider";
import { categorizeSchema, questionsSchema } from "@/lib/schemas";
import {
  CATEGORIZE_SYSTEM,
  QUESTION_GENERATOR_SYSTEM,
  categorizeUser,
  questionGeneratorUser,
} from "@/lib/prompts";
import type { Question } from "@/lib/types";

/**
 * Stage 1. Decomposes a free-text idea into the research questions worth
 * asking. The agent decides how many — this is not a fixed-count generator —
 * but the ceiling is enforced here because question count is what Stage 2's
 * cost scales with.
 */

const MAX_QUESTIONS = 12;

/** Ids are assigned here, not by the model — see the note in lib/schemas.ts. */
function makeId(index: number): string {
  return `q${index + 1}`;
}

let customCounter = 0;
function makeCustomId(): string {
  customCounter += 1;
  return `qc${customCounter}-${Date.now().toString(36)}`;
}

function normalizeCategory(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  return cleaned || "uncategorized";
}

export async function generateQuestions(idea: string): Promise<Question[]> {
  const { questions } = await generateStructured<{
    questions: { question: string; category: string }[];
  }>({
    systemPrompt: QUESTION_GENERATOR_SYSTEM,
    userPrompt: questionGeneratorUser(idea),
    schema: questionsSchema,
    maxTokens: 3072,
  });

  const cleaned = (questions ?? [])
    .filter((q) => typeof q?.question === "string" && q.question.trim().length > 0)
    .map((q) => ({
      question: q.question.trim(),
      category: normalizeCategory(q.category ?? ""),
    }));

  if (cleaned.length === 0) {
    throw new Error(
      "The model returned no usable research questions. Try rephrasing the idea with a bit more detail."
    );
  }

  if (cleaned.length > MAX_QUESTIONS) {
    console.warn(
      `[question-generator] Model returned ${cleaned.length} questions; capping at ${MAX_QUESTIONS}.`
    );
  }

  return cleaned.slice(0, MAX_QUESTIONS).map((q, i) => ({ id: makeId(i), ...q }));
}

/**
 * Used at the approval gate when the human writes their own question. The app
 * infers the category rather than asking the user to pick one, so a custom
 * question is categorised by the same logic as a generated one.
 */
export async function categorizeQuestion(question: string): Promise<Question> {
  const { category } = await generateStructured<{ category: string }>({
    systemPrompt: CATEGORIZE_SYSTEM,
    userPrompt: categorizeUser(question),
    schema: categorizeSchema,
    maxTokens: 256,
  });

  return {
    id: makeCustomId(),
    question: question.trim(),
    category: normalizeCategory(category ?? ""),
  };
}
