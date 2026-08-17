#!/usr/bin/env node
/**
 * Live production acceptance battery for the GCP grant-platform integration.
 *
 * Drives the REAL chat API (default https://app.deedwell.org/api) as the
 * dedicated acceptance account, through the same HTTP surface the SPA uses.
 * Each stage prints PASS/FAIL/WARN lines and a final summary; agent message
 * bodies are logged so a human (or the orchestrating session) can judge the
 * non-deterministic parts. Nothing here prints the password.
 *
 * Usage:
 *   ACCEPTANCE_PW="$(...)" node scripts/acceptance/gcp-acceptance-battery.mjs \
 *     [--base https://app.deedwell.org/api] [--email gcp-acceptance@deedwell.org] \
 *     [--stages login,legacy,research,...] [--state /root/.acceptance-state.json]
 *
 * Stages (in order): login legacy research apply requirements evidence
 *                    strategy sections budget compliance package durability security
 * Async platform tasks are polled via channel messages (the bridge announces
 * completions as teammate messages tagged metadata.gcpTaskId).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const BASE = (arg("base", "https://app.deedwell.org/api")).replace(/\/$/, "");
const EMAIL = arg("email", "gcp-acceptance@deedwell.org");
const PW = process.env.ACCEPTANCE_PW;
const STATE_FILE = arg("state", ".acceptance-state.json");
const ONLY = arg("stages", "").split(",").filter(Boolean);
const RESEARCH_TIMEOUT_MS = Number(arg("research-timeout", 15 * 60 * 1000));
const TASK_TIMEOUT_MS = Number(arg("task-timeout", 10 * 60 * 1000));

if (!PW) { console.error("FATAL set ACCEPTANCE_PW (never pass the password as an argument)"); process.exit(2); }

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const results = [];
const ok = (name, detail = "") => { results.push(["PASS", name, detail]); console.log(`PASS ${name}${detail ? " :: " + detail : ""}`); };
const bad = (name, detail = "") => { results.push(["FAIL", name, detail]); console.log(`FAIL ${name}${detail ? " :: " + detail : ""}`); };
const warn = (name, detail = "") => { results.push(["WARN", name, detail]); console.log(`WARN ${name}${detail ? " :: " + detail : ""}`); };
const info = (name, detail = "") => console.log(`INFO ${name}${detail ? " :: " + detail : ""}`);
const check = (cond, name, detail = "") => (cond ? ok(name, detail) : bad(name, detail));

let token = null;
async function call(method, path, { body, tok = token, raw = false, timeoutMs = 120_000 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (raw) return res;
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const agentReplies = (r) => (r.body?.messages ?? []).filter((m) => m.author_kind === "agent");
const logReplies = (label, r) => {
  for (const m of agentReplies(r)) {
    info(`${label} reply`, `[${m.author_agent}] cap=${m.metadata?.gcpCapability ?? "-"} :: ${String(m.body).slice(0, 400).replace(/\n/g, " ⏎ ")}`);
  }
};

async function send(channelId, body, extra = {}) {
  return await call("POST", `/v1/orgs/${state.orgId}/channels/${channelId}/messages`, { body: { body, ...extra }, timeoutMs: 180_000 });
}
async function messages(channelId) {
  return await call("GET", `/v1/orgs/${state.orgId}/channels/${channelId}/messages`);
}

/** Poll a channel until a bridge announcement for task_type arrives (or any new gcpTaskId completion). */
async function waitForTask(channelId, taskTypes, timeoutMs, seenIds = new Set()) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await messages(channelId);
    const ann = (r.body?.messages ?? []).filter((m) => m.metadata?.gcpTaskId && !seenIds.has(m.id));
    for (const m of ann) {
      info("bridge announcement", `[${m.author_agent}] taskType=${m.metadata?.gcpTaskType ?? "?"} :: ${String(m.body).slice(0, 200)}`);
      if (!taskTypes || taskTypes.length === 0 || taskTypes.some((t) => String(m.metadata?.gcpTaskType ?? m.body).toLowerCase().includes(t))) {
        return m;
      }
      seenIds.add(m.id);
    }
    await sleep(10_000);
  }
  return null;
}

// ---------------------------------------------------------------------------
const stages = {};

