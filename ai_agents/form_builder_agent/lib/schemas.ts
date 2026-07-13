/**
 * Single source of truth for the form spec shape. The model never produces
 * field IDs — those are generated deterministically in code (see
 * withGeneratedIds below), the same philosophy as computing RICE scores in
 * code rather than trusting the model's arithmetic. Removes an entire class
 * of "did the model keep IDs consistent across conversation turns" bugs.
 */

export const FIELD_TYPES = [
  "text",
  "textarea",
  "email",
  "number",
  "password",
  "tel",
  "url",
  "date",
  "select",
  "multi_select",
  "radio",
  "checkbox",
  "checkbox_group",
  "switch",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldValidation = {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  patternDescription?: string;
};

/** The shape the MODEL produces — no `id`. */
export type ModelField = {
  label: string;
  type: FieldType;
  placeholder?: string;
  helpText?: string;
  required: boolean;
  options?: string[];
  validation?: FieldValidation;
  /** True if this field was inferred rather than explicitly requested — lets
   *  the refinement step tell the difference between "the user asked for
   *  this" and "I added this because forms of this type usually need it",
   *  so a deleted inferred field doesn't just get silently re-added. */
  inferred: boolean;
};

/** The shape the MODEL produces — no field-level `id`s. */
export type ModelFormSpec = {
  title: string;
  description?: string;
  submitLabel: string;
  fields: ModelField[];
};

/** A field, once IDs have been attached in code. */
export type FormField = ModelField & { id: string };

/** The final spec, once IDs have been attached in code. This is what the
 *  renderer, the chat history, and the export functions all consume. */
export type FormSpec = Omit<ModelFormSpec, "fields"> & { fields: FormField[] };

const optionTypes: FieldType[] = ["select", "multi_select", "radio", "checkbox_group"];

const modelFieldSchema = {
  type: "object",
  properties: {
    label: { type: "string", description: "The field's visible label." },
    type: { type: "string", enum: FIELD_TYPES as unknown as string[] },
    placeholder: { type: "string" },
    helpText: {
      type: "string",
      description: "Short helper text shown below the field, if useful. Omit if not needed.",
    },
    required: { type: "boolean" },
    options: {
      type: "array",
      items: { type: "string" },
      description:
        `Required and only used when type is one of: ${optionTypes.join(", ")}. Omit for all other types.`,
    },
    validation: {
      type: "object",
      properties: {
        minLength: { type: "number" },
        maxLength: { type: "number" },
        min: { type: "number" },
        max: { type: "number" },
        pattern: { type: "string", description: "A regex pattern, only if genuinely needed." },
        patternDescription: {
          type: "string",
          description: "Human-readable explanation of the pattern, e.g. 'Must be a valid US phone number'.",
        },
      },
      additionalProperties: false,
    },
    inferred: {
      type: "boolean",
      description:
        "True if you added this field because forms of this type typically need it, even though the user didn't explicitly ask for it. False if the user explicitly requested this field.",
    },
  },
  required: ["label", "type", "required", "inferred"],
  additionalProperties: false,
};

export const formSpecSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    submitLabel: { type: "string", description: "e.g. 'Sign up', 'Submit', 'Send message'." },
    fields: { type: "array", items: modelFieldSchema },
  },
  required: ["title", "submitLabel", "fields"],
  additionalProperties: false,
};

/**
 * Strips generated `id`s before sending a spec back to the model. The model
 * never produced them, so it shouldn't be asked to track or preserve them —
 * matching is done by label/position, not id, on the way back through
 * withGeneratedIds().
 */
export function stripIds(spec: FormSpec): ModelFormSpec {
  return {
    ...spec,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    fields: spec.fields.map(({ id, ...rest }) => rest),
  };
}

/**
 * Attaches a deterministic, unique `id` to every field by slugifying its
 * label, deduplicating on collision. Never delegated to the model.
 */
export function withGeneratedIds(spec: ModelFormSpec): FormSpec {
  const seen = new Map<string, number>();

  const fields: FormField[] = spec.fields.map((field) => {
    const base =
      field.label
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "field";

    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}_${count + 1}`;

    return { ...field, id };
  });

  return { ...spec, fields };
}
