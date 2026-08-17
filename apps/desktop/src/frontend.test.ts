import { describe, expect, it } from "vitest";
import { createSSEParser } from "./sse";
import { pendingGcpWork } from "./gcp-activity";
import { diffLines } from "./diff";

describe("SSE incremental parser", () => {
  it("assembles events split across arbitrary chunk boundaries", () => {
    const parse = createSSEParser();
    expect(parse('data: {"a"')).toEqual([]);
    expect(parse(':1}\n\ndata: {"b":2}\n')).toEqual(['{"a":1}']);
    expect(parse("\n")).toEqual(['{"b":2}']);
  });

  it("ignores comment/heartbeat lines and joins multi-line data", () => {
    const parse = createSSEParser();
    expect(parse(": connected\n\n")).toEqual([]);
    expect(parse("data: line1\ndata: line2\n\n")).toEqual(["line1\nline2"]);
  });
});

describe("line diff for artifact versions", () => {
  it("marks added, removed, and unchanged lines", () => {
    const out = diffLines("a\nb\nc", "a\nx\nc");
    expect(out).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });

  it("handles pure additions and empty inputs", () => {
    expect(diffLines("", "new").some((l) => l.kind === "added")).toBe(true);
    expect(diffLines("old", "old")).toEqual([{ kind: "same", text: "old" }]);
  });
});

describe("grant-platform working indicator", () => {
  const msg = (metadata: Record<string, unknown>, at = new Date().toISOString()) =>
    ({ metadata, created_at: at }) as never;

  it("shows the task's teammate while a platform task is pending", () => {
    const out = pendingGcpWork([
      msg({ gcpTasks: [{ task_id: "t1", task_type: "research", status: "queued" }] }),
    ]);
    expect(out?.label).toContain("David is researching");
  });

  it("clears when the bridge announces that task's completion", () => {
    expect(pendingGcpWork([
      msg({ gcpTasks: [{ task_id: "t1", task_type: "research", status: "queued" }] }),
      msg({ gcpTaskId: "t1" }),
    ])).toBeNull();
  });

  it("keeps showing for the newest still-pending task only", () => {
    const out = pendingGcpWork([
      msg({ gcpTasks: [{ task_id: "t1", task_type: "research", status: "queued" }] }),
      msg({ gcpTaskId: "t1" }),
      msg({ gcpTasks: [{ task_id: "t2", task_type: "document_ingestion", status: "queued" }] }),
    ]);
    expect(out?.label).toContain("Grace is processing");
  });

  it("goes quiet on stale tasks instead of claiming progress forever", () => {
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    expect(pendingGcpWork([
      msg({ gcpTasks: [{ task_id: "t1", task_type: "research", status: "queued" }] }, old),
    ])).toBeNull();
  });

  it("ignores messages without platform metadata", () => {
    expect(pendingGcpWork([msg({}), msg({ runId: "r1" })])).toBeNull();
  });
});