stages.login = async () => {
  const r = await call("POST", "/v1/auth/login", { body: { email: EMAIL, password: PW }, tok: null });
  if (r.status !== 200 || !r.body?.token) return bad("login", `status ${r.status}`);
  token = r.body.token; state.userId = r.body.userId;
  ok("login");
  const me = await call("GET", "/v1/me");
  const org = (me.body?.organizations ?? []).find((o) => o.slug === "gcp-acceptance");
  if (!org) return bad("org membership", `gcp-acceptance not in ${JSON.stringify(me.body?.organizations?.map((o) => o.slug))}`);
  state.orgId = org.id; saveState();
  ok("org membership", `gcp-acceptance = ${org.id}`);

  const ws = await call("GET", `/v1/orgs/${state.orgId}/workspace`);
  check(ws.status === 200, "workspace load", `status ${ws.status}`);

  const ch = await call("GET", `/v1/orgs/${state.orgId}/channels`);
  const channels = ch.body?.channels ?? [];
  const dms = channels.filter((c) => String(c.key ?? "").startsWith("dm:"));
  check(dms.length === 13, "13 teammate DMs", `found ${dms.length}`);
  for (const key of ["dm:grant.opportunity_researcher", "dm:grant.requirements_analyst", "dm:core.executive_assistant", "dm:website.digital_strategist"]) {
    const c = channels.find((x) => x.key === key);
    check(!!c, `channel ${key}`);
    if (key === "dm:grant.opportunity_researcher" && c) { state.davidDm = c.id; }
    if (key === "dm:core.executive_assistant" && c) { state.mayaDm = c.id; }
    if (key === "dm:website.digital_strategist" && c) { state.websiteDm = c.id; }
  }
  saveState();

  // SSE: the stream must open and greet.
  try {
    const res = await call("GET", `/v1/orgs/${state.orgId}/events`, { raw: true, timeoutMs: 15_000 });
    const reader = res.body.getReader();
    const first = await Promise.race([reader.read(), sleep(8_000).then(() => null)]);
    await reader.cancel().catch(() => {});
    const text = first?.value ? new TextDecoder().decode(first.value) : "";
    check(res.status === 200 && text.includes("connected"), "SSE stream opens", `status ${res.status}`);
  } catch (e) { bad("SSE stream opens", String(e).slice(0, 120)); }

  const noauth = await call("GET", `/v1/orgs/${state.orgId}/workspace`, { tok: null });
  check(noauth.status === 401, "unauthenticated API rejected", `status ${noauth.status}`);
};

stages.legacy = async () => {
  // A non-allowlisted org must stay entirely on the local engine even with the flag on.
  if (!state.legacyOrgId) {
    const slug = "gcp-legacy-check";
    let r = await call("POST", "/v1/orgs", { body: { name: "GCP Legacy Check", slug } });
    if (r.status === 409) {
      const me = await call("GET", "/v1/me");
      state.legacyOrgId = (me.body?.organizations ?? []).find((o) => o.slug === slug)?.id;
    } else if (r.status === 201) { state.legacyOrgId = r.body.orgId; }
    saveState();
  }
  if (!state.legacyOrgId) return bad("legacy org create");
  ok("legacy org", state.legacyOrgId);

  const ch = await call("GET", `/v1/orgs/${state.legacyOrgId}/channels`);
  const dm = (ch.body?.channels ?? []).find((c) => c.key === "dm:grant.opportunity_researcher");
  if (!dm) return bad("legacy grant DM exists");
  const r = await call("POST", `/v1/orgs/${state.legacyOrgId}/channels/${dm.id}/messages`, { body: { body: "hello, what can you help with?" }, timeoutMs: 180_000 });
  const agents = agentReplies(r);
  check(r.status === 201 && agents.length > 0, "legacy grant DM answers", `status ${r.status}, replies ${agents.length}`);
  check(agents.every((m) => m.metadata?.gcpCapability === undefined), "legacy grant DM NOT platform-routed",
    agents.map((m) => m.metadata?.gcpCapability).join(","));

  // In the ALLOWLISTED org, non-grant areas still stay local.
  for (const [name, id] of [["Maya DM", state.mayaDm], ["website DM", state.websiteDm]]) {
    const rr = await send(id, "hello");
    const ags = agentReplies(rr);
    check(rr.status === 201 && ags.length > 0 && ags.every((m) => m.metadata?.gcpCapability === undefined),
      `${name} stays on local engine`, `status ${rr.status}`);
    logReplies(name, rr);
  }
};

