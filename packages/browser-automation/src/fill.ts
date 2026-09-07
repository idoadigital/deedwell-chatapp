import type { Locator, Page } from "playwright";
import { SessionExpiredError } from "./session.js";

/**
 * Robust form filling for Google's own pages, where there is no markup
 * contract to pin to. Each field is located by several independent
 * strategies in turn — visible label, placeholder, accessible name,
 * name/id/aria-label attributes, then the first input after matching text —
 * and the result is verified by reading the value back. Every field reports
 * what happened, so the approval preview can say "filled" or "not found on
 * Google's form" per field instead of leaving a person to guess from a
 * screenshot.
 */
export type FieldStatus = "filled" | "not_found" | "empty" | "unverified";

export interface FieldResult {
  key: string;
  label: string;
  status: FieldStatus;
  strategy?: string;
  note?: string;
}

export interface FillReport {
  url: string;
  title: string;
  fields: FieldResult[];
  notes: string[];
}

export interface FieldSpec {
  key: string;
  label: string;
  /** Patterns tried against labels, placeholders, accessible names and attributes. */
  patterns: RegExp[];
  value?: string | null;
  kind?: "text" | "checkbox" | "select";
}

const SETTLE_MS = 8_000;

/** Google redirects every product surface to accounts.google.com when the
 *  session is gone — surface that as the one error the workflow parks on. */
export function assertSignedIn(page: Page): void {
  if (page.url().includes("accounts.google.com/")) throw new SessionExpiredError();
}

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: SETTLE_MS }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  const n = await locator.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 6); i++) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

/** Inputs whose name/id/aria-label/placeholder/autocomplete match. */
function byAttribute(page: Page, pattern: RegExp, kind: FieldSpec["kind"]): Locator {
  const selector = kind === "checkbox" ? "input[type=checkbox], [role=checkbox]" : kind === "select" ? "select, [role=combobox]" : "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]), textarea, [contenteditable=true], [role=textbox]";
  const source = pattern.source;
  const flags = pattern.flags;
  return page.locator(selector).filter({
    has: page.locator(":scope"),
  }).and(page.locator(`xpath=self::*[${["@name", "@id", "@aria-label", "@placeholder", "@autocomplete", "@data-name"].map((a) => `contains(translate(${a}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${simplest(source, flags)}')`).join(" or ")}]`));
}

/** XPath has no regex: use the most literal fragment of the pattern. */
function simplest(source: string, _flags: string): string {
  const literal = source.split("|")[0]!.replace(/[\\^$.*+?()[\]{}]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return literal.split(" ")[0] ?? literal;
}

async function locate(page: Page, spec: FieldSpec): Promise<{ target: Locator; strategy: string } | null> {
  const kind = spec.kind ?? "text";
  for (const pattern of spec.patterns) {
    const attempts: Array<[string, Locator]> = [
      ["label", page.getByLabel(pattern, { exact: false })],
      ...(kind === "text" ? [["placeholder", page.getByPlaceholder(pattern)] as [string, Locator]] : []),
      ["role", kind === "checkbox" ? page.getByRole("checkbox", { name: pattern }) : kind === "select" ? page.getByRole("combobox", { name: pattern }) : page.getByRole("textbox", { name: pattern })],
      ["attribute", byAttribute(page, pattern, kind)],
      ["nearby-text", page.getByText(pattern).locator(kind === "checkbox" ? "xpath=following::input[@type='checkbox'][1]" : kind === "select" ? "xpath=following::select[1]" : "xpath=following::*[self::input or self::textarea][1]")],
    ];
    for (const [strategy, locator] of attempts) {
      const target = await firstVisible(locator).catch(() => null);
      if (target) return { target, strategy: `${strategy}:${pattern.source}` };
    }
  }
  return null;
}

export async function fillField(page: Page, spec: FieldSpec): Promise<FieldResult> {
  const kind = spec.kind ?? "text";
  if (kind !== "checkbox" && !spec.value) return { key: spec.key, label: spec.label, status: "empty", note: "No value on file." };
  const found = await locate(page, spec);
  if (!found) return { key: spec.key, label: spec.label, status: "not_found", note: "No matching field on Google's page." };
  const { target, strategy } = found;
  try {
    if (kind === "checkbox") {
      await target.check({ timeout: 5_000 });
      const checked = await target.isChecked().catch(() => true);
      return { key: spec.key, label: spec.label, status: checked ? "filled" : "unverified", strategy };
    }
    if (kind === "select") {
      const value = spec.value!;
      const chosen = await target.selectOption({ label: value }).catch(async () => target.selectOption(value).catch(() => []));
      return { key: spec.key, label: spec.label, status: Array.isArray(chosen) && chosen.length ? "filled" : "unverified", strategy };
    }
    await target.click({ timeout: 5_000 }).catch(() => undefined);
    await target.fill(spec.value!, { timeout: 5_000 });
    const readBack = await target.inputValue({ timeout: 2_000 }).catch(() => null);
    const ok = readBack === null ? null : readBack.trim() === spec.value!.trim();
    return { key: spec.key, label: spec.label, status: ok === false ? "unverified" : "filled", strategy, ...(ok === false ? { note: "Typed, but the field shows a different value." } : {}) };
  } catch (err) {
    return { key: spec.key, label: spec.label, status: "not_found", strategy, note: `Could not fill: ${String((err as Error).message ?? err).slice(0, 120)}` };
  }
}

export async function clickFirst(page: Page, patterns: RegExp[], roles: Array<"button" | "link"> = ["button", "link"]): Promise<boolean> {
  for (const pattern of patterns) {
    for (const role of roles) {
      const target = await firstVisible(page.getByRole(role, { name: pattern })).catch(() => null);
      if (target) {
        await target.click({ timeout: 5_000 }).catch(() => undefined);
        await settle(page);
        return true;
      }
    }
  }
  return false;
}

export async function report(page: Page, fields: FieldResult[], notes: string[] = []): Promise<FillReport> {
  return { url: page.url(), title: await page.title().catch(() => ""), fields, notes };
}
