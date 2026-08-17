/**
 * Which existing teammate speaks for each grant-platform capability and task.
 *
 * The platform's capabilities are backend workflow names; the user experiences
 * the same named teammates they already know. No teammate is invented here —
 * every key is one of the 13 provisioned identities in teammates.ts, and every
 * capability is one the platform actually exposes.
 */

const CAPABILITY_TEAMMATE: Record<string, string> = {
  // Research & opportunities — David, Grant Researcher
  research_grants: "grant.opportunity_researcher",
  show_opportunities: "grant.opportunity_researcher",
  explain_opportunity: "grant.opportunity_researcher",
  // Application workspace & status — Daniel, Project Manager
  create_application: "grant.program_planner",
  status_overview: "grant.program_planner",
  // Funder requirements, missing information, compliance — Naomi, Compliance Reviewer
  analyze_requirements: "grant.requirements_analyst",
  show_requirements: "grant.requirements_analyst",
  show_missing_info: "grant.requirements_analyst",
  answer_question: "grant.requirements_analyst",
  run_compliance: "grant.requirements_analyst",
  // Evidence Library & documents — Grace, Eligibility Analyst
  show_evidence: "grant.eligibility_analyst",
  show_documents: "grant.eligibility_analyst",
  // Strategy — Amara, Funding Strategist
  generate_strategy: "grant.funding_strategist",
  show_strategy: "grant.funding_strategist",
  approve_strategy: "grant.funding_strategist",
  // Drafting & revisions — Sophia, Grant Writer
  init_sections: "grant.writer",
  draft_sections: "grant.writer",
  show_sections: "grant.writer",
  revise_section: "grant.writer",
  show_revisions: "grant.writer",
  approve_section: "grant.writer",
  // Budget — Michael, Budget Specialist
  show_budget: "grant.budget_specialist",
  budget_narrative: "grant.budget_specialist",
  // Final package — Daniel, Project Manager
  generate_documents: "grant.program_planner",
  show_deliverables: "grant.program_planner",
};

const TASK_TEAMMATE: Record<string, string> = {
  research: "grant.opportunity_researcher",
  verification: "grant.eligibility_analyst",
  requirements_analysis: "grant.requirements_analyst",
  document_ingestion: "grant.eligibility_analyst",
  strategy_generation: "grant.funding_strategist",
  section_drafting: "grant.writer",
  section_revision: "grant.writer",
  budget_narrative: "grant.budget_specialist",
  compliance: "grant.requirements_analyst",
  document_generation: "grant.program_planner",
};

/** Friendly progress phrases for async platform tasks (never chain-of-thought). */
const TASK_LABEL: Record<string, { doing: string; done: string; failed: string }> = {
  research: { doing: "researching grant opportunities", done: "Research finished", failed: "Research hit a problem" },
  verification: { doing: "verifying eligibility against the funder's own materials", done: "Verification finished", failed: "Verification hit a problem" },
  requirements_analysis: { doing: "reading the funder's application requirements", done: "Requirements analysis finished", failed: "Requirements analysis hit a problem" },
  document_ingestion: { doing: "processing the uploaded document into the Evidence Library", done: "Document processed", failed: "Document processing failed" },
  strategy_generation: { doing: "drafting the application strategy", done: "Strategy draft ready", failed: "Strategy generation hit a problem" },
  section_drafting: { doing: "drafting application sections", done: "Drafting finished", failed: "Drafting hit a problem" },
  section_revision: { doing: "revising the section", done: "Revision ready", failed: "Revision hit a problem" },
  budget_narrative: { doing: "writing the budget narrative", done: "Budget narrative ready", failed: "Budget narrative hit a problem" },
  compliance: { doing: "running the compliance checks", done: "Compliance check finished", failed: "Compliance check hit a problem" },
  document_generation: { doing: "generating the application package", done: "Application package generated", failed: "Document generation failed" },
};

const DEFAULT_TEAMMATE = "grant.program_planner"; // Daniel keeps the project moving

export function teammateForCapability(capability: string): string {
  return CAPABILITY_TEAMMATE[capability] ?? DEFAULT_TEAMMATE;
}

export function teammateForTask(taskType: string): string {
  return TASK_TEAMMATE[taskType] ?? DEFAULT_TEAMMATE;
}

export function taskPhrases(taskType: string): { doing: string; done: string; failed: string } {
  return TASK_LABEL[taskType] ?? {
    doing: `working on ${taskType.replace(/_/g, " ")}`,
    done: `${taskType.replace(/_/g, " ")} finished`,
    failed: `${taskType.replace(/_/g, " ")} hit a problem`,
  };
}

/** DMs with any grant-team member route to the platform when it is enabled. */
export function isGrantTeamDm(kind: string, agentKey: string | null | undefined): boolean {
  return kind === "dm" && !!agentKey && agentKey.startsWith("grant.");
}