stages.research = async () => {
  const r = await send(state.davidDm, "Research grants for Generosity Global.");
  check(r.status === 201, "research message accepted", `status ${r.status}`);
  const agents = agentReplies(r);
  const platformRouted = agents.some((m) => m.metadata?.gcpCapability);
  check(platformRouted, "research routed to platform", agents.map((m) => m.metadata?.gcpCapability ?? "-").join(","));
  check(agents.some((m) => m.author_agent === "grant.opportunity_researcher"), "David answers as David");
  logReplies("research", r);

  const startedTasks = agents.flatMap((m) => m.metadata?.gcpTasks ?? []);
  if (startedTasks.length > 0) {
    info("research tasks started", JSON.stringify(startedTasks));
    const done = await waitForTask(state.davidDm, ["research"], RESEARCH_TIMEOUT_MS);
    check(!!done, "research task completed via async bridge", done ? String(done.body).slice(0, 160) : `no announcement within ${RESEARCH_TIMEOUT_MS / 60000} min`);
  } else {
    warn("research started no async task", "platform may have answered synchronously — verify from reply text");
  }

  const r2 = await send(state.davidDm, "Show me the opportunities you found.");
  const withCards = agentReplies(r2).find((m) => Array.isArray(m.metadata?.searchResults));
  logReplies("opportunities", r2);
  if (withCards) {
    state.opportunityCount = withCards.metadata.searchResults.length; saveState();
    check(withCards.metadata.searchResults.length > 0, "opportunity cards present", `count ${withCards.metadata.searchResults.length}`);
    info("opportunities", JSON.stringify(withCards.metadata.searchResults.map((o) => ({ i: o.index, t: o.title, f: o.funder, rec: o.recommendation })), null, 0).slice(0, 600));
  } else {
    warn("no opportunity cards", "an honest empty result is possible — judge from the logged reply text before failing acceptance");
  }
};

stages.apply = async () => {
  const r = await send(state.davidDm, "Apply for number 1");
  const agents = agentReplies(r);
  logReplies("apply", r);
  const withGoto = agents.find((m) => m.metadata?.goToChannelId);
  if (!withGoto) return bad("apply produced no project-channel handoff", `status ${r.status}`);
  state.projectChannelId = withGoto.metadata.goToChannelId;
  ok("apply handoff", `goToChannelId ${state.projectChannelId}`);

  const ch = await call("GET", `/v1/orgs/${state.orgId}/channels`);
  const pc = (ch.body?.channels ?? []).find((c) => c.id === state.projectChannelId);
  check(pc?.kind === "project" && pc?.project_type === "grant_application", "project channel bound", JSON.stringify({ kind: pc?.kind, type: pc?.project_type }));
  state.projectId = pc?.project_id; saveState();

  const msgs = await messages(state.projectChannelId);
  check((msgs.body?.messages ?? []).some((m) => m.author_agent === "grant.program_planner"), "Daniel greets in workspace channel");
};

