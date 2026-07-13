"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import type { FormField, FormSpec } from "@/lib/schemas";

type FieldValue = string | string[] | boolean;

function initialValueFor(field: FormField): FieldValue {
  if (field.type === "multi_select" || field.type === "checkbox_group") return [];
  if (field.type === "checkbox" || field.type === "switch") return false;
  return "";
}

function initialValues(spec: FormSpec): Record<string, FieldValue> {
  return Object.fromEntries(spec.fields.map((field) => [field.id, initialValueFor(field)]));
}

const controlClasses =
  "w-full border-2 border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]";

function FieldLabel({ field, htmlFor }: { field: FormField; htmlFor: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-[var(--muted)]"
    >
      {field.label}
      {field.required && <span className="text-[var(--accent)]">*</span>}
      {field.inferred && (
        <span
          title="Suggested field — not explicitly requested"
          className="ml-0.5 inline-block h-1.5 w-1.5 shrink-0 bg-[var(--accent)]/40"
        />
      )}
    </label>
  );
}

function HelpText({ field }: { field: FormField }) {
  if (!field.helpText) return null;
  return <p className="text-xs text-[var(--muted)]">{field.helpText}</p>;
}

function InlineFieldText({ field }: { field: FormField }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {field.label}
      {field.required && <span className="text-[var(--accent)]">*</span>}
      {field.inferred && (
        <span
          title="Suggested field — not explicitly requested"
          className="inline-block h-1.5 w-1.5 shrink-0 bg-[var(--accent)]/40"
        />
      )}
    </span>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
}) {
  const fieldId = `field-${field.id}`;
  const validation = field.validation;

  switch (field.type) {
    case "textarea":
      return (
        <textarea
          id={fieldId}
          name={field.id}
          required={field.required}
          placeholder={field.placeholder}
          value={value as string}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          minLength={validation?.minLength}
          maxLength={validation?.maxLength}
          rows={4}
          className={controlClasses}
        />
      );

    case "select":
      return (
        <select
          id={fieldId}
          name={field.id}
          required={field.required}
          value={value as string}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
          className={controlClasses}
        >
          <option value="" disabled hidden>
            {field.placeholder ?? "Select…"}
          </option>
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );

    case "multi_select": {
      const selected = value as string[];
      return (
        <select
          id={fieldId}
          name={field.id}
          multiple
          required={field.required}
          value={selected}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            onChange(Array.from(e.target.selectedOptions, (option) => option.value))
          }
          size={Math.min(field.options?.length ?? 4, 5)}
          className={controlClasses}
        >
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    case "radio":
      return (
        <div role="radiogroup" aria-labelledby={fieldId} className="flex flex-col gap-2 pt-1">
          {field.options?.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm text-[var(--ink)]">
              <input
                type="radio"
                name={field.id}
                value={option}
                checked={value === option}
                required={field.required}
                onChange={() => onChange(option)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              {option}
            </label>
          ))}
        </div>
      );

    case "checkbox_group": {
      const selected = value as string[];
      const groupSatisfied = !field.required || selected.length > 0;
      return (
        <div className="flex flex-col gap-2 pt-1">
          {field.options?.map((option) => {
            const checked = selected.includes(option);
            return (
              <label key={option} className="flex items-center gap-2 text-sm text-[var(--ink)]">
                <input
                  type="checkbox"
                  value={option}
                  checked={checked}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    onChange(
                      e.target.checked
                        ? [...selected, option]
                        : selected.filter((item) => item !== option)
                    );
                  }}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                {option}
              </label>
            );
          })}
          {/* Native checkbox groups have no built-in "at least one checked"
              constraint. This hidden proxy input carries that requirement
              into the form's normal checkValidity()/reportValidity() flow
              instead of hand-rolling a parallel validation path. */}
          {field.required && (
            <input
              type="text"
              required
              value={groupSatisfied ? "satisfied" : ""}
              onChange={() => {}}
              aria-hidden
              tabIndex={-1}
              className="sr-only"
            />
          )}
        </div>
      );
    }

    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
          <input
            id={fieldId}
            type="checkbox"
            required={field.required}
            checked={value as boolean}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <InlineFieldText field={field} />
        </label>
      );

    case "switch":
      return (
        <label className="flex items-center gap-3 text-sm text-[var(--ink)]">
          <span className="relative inline-flex h-5 w-9 shrink-0 items-center border-2 border-[var(--line)] bg-[var(--surface)] has-[:checked]:bg-[var(--accent)]">
            <input
              id={fieldId}
              type="checkbox"
              required={field.required}
              checked={value as boolean}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
              className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
            <span className="h-3 w-3 translate-x-0.5 bg-[var(--line)] transition-transform peer-checked:translate-x-4 peer-checked:bg-[var(--accent-ink)]" />
          </span>
          <InlineFieldText field={field} />
        </label>
      );

    case "number":
      return (
        <input
          id={fieldId}
          name={field.id}
          type="number"
          required={field.required}
          placeholder={field.placeholder}
          value={value as string}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          min={validation?.min}
          max={validation?.max}
          title={validation?.patternDescription}
          className={controlClasses}
        />
      );

    case "date":
      return (
        <input
          id={fieldId}
          name={field.id}
          type="date"
          required={field.required}
          value={value as string}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          className={controlClasses}
        />
      );

    // text, email, tel, url, password
    default:
      return (
        <input
          id={fieldId}
          name={field.id}
          type={field.type}
          required={field.required}
          placeholder={field.placeholder}
          value={value as string}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          minLength={validation?.minLength}
          maxLength={validation?.maxLength}
          pattern={validation?.pattern}
          title={validation?.patternDescription}
          className={controlClasses}
        />
      );
  }
}

