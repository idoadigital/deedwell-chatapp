import type { Page } from "playwright";

/**
 * Live view + input relay for the "connect your Google account" flow. This
 * is protocol-level and page-agnostic — it streams whatever page is loaded
 * and relays whatever input arrives, with no knowledge of Google's specific
 * page structure. That's deliberate: the user is looking at and typing into
 * Google's real page, rendered pixel-for-pixel; this module never inspects
 * or parses what's being typed.
 */

export interface LiveFrame {
  /** Base64 JPEG, as delivered by CDP's Page.screencastFrame. */
  data: string;
}

export type RelayInputEvent =
  | { kind: "mouseMove"; x: number; y: number }
  | { kind: "mouseDown"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "mouseUp"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "wheel"; deltaX: number; deltaY: number }
  | { kind: "keyDown"; key: string }
  | { kind: "keyUp"; key: string }
  | { kind: "insertText"; text: string };

/** Starts streaming JPEG frames of `page` to `onFrame`. Returns a stop
 *  function that must be called before the page/context closes. */
export async function startScreencast(
  page: Page,
  onFrame: (frame: LiveFrame) => void
): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  const onScreencastFrame = async (event: { data: string; sessionId: number }) => {
    onFrame({ data: event.data });
    // Acking is required for CDP to send the next frame — an unacked
    // screencast silently stalls after the first frame.
    await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", onScreencastFrame);
  await cdp.send("Page.startScreencast", {
    format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1,
  });

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    cdp.off("Page.screencastFrame", onScreencastFrame);
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  };
}

/** Relays one real user input event into the live page. */
export async function dispatchInput(page: Page, evt: RelayInputEvent): Promise<void> {
  switch (evt.kind) {
    case "mouseMove":
      await page.mouse.move(evt.x, evt.y);
      return;
    case "mouseDown":
      await page.mouse.move(evt.x, evt.y);
      await page.mouse.down({ button: evt.button ?? "left" });
      return;
    case "mouseUp":
      await page.mouse.move(evt.x, evt.y);
      await page.mouse.up({ button: evt.button ?? "left" });
      return;
    case "wheel":
      await page.mouse.wheel(evt.deltaX, evt.deltaY);
      return;
    case "keyDown":
      await page.keyboard.down(evt.key);
      return;
    case "keyUp":
      await page.keyboard.up(evt.key);
      return;
    case "insertText":
      // Real per-character typing (rather than setting a field's value
      // directly) so it behaves exactly like the user typing their own
      // password — nothing here ever reads or logs evt.text.
      await page.keyboard.insertText(evt.text);
      return;
  }
}
