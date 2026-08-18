import type { InfoRequestField } from "../types";

export type FieldValue = string | string[] | boolean;

/**
 * One input for one structured question.
 *
 * This used to be an if/else chain duplicated verbatim in the chat form and
 * the workspace Questions tab, and the two copies had already drifted — one
 * controlled, one uncontrolled, one rendering group headers and one silently
 * ignoring them. Having a single implementation is what makes it safe to add
 * richer input types without doing the work twice and getting it slightly
 * different both times.
 */
export function InfoFieldInput({
  field,
  id,
  value,
  onChange,
}: {
  field: InfoRequestField;
  id: string;
  value: FieldValue | undefined;
  onChange: (value: FieldValue) => void;
}) {
  const str = typeof value === "string" ? value : "";
  const list = Array.isArray(value) ? value : [];

  switch (field.inputType) {
    case "textarea":
      return (
        <textarea
          id={id}
          rows={3}
          placeholder={field.placeholder}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case "choice":
      return (
        <select id={id} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(field.choices ?? []).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      );

    case "boolean":
      return (
        <select
          id={id}
          value={value === true ? "yes" : value === false ? "no" : ""}
          onChange={(e) => onChange(e.target.value === "yes")}
        >
          <option value="">Choose…</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );

    case "radio": {
      // A fieldset rather than a bare div of inputs: without it, screen readers
      // announce five unrelated radios instead of one labelled question.
      return (
        <fieldset className="info-choices" id={id}>
          <legend className="sr-only">{field.label}</legend>
          {(field.choices ?? []).map((c) => (
            <label key={c} className={`info-radio-card ${str === c ? "selected" : ""}`}>
              <input
                type="radio"
                name={id}
                value={c}
                checked={str === c}
                onChange={() => onChange(c)}
              />
              <span>{c}</span>
            </label>
          ))}
        </fieldset>
      );
    }

    case "multiselect": {
      const max = field.maxSelections ?? Infinity;
      const atCap = list.length >= max;
      return (
        <fieldset className="info-choices" id={id}>
          <legend className="sr-only">{field.label}</legend>
          {(field.choices ?? []).map((c) => {
            const on = list.includes(c);
            return (
              <label
                key={c}
                className={`info-radio-card ${on ? "selected" : ""} ${!on && atCap ? "disabled" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  // Blocking further ticks at the cap is clearer than silently
                  // dropping the earliest choice the user made.
                  disabled={!on && atCap}
                  onChange={() => onChange(on ? list.filter((v) => v !== c) : [...list, c])}
                />
                <span>{c}</span>
              </label>
            );
          })}
          {field.maxSelections && (
            <p className="faint" style={{ margin: "2px 0 0", width: "100%" }}>
              {list.length} of {field.maxSelections} selected
            </p>
          )}
        </fieldset>
      );
    }

    case "color":
      // Paired with a text input so a brand hex can be pasted rather than
      // hunted for in the OS colour picker.
      return (
        <div className="info-color-row">
          <input
            type="color"
            id={id}
            value={/^#[0-9a-f]{6}$/i.test(str) ? str : "#2f6f4e"}
            onChange={(e) => onChange(e.target.value)}
          />
          <input
            type="text"
            aria-label={`${field.label} hex value`}
            placeholder="#2f6f4e"
            value={str}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );

    case "url":
      return (
        <input
          id={id}
          type="url"
          placeholder={field.placeholder ?? "https://"}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    default:
      return (
        <input
          id={id}
          type={field.inputType === "number" ? "number" : field.inputType === "date" ? "date" : "text"}
          placeholder={field.placeholder}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Whether an answer is worth submitting (blank strings and empty lists aren't). */
export function hasAnswer(value: FieldValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  return value.trim().length > 0;
}
