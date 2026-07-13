import type { FormField, FormSpec } from "./schemas";

/**
 * Pure template functions over a FormSpec. No LLM calls — export must be
 * instant and always match exactly what's on screen, since it's rendered
 * from the same data as the live preview.
 */

// ---------------------------------------------------------------------------
// JSX export
// ---------------------------------------------------------------------------

const JSX_INPUT_CLASS =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const JSX_LABEL_CLASS = "block text-sm font-medium text-gray-700";
const JSX_HELP_CLASS = "mt-1 text-xs text-gray-500";
const JSX_GROUP_LABEL_CLASS = "flex items-center gap-2 text-sm font-normal text-gray-700";

function jsxStr(value: string | undefined): string {
  return JSON.stringify(value ?? "");
}

function jsxControl(field: FormField): string {
  const id = field.id;
  const v = field.validation;

  switch (field.type) {
    case "textarea": {
      const attrs = [
        `id="${id}"`,
        `name="${id}"`,
        field.required ? "required" : "",
        field.placeholder ? `placeholder={${jsxStr(field.placeholder)}}` : "",
        v?.minLength !== undefined ? `minLength={${v.minLength}}` : "",
        v?.maxLength !== undefined ? `maxLength={${v.maxLength}}` : "",
        "rows={4}",
        `className="${JSX_INPUT_CLASS}"`,
      ].filter(Boolean);
      return `<textarea ${attrs.join(" ")} />`;
    }

    case "select": {
      const options = (field.options ?? [])
        .map((opt) => `        <option value={${jsxStr(opt)}}>{${jsxStr(opt)}}</option>`)
        .join("\n");
      const attrs = [
        `id="${id}"`,
        `name="${id}"`,
        field.required ? "required" : "",
        `defaultValue=""`,
        `className="${JSX_INPUT_CLASS}"`,
      ].filter(Boolean);
      return `<select ${attrs.join(" ")}>\n        <option value="" disabled hidden>\n          {${jsxStr(field.placeholder ?? "Select…")}}\n        </option>\n${options}\n      </select>`;
    }

    case "multi_select": {
      const options = (field.options ?? [])
        .map((opt) => `        <option value={${jsxStr(opt)}}>{${jsxStr(opt)}}</option>`)
        .join("\n");
      const attrs = [
        `id="${id}"`,
        `name="${id}"`,
        "multiple",
        field.required ? "required" : "",
        `size={${Math.min(field.options?.length ?? 4, 5)}}`,
        `className="${JSX_INPUT_CLASS}"`,
      ].filter(Boolean);
      return `<select ${attrs.join(" ")}>\n${options}\n      </select>`;
    }

    case "radio":
      return (field.options ?? [])
        .map(
          (opt) =>
            `<label className="${JSX_GROUP_LABEL_CLASS}">\n        <input type="radio" name="${id}" value={${jsxStr(opt)}}${
              field.required ? " required" : ""
            } className="h-4 w-4" />\n        {${jsxStr(opt)}}\n      </label>`
        )
        .join("\n      ");

    case "checkbox_group":
      return (field.options ?? [])
        .map(
          (opt) =>
            `<label className="${JSX_GROUP_LABEL_CLASS}">\n        <input type="checkbox" name="${id}" value={${jsxStr(
              opt
            )}} className="h-4 w-4" />\n        {${jsxStr(opt)}}\n      </label>`
        )
        .join("\n      ");

    case "checkbox":
      return `<label className="${JSX_GROUP_LABEL_CLASS}">\n        <input id="${id}" type="checkbox" name="${id}"${
        field.required ? " required" : ""
      } className="h-4 w-4" />\n        {${jsxStr(field.label + (field.required ? " *" : ""))}}\n      </label>`;

    case "switch":
      return `<label className="${JSX_GROUP_LABEL_CLASS}">\n        <input id="${id}" type="checkbox" role="switch" name="${id}"${
        field.required ? " required" : ""
      } className="h-4 w-4" />\n        {${jsxStr(field.label + (field.required ? " *" : ""))}}\n      </label>`;

    case "number": {
      const attrs = [
        `id="${id}"`,
        `name="${id}"`,
        `type="number"`,
        field.required ? "required" : "",
        field.placeholder ? `placeholder={${jsxStr(field.placeholder)}}` : "",
        v?.min !== undefined ? `min={${v.min}}` : "",
        v?.max !== undefined ? `max={${v.max}}` : "",
        `className="${JSX_INPUT_CLASS}"`,
      ].filter(Boolean);
      return `<input ${attrs.join(" ")} />`;
    }

    case "date": {
      const attrs = [
        `id="${id}"`,
        `name="${id}"`,
        `type="date"`,
        field.required ? "required" : "",
        `className="${JSX_INPUT_CLASS}"`,
      ].filter(Boolean);
      return `<input ${attrs.join(" ")} />`;
    }

    // text, email, tel, url, password
    default: {
      const attrs = [
        `id="${id}"`,
        `name="${id}"`,
        `type="${field.type}"`,
        field.required ? "required" : "",
        field.placeholder ? `placeholder={${jsxStr(field.placeholder)}}` : "",
        v?.minLength !== undefined ? `minLength={${v.minLength}}` : "",
        v?.maxLength !== undefined ? `maxLength={${v.maxLength}}` : "",
        v?.pattern ? `pattern={${jsxStr(v.pattern)}}` : "",
        v?.patternDescription ? `title={${jsxStr(v.patternDescription)}}` : "",
        `className="${JSX_INPUT_CLASS}"`,
      ].filter(Boolean);
      return `<input ${attrs.join(" ")} />`;
    }
  }
}