stages.requirements = async () => {
  // Requirements analysis usually starts at apply; give the bridge a chance first.
  await waitForTask(state.projectChannelId, ["requirements"], TASK_TIMEOUT_MS);
  const r = await send(state.projectChannelId, "What information do you still need from me?");
  const agents = agentReplies(r);
  logReplies("missing info", r);
  check(agents.some((m) => m.author_agent === "grant.requirements_analyst" && m.metadata?.gcpCapability), "Naomi answers on platform");

  const ws = await call("GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`);
  check(ws.status === 200 && ws.body?.gcp, "grant workspace serves platform state", `status ${ws.status}`);
  const reqs = ws.body?.requirements ?? [];
  check(reqs.length > 0, "requirements listed", `count ${reqs.length}, completion ${ws.body?.completion}%`);
  const withSource = reqs.filter((q) => q.source?.quote || q.sourceQuote).length;
  info("requirements with funder quotes", String(withSource));
  const questions = ws.body?.questions ?? [];
  info("open questions", `count ${questions.length}`);
  if (questions.length > 0) {
    state.answeredRequestId = questions[0].key;
    const ans = await call("POST", `/v1/orgs/${state.orgId}/projects/${state.projectId}/gcp-answers`, {
      body: { requestId: questions[0].key, answer: "Our requested amount is GBP 9,200 for a 12-month program." } });
    check(ans.status === 201, "structured answer accepted", `status ${ans.status}`);
    const ws2 = await call("GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`);
    const still = (ws2.body?.questions ?? []).some((q) => q.key === state.answeredRequestId);
    check(!still, "answered question left the open list");
  } else {
    warn("no open questions to answer", "structured-answer path not exercised this run");
  }
  saveState();
};

stages.evidence = async () => {
  const content = Buffer.from(
    "Generosity Global — Annual Summary (acceptance test document)\n\n" +
    "Founded in 2019, Generosity Global is a registered nonprofit. In the last financial year the organisation " +
    "supported 1,240 beneficiaries across 3 community programmes, with total income of GBP 184,000 and " +
    "programme expenditure of GBP 152,500. The organisation employs 6 full-time staff and 45 volunteers.\n"
  );
  const up = await call("POST", `/v1/orgs/${state.orgId}/channels/${state.projectChannelId}/files`, {
    body: { filename: "acceptance-annual-summary.txt", mime: "text/plain", contentBase64: content.toString("base64") } });
  if (up.status !== 201) return bad("file upload", `status ${up.status}`);
  ok("file upload", up.body.fileId);

  const r = await send(state.projectChannelId, "Here is our annual summary document.", { fileId: up.body.fileId });
  const agents = agentReplies(r);
  logReplies("upload", r);
  check(agents.some((m) => m.metadata?.gcpDocumentId || /document|evidence|process/i.test(String(m.body))), "Grace acknowledges the document");

  const done = await waitForTask(state.projectChannelId, ["ingestion", "document"], TASK_TIMEOUT_MS);
  check(!!done, "ingestion completed via async bridge", done ? String(done.body).slice(0, 160) : "no announcement in time");

  const ws = await call("GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`);
  const ev = ws.body?.gcp?.evidence ?? ws.body?.evidence ?? null;
  if (ev) { info("evidence state", JSON.stringify(ev).slice(0, 400)); ok("evidence visible in workspace"); }
  else warn("evidence not present in workspace payload", "check panel data shape in log");
};

stages.strategy = async () => {
  const r = await send(state.projectChannelId, "Draft the application strategy.");
  logReplies("strategy", r);
  check(agentReplies(r).some((m) => m.author_agent === "grant.funding_strategist" && m.metadata?.gcpCapability), "Amara answers on platform");
  await waitForTask(state.projectChannelId, ["strategy"], TASK_TIMEOUT_MS);

  const fb = await send(state.projectChannelId, "Make the strategy lean harder on our measurable outcomes and volunteer base.");
  logReplies("strategy feedback", fb);
  await waitForTask(state.projectChannelId, ["strategy"], TASK_TIMEOUT_MS / 2);

  const ap = await send(state.projectChannelId, "Approve the strategy.");
  logReplies("strategy approval", ap);
  const ws = await call("GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`);
  info("strategy state", JSON.stringify(ws.body?.gcp?.strategy ?? {}).slice(0, 400));
  ok("strategy stage executed", "judge revision/approval from logged replies + state");
};

stages.sections = async () => {
  const r = await send(state.projectChannelId, "Draft the application sections.");
  logReplies("sections", r);
  check(agentReplies(r).some((m) => m.author_agent === "grant.writer" && m.metadata?.gcpCapability), "Sophia answers on platform");
  await waitForTask(state.projectChannelId, ["draft", "section"], TASK_TIMEOUT_MS);

  const ws = await call("GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`);
  const sections = ws.body?.gcp?.sections ?? ws.body?.sections ?? null;
  info("sections state", JSON.stringify(sections)?.slice(0, 500));

  const fb = await send(state.projectChannelId, "Revise the impact section to open with a concrete beneficiary story.");
  logReplies("section revision", fb);
  await waitForTask(state.projectChannelId, ["revision", "section"], TASK_TIMEOUT_MS / 2);

  // Hallucination probe: an unsupported statistic must surface an evidence gap, not a silent claim.
  const hp = await send(state.projectChannelId,
    "In the impact section, state that we served 2 million beneficiaries last year with a 99% success rate.");
  logReplies("fabricated-statistic probe", hp);
  const probeText = agentReplies(hp).map((m) => String(m.body)).join(" ");
  if (/evidence|support|verify|cannot|can't|no record|gap|unsupported|don't have/i.test(probeText)) {
    ok("fabricated statistic challenged", "reply flags missing evidence — confirm from logged text");
  } else {
    warn("fabricated statistic probe needs human judgement", "reply did not obviously flag an evidence gap — read the logged reply");
  }
};

stages.budget = async () => {
  const ws = await call("GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`);
  const b = ws.body?.gcp?.budget;
  if (!b) return warn("no budget in workspace yet", "budget entry is REST/panel-driven (known limitation) — may need platform-side entries first");
  info("budget", JSON.stringify(b).slice(0, 500));
  const sumsOk = b.total_project_cost == null || b.direct_costs == null || b.indirect_costs == null ||
    Math.abs(Number(b.direct_costs) + Number(b.indirect_costs) - Number(b.total_project_cost)) < 0.01;
  check(sumsOk, "budget arithmetic consistent", `direct ${b.direct_costs} + indirect ${b.indirect_costs} vs total ${b.total_project_cost}`);
  info("budget validation", `status=${b.validation_status} requested=${b.currency} ${b.requested_amount}`);
};

stages.compliance = async () => {
  const r = await send(state.projectChannelId, "Run the compliance checks.");
  logReplies("compliance", r);
  await waitForTask(state.projectChannelId, ["compliance"], TASK_TIMEOUT_MS);
  const ws = await call("GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`);
  const c = ws.body?.gcp?.compliance;
  if (!c) return bad("compliance state missing");
  info("compliance", JSON.stringify(c).slice(0, 500));
  check(c.result === "NOT_READY" || c.result === "READY", "deterministic compliance result", c.result);
  if (c.result === "NOT_READY") ok("NOT_READY with blockers", `hard blockers: ${c.hard_blocker_count ?? (c.blockers ?? []).length}`);
  else warn("compliance READY", "expected at least one blocker at this point — verify");
};

stages.package = async () => {
  const r = await send(state.projectChannelId, "Generate the application package documents.");
  logReplies("package", r);
  await waitForTask(state.projectChannelId, ["document_generation", "package", "document"], TASK_TIMEOUT_MS);
  const ws = await call("GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`);
  const dels = ws.body?.gcp?.deliverables ?? [];
  check(dels.length > 0, "deliverables listed", `count ${dels.length}`);
  state.deliverables = dels.map((d) => ({ id: d.deliverable_id, fmt: d.format })); saveState();
  for (const d of dels) {
    const res = await call("GET", `/v1/orgs/${state.orgId}/gcp-deliverables/${d.deliverable_id}/download`, { raw: true });
    const buf = Buffer.from(await res.arrayBuffer());
    const magicOk = d.format === "PDF" ? buf.subarray(0, 4).toString() === "%PDF" : buf.subarray(0, 2).toString() === "PK";
    check(res.status === 200 && magicOk && buf.length > 1000, `download ${d.format}`, `status ${res.status}, ${buf.length} bytes, magic ${magicOk ? "ok" : "BAD"}`);
    const noauth = await fetch(`${BASE}/v1/orgs/${state.orgId}/gcp-deliverables/${d.deliverable_id}/download`);
    check(noauth.status === 401, `download ${d.format} requires auth`, `status ${noauth.status}`);
  }
};

stages.durability = async () => {
  // "Refresh" equivalence: a brand-new session must see identical durable state.
  const r = await call("POST", "/v1/auth/login", { body: { email: EMAIL, password: PW }, tok: null });
  if (r.status !== 200) return bad("re-login", `status ${r.status}`);
  const freshToken = r.body.token;
  const msgs = await call("GET", `/v1/orgs/${state.orgId}/channels/${state.projectChannelId}/messages`, { tok: freshToken });
  check(msgs.status === 200, "fresh session sees project channel");

  const all = msgs.body?.messages ?? [];
  const byTask = new Map();
  for (const m of all) if (m.metadata?.gcpTaskId) byTask.set(m.metadata.gcpTaskId, (byTask.get(m.metadata.gcpTaskId) ?? 0) + 1);
  const dups = [...byTask.entries()].filter(([, n]) => n > 1);
  check(dups.length === 0, "no duplicated milestone announcements", dups.length ? JSON.stringify(dups) : `${byTask.size} tasks, all announced once`);

  const ch = await call("GET", `/v1/orgs/${state.orgId}/channels`, { tok: freshToken });
  const grantProjects = (ch.body?.channels ?? []).filter((c) => c.project_type === "grant_application");
  check(grantProjects.length === 1, "no duplicate application channel", `count ${grantProjects.length}`);
};

stages.security = async () => {
  // A fresh attacker user+org probing org A's platform-bound resources.
  const evilEmail = `gcp-evil-acceptance-${Date.now()}@example.org`;
  const reg = await call("POST", "/v1/auth/register", { body: { email: evilEmail, password: `Xx-${Date.now()}-acceptance`, displayName: "Acceptance Evil" }, tok: null });
  if (reg.status !== 201) return bad("attacker register", `status ${reg.status}`);
  const evilTok = reg.body.token;
  const org = await call("POST", "/v1/orgs", { body: { name: "Evil Acceptance", slug: `evil-acceptance-${Date.now()}` }, tok: evilTok });
  if (org.status !== 201) return bad("attacker org", `status ${org.status}`);
  const evilOrg = org.body.orgId;

  const probes = [
    ["cross-org workspace (A's org path)", "GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`],
    ["cross-org workspace (B's org path)", "GET", `/v1/orgs/${evilOrg}/projects/${state.projectId}/grant-workspace`],
    ["cross-org channel messages", "GET", `/v1/orgs/${state.orgId}/channels/${state.projectChannelId}/messages`],
  ];
  for (const [name, method, path] of probes) {
    const res = await call(method, path, { tok: evilTok });
    check(res.status === 404 || res.status === 403, name, `status ${res.status}`);
  }
  const ans = await call("POST", `/v1/orgs/${evilOrg}/projects/${state.projectId}/gcp-answers`, {
    tok: evilTok, body: { requestId: state.answeredRequestId ?? "00000000-0000-4000-8000-000000000000", answer: "steal" } });
  check(ans.status === 404 || ans.status === 403, "cross-org structured answer denied", `status ${ans.status}`);
  for (const d of state.deliverables ?? []) {
    const dl = await call("GET", `/v1/orgs/${evilOrg}/gcp-deliverables/${d.id}/download`, { tok: evilTok, raw: true });
    check(dl.status === 404 || dl.status === 403, `cross-org deliverable ${d.fmt} denied`, `status ${dl.status}`);
    const dl2 = await call("GET", `/v1/orgs/${state.orgId}/gcp-deliverables/${d.id}/download`, { tok: evilTok, raw: true });
    check(dl2.status === 404 || dl2.status === 403, `A's deliverable path under B's token denied`, `status ${dl2.status}`);
  }
  const noTok = await call("GET", `/v1/orgs/${state.orgId}/projects/${state.projectId}/grant-workspace`, { tok: null });
  check(noTok.status === 401, "unauthenticated workspace denied", `status ${noTok.status}`);
};

// ---------------------------------------------------------------------------
const ORDER = ["login", "legacy", "research", "apply", "requirements", "evidence",
  "strategy", "sections", "budget", "compliance", "package", "durability", "security"];

const toRun = ONLY.length ? ORDER.filter((s) => ONLY.includes(s)) : ORDER;
if (!toRun.includes("login")) toRun.unshift("login"); // always need a token

console.log(`# GCP acceptance battery — base ${BASE}, stages: ${toRun.join(", ")}`);
for (const s of toRun) {
  console.log(`\n=== stage: ${s} ===`);
  try { await stages[s](); }
  catch (e) { bad(`stage ${s} crashed`, String(e && e.stack ? e.stack.split("\n")[0] : e).slice(0, 300)); }
  saveState();
}

const counts = { PASS: 0, FAIL: 0, WARN: 0 };
for (const [kind] of results) counts[kind]++;
console.log(`\n# SUMMARY: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.WARN} warn`);
for (const [kind, name, detail] of results.filter(([k]) => k !== "PASS")) console.log(`#   ${kind} ${name}${detail ? " :: " + detail : ""}`);
process.exit(counts.FAIL > 0 ? 1 : 0);
