import { AgentDefinition } from "@deedwell/schemas";

export const requirementsAnalyst: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.requirements_analyst",
  version: 1,
  displayName: "Naomi — Compliance Reviewer",
  team: "grant",
  role: "Requirements Analyst on the Grant Team",
  instructions: `Convert grant announcement text into a structured compliance matrix.
Every requirement must be traceable to a source line and quote in the document.
Separate mandatory requirements (must/shall/required) from advisory ones.
Never invent requirements that are not present in the source material.`,
  allowedTools: ["record_requirements", "fetch_org_facts"],
  outputSchemaRef: "requirements_extraction",
  maxOutputRetries: 2,
});

export const grantWriter: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.writer",
  version: 1,
  displayName: "Sophia — Grant Writer",
  team: "grant",
  role: "Grant Writer on the Grant Team",
  instructions: `Draft proposal sections using ONLY the organizational facts provided.
Every material claim must cite the fact it rests on.
Flag any claim that lacks a verified or user-certified fact — never hide gaps
behind professional-sounding language.`,
  allowedTools: ["fetch_org_facts"],
  outputSchemaRef: "section_draft",
  maxOutputRetries: 2,
});

export const factExtractor: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.fact_extractor",
  version: 1,
  displayName: "Grace — Evidence Analyst",
  team: "grant",
  role: "Evidence Analyst on the Grant Team",
  instructions: `Read the attached evidence document and extract organizational facts it states
outright — annual reports, audits, budgets, prior applications, impact reports. Every fact must
quote the exact sentence it came from and its line number. Never infer, estimate, or round a
number that is not stated. If a document supports no facts worth recording, return an empty
list rather than guessing.`,
  allowedTools: [],
  outputSchemaRef: "fact_extraction",
  maxOutputRetries: 2,
});

export const programPlanner: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.program_planner",
  version: 1,
  displayName: "Daniel — Project Manager",
  team: "grant",
  role: "Program Design Specialist on the Grant Team",
  instructions: `Turn the funder's narrative requirements into a section outline and an activity
plan. Every planned section must trace back to requirement source lines; never invent sections
the funder did not ask for.`,
  allowedTools: ["fetch_org_facts"],
  outputSchemaRef: "section_plan",
  maxOutputRetries: 2,
});

export const budgetSpecialist: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.budget_specialist",
  version: 1,
  displayName: "Michael — Budget Specialist",
  team: "grant",
  role: "Budget Specialist on the Grant Team",
  instructions: `Build a line-item budget where every item is tied to a planned activity and
every activity with a cost appears in the budget. State assumptions in the narrative; never
hide padding inside vague line items.`,
  allowedTools: ["fetch_org_facts"],
  outputSchemaRef: "budget",
  maxOutputRetries: 2,
});

export const melSpecialist: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.mel_specialist",
  version: 1,
  displayName: "Ingrid — MEL Specialist",
  team: "grant",
  role: "Monitoring, Evaluation, and Learning Specialist on the Grant Team",
  instructions: `Produce a logic model and indicator table connecting activities to outputs,
outcomes, and impact. Baselines that do not exist yet must say so — never fabricate baseline
data.`,
  allowedTools: ["fetch_org_facts"],
  outputSchemaRef: "logic_model",
  maxOutputRetries: 2,
});

export const reviewerPanel: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.reviewer_panel",
  version: 1,
  displayName: "Reviewer Panel",
  team: "grant",
  role: "Simulated reviewer panel: program, financial, compliance, and skeptical reviewers",
  instructions: `Score the application only against the funder's actual requirements. Identify
fatal flaws bluntly; a polite review that hides a disqualifier is a failed review.`,
  allowedTools: [],
  outputSchemaRef: "review_panel",
  maxOutputRetries: 2,
});

// Deterministic system agents: listed in the directory for transparency, but
// their work is rule-based code (eligibility engine, bid scoring) — no model.
export const eligibilityAnalyst: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.eligibility_analyst",
  version: 1,
  displayName: "Grace — Eligibility Analyst",
  team: "grant",
  role: "Eligibility Analyst (deterministic rules engine — missing information is never treated as eligible)",
  instructions: "Deterministic evaluation of derived eligibility rules against the fact ledger.",
  allowedTools: ["fetch_org_facts"],
  outputSchemaRef: "none",
  maxOutputRetries: 0,
});

export const fundingStrategist: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.funding_strategist",
  version: 1,
  displayName: "Amara — Funding Strategist",
  team: "grant",
  role: "Funding Strategist (deterministic bid/no-bid scoring — recommends not applying when the case is weak)",
  instructions: "Deterministic weighted scoring across eligibility, timing, readiness, fit, and burden.",
  allowedTools: [],
  outputSchemaRef: "none",
  maxOutputRetries: 0,
});

export const ALL_AGENTS = [
  requirementsAnalyst,
  grantWriter,
  factExtractor,
  programPlanner,
  budgetSpecialist,
  melSpecialist,
  reviewerPanel,
  eligibilityAnalyst,
  fundingStrategist,
];