const jsxInlineLabelTypes = new Set<FormField["type"]>(["checkbox", "switch"]);

function jsxField(field: FormField): string {
  const control = jsxControl(field);
  const help = field.helpText
    ? `\n      <p className="${JSX_HELP_CLASS}">{${jsxStr(field.helpText)}}</p>`
    : "";

  if (jsxInlineLabelTypes.has(field.type)) {
    return `    <div className="flex flex-col gap-1.5">\n      ${control}${help}\n    </div>`;
  }

  const labelText = field.label + (field.required ? " *" : "");
  const label = `<label htmlFor="${field.id}" className="${JSX_LABEL_CLASS}">{${jsxStr(labelText)}}</label>`;
  return `    <div className="flex flex-col gap-1.5">\n      ${label}\n      ${control}${help}\n    </div>`;
}

export function exportAsJSX(spec: FormSpec): string {
  const fieldsJsx = spec.fields.map(jsxField).join("\n\n");
  const descriptionJsx = spec.description
    ? `\n        <p className="text-sm text-gray-500">{${jsxStr(spec.description)}}</p>`
    : "";

  return `"use client";

import { useState, type FormEvent } from "react";

export default function GeneratedForm() {
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    console.log(Object.fromEntries(formData.entries()));
    setSubmitted(true);
  }

  if (submitted) {
    return <p className="text-sm text-gray-700">Thanks — your submission was received.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">{${jsxStr(spec.title)}}</h2>${descriptionJsx}
      </div>

${fieldsJsx}

      <button
        type="submit"
        className="self-start rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        {${jsxStr(spec.submitLabel)}}
      </button>
    </form>
  );
}
`;
}

// ---------------------------------------------------------------------------
// HTML export
// ---------------------------------------------------------------------------

function escapeHtml(value: string | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlAttrs(attrs: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== false && value !== "")
    .map(([key, value]) => (value === true ? key : `${key}="${escapeHtml(String(value))}"`))
    .join(" ");
}

