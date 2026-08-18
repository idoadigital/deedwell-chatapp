/**
 * Fetch-based Server-Sent-Events client. EventSource cannot send an
 * Authorization header, so tokens would leak into URLs; fetch streaming keeps
 * the token in the header where the logger redacts it.
 */

/** Pure incremental parser: feed chunks, get complete `data:` payloads back. */
export function createSSEParser(): (chunk: string) => string[] {
  let buffer = "";
  return (chunk: string): string[] => {
    buffer += chunk;
    const events: string[] = [];
    let sep: number;
    // Events are separated by a blank line.
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = rawEvent
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length) events.push(dataLines.join("\n"));
    }
    return events;
  };
}

export interface SSESubscription {
  close: () => void;
}

export function subscribeSSE(
  url: string,
  token: string,
  onEvent: (data: string) => void,
  onError?: () => void
): SSESubscription {
  const controller = new AbortController();
  void (async () => {
    try {
      const res = await fetch(url, {
        headers: { "x-deedwell-token": token },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSSEParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of parse(decoder.decode(value, { stream: true }))) {
          onEvent(data);
        }
      }
      onError?.();
    } catch {
      if (!controller.signal.aborted) onError?.();
    }
  })();
  return { close: () => controller.abort() };
}