const inlineLabelTypes = new Set<FormField["type"]>(["checkbox", "switch"]);

export default function FormRenderer({ spec }: { spec: FormSpec }) {
  const [values, setValues] = useState<Record<string, FieldValue>>(() => initialValues(spec));
  const [submitted, setSubmitted] = useState(false);

  function setValue(id: string, value: FieldValue) {
    setValues((prev) => ({ ...prev, [id]: value }));
    setSubmitted(false);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!e.currentTarget.checkValidity()) {
      e.currentTarget.reportValidity();
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-start gap-3 border-2 border-[var(--line)] bg-[var(--surface)] p-6">
        <span className="font-mono text-xs uppercase tracking-wide text-[var(--accent)]">
          Submitted
        </span>
        <p className="text-sm text-[var(--ink)]">
          The form validated and would now be sent to a real endpoint.
        </p>
        <button
          type="button"
          onClick={() => {
            setValues(initialValues(spec));
            setSubmitted(false);
          }}
          className="border-2 border-[var(--line)] px-4 py-1.5 font-mono text-xs uppercase tracking-wide text-[var(--ink)] hover:border-[var(--accent)]"
        >
          Fill again
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate={false} className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 border-b-2 border-[var(--line)] pb-4">
        <h2 className="text-xl font-semibold text-[var(--ink)]">{spec.title}</h2>
        {spec.description && <p className="text-sm text-[var(--muted)]">{spec.description}</p>}
      </div>

      {spec.fields.map((field) => {
        const fieldId = `field-${field.id}`;
        const inline = inlineLabelTypes.has(field.type);
        return (
          <div key={field.id} className="flex flex-col gap-1.5">
            {!inline && <FieldLabel field={field} htmlFor={fieldId} />}
            <FieldControl
              field={field}
              value={values[field.id]}
              onChange={(value) => setValue(field.id, value)}
            />
            <HelpText field={field} />
          </div>
        );
      })}

      <button
        type="submit"
        className="mt-2 self-start border-2 border-[var(--line)] bg-[var(--accent)] px-6 py-2.5 font-mono text-xs uppercase tracking-wide text-[var(--accent-ink)] hover:brightness-95"
      >
        {spec.submitLabel}
      </button>
    </form>
  );
}