function htmlControl(field: FormField): string {
  const id = field.id;
  const v = field.validation;

  switch (field.type) {
    case "textarea":
      return `<textarea ${htmlAttrs({
        id,
        name: id,
        required: field.required,
        placeholder: field.placeholder,
        minlength: v?.minLength,
        maxlength: v?.maxLength,
        rows: 4,
      })}></textarea>`;

    case "select": {
      const options = (field.options ?? [])
        .map((opt) => `    <option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
        .join("\n");
      return `<select ${htmlAttrs({ id, name: id, required: field.required })}>\n    <option value="" disabled selected hidden>${escapeHtml(
        field.placeholder ?? "Select…"
      )}</option>\n${options}\n  </select>`;
    }

    case "multi_select": {
      const options = (field.options ?? [])
        .map((opt) => `    <option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
        .join("\n");
      return `<select ${htmlAttrs({
        id,
        name: id,
        multiple: true,
        required: field.required,
        size: Math.min(field.options?.length ?? 4, 5),
      })}>\n${options}\n  </select>`;
    }

    case "radio":
      return `<fieldset class="radio-group">\n    <legend>${escapeHtml(field.label)}</legend>\n${(field.options ?? [])
        .map(
          (opt) =>
            `    <label><input type="radio" ${htmlAttrs({
              name: id,
              value: opt,
              required: field.required,
            })} /> ${escapeHtml(opt)}</label>`
        )
        .join("\n")}\n  </fieldset>`;

    case "checkbox_group":
      return `<fieldset class="checkbox-group">\n    <legend>${escapeHtml(field.label)}</legend>\n${(field.options ?? [])
        .map(
          (opt) =>
            `    <label><input type="checkbox" ${htmlAttrs({ name: id, value: opt })} /> ${escapeHtml(opt)}</label>`
        )
        .join("\n")}\n  </fieldset>`;

    case "checkbox":
      return `<label class="inline-label"><input type="checkbox" ${htmlAttrs({
        id,
        name: id,
        required: field.required,
      })} /> ${escapeHtml(field.label)}${field.required ? " *" : ""}</label>`;

    case "switch":
      return `<label class="inline-label"><input type="checkbox" role="switch" ${htmlAttrs({
        id,
        name: id,
        required: field.required,
      })} /> ${escapeHtml(field.label)}${field.required ? " *" : ""}</label>`;

    case "number":
      return `<input ${htmlAttrs({
        id,
        name: id,
        type: "number",
        required: field.required,
        placeholder: field.placeholder,
        min: v?.min,
        max: v?.max,
      })} />`;

    case "date":
      return `<input ${htmlAttrs({ id, name: id, type: "date", required: field.required })} />`;

    // text, email, tel, url, password
    default:
      return `<input ${htmlAttrs({
        id,
        name: id,
        type: field.type,
        required: field.required,
        placeholder: field.placeholder,
        minlength: v?.minLength,
        maxlength: v?.maxLength,
        pattern: v?.pattern,
        title: v?.patternDescription,
      })} />`;
  }
}

const htmlNoOwnLabelTypes = new Set<FormField["type"]>(["checkbox", "switch", "radio", "checkbox_group"]);

function htmlField(field: FormField): string {
  const control = htmlControl(field);
  const help = field.helpText ? `\n    <p class="help">${escapeHtml(field.helpText)}</p>` : "";

  if (htmlNoOwnLabelTypes.has(field.type)) {
    return `  <div class="field">\n    ${control}${help}\n  </div>`;
  }

  const labelText = escapeHtml(field.label) + (field.required ? " *" : "");
  return `  <div class="field">\n    <label for="${field.id}">${labelText}</label>\n    ${control}${help}\n  </div>`;
}

export function exportAsHTML(spec: FormSpec): string {
  const fieldsHtml = spec.fields.map(htmlField).join("\n");
  const descriptionHtml = spec.description ? `\n    <p class="description">${escapeHtml(spec.description)}</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(spec.title)}</title>
  <style>
    :root {
      color-scheme: light;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 32rem;
      margin: 2rem auto;
      padding: 0 1rem;
      color: #111;
      background: #fff;
    }
    .description {
      color: #555;
      font-size: 0.9rem;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      margin-top: 1.5rem;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    label {
      font-size: 0.875rem;
      font-weight: 600;
    }
    input,
    select,
    textarea {
      font: inherit;
      font-size: 0.875rem;
      padding: 0.5rem 0.625rem;
      border: 1px solid #ccc;
      box-sizing: border-box;
    }
    fieldset {
      border: 1px solid #ccc;
      padding: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    legend {
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0 0.25rem;
    }
    .radio-group label,
    .checkbox-group label,
    .inline-label {
      font-weight: normal;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .help {
      font-size: 0.75rem;
      color: #666;
    }
    button[type="submit"] {
      align-self: flex-start;
      background: #2563eb;
      color: #fff;
      border: none;
      padding: 0.6rem 1.25rem;
      font-size: 0.875rem;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(spec.title)}</h1>${descriptionHtml}
  <form>
${fieldsHtml}
    <button type="submit">${escapeHtml(spec.submitLabel)}</button>
  </form>
</body>
</html>
`;
}
