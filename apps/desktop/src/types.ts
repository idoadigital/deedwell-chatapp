export type OrgRole = "owner" | "admin" | "member" | "viewer";

export interface Organization {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
}

export interface Project {
  id: string;
  name: string;
  type: "grant_application" | "website" | "other";
  status: string;
  created_at: string;
}

export type RunStatus =
  | "pending"
  | "running"
  | "waiting_for_info"
  | "waiting_approval"
  | "suspended_budget"
  | "failed"
  | "completed"
  | "cancelled";

export interface RunSummary {
  id: string;
  project_id: string;
  project_name?: string;
  definition: string;
  status: RunStatus;
  current_step: string;
  steps_used: number;
  step_budget: number;
  last_error: string | null;
  waiting: { kind: string; payload: string } | null;
  created_at: string;
  updated_at: string;
}

export interface RunStep {
  seq: number;
  step: string;
  attempt: number;
  status: "completed" | "failed";
  error: string | null;
  duration_ms: number;
  created_at: string;
}

export interface Approval {
  id: string;
  run_id?: string;
  kind: string;
  payload: { artifactId?: string; version?: number; warnings?: string[] };
  status: "pending" | "approved" | "rejected";
  note: string | null;
  created_at: string;
  project_name?: string;
  project_id?: string;
}

export interface ArtifactSummary {
  id: string;
  type:
    | "compliance_matrix"
    | "grant_section"
    | "export_package"
    | "application_plan"
    | "budget"
    | "logic_model"
    | "review_report"
    | "compliance_report"
    | "website_brief"
    | "website_test_report";
  title: string;
  current_version: number;
  updated_at: string;
}

export interface RunDetail {
  run: RunSummary;
  steps: RunStep[];
  approvals: Approval[];
  artifacts: ArtifactSummary[];
}

export interface ArtifactVersion {
  version: number;
  content: Record<string, unknown>;
  created_by_kind: "user" | "agent";
  created_by_agent: string | null;
  change_summary: string;
  created_at: string;
}

export interface ArtifactDetail {
  artifact: ArtifactSummary & { project_id: string; run_id: string | null };
  versions: ArtifactVersion[];
}

export interface AgentInfo {
  agent_key: string;
  version: number;
  display_name: string;
  team: string;
  role: string;
  allowed_tools: string[];
}

export interface OrgFactRow {
  fact_key: string;
  value: string;
  status: string;
  updated_at: string;
}

export interface Requirement {
  text: string;
  kind: string;
  mandatory: boolean;
  sourceLocation: { line: number; quote: string };
  wordLimit: number | null;
}

export interface SectionClaim {
  text: string;
  factKey: string | null;
  support: string;
  flagged: boolean;
}

// ---- Phase 3 ----

export interface PassportFieldStatus {
  key: string;
  label: string;
  section: string;
  required: boolean;
  hint?: string;
  value: string | null;
  status: string | null;
}

export interface PassportStatus {
  fields: PassportFieldStatus[];
  completeness: number;
  requiredMissing: string[];
}

export interface SearchHit {
  externalId: string;
  opportunityNumber: string;
  title: string;
  agency: string;
  closeDate: string | null;
  status: string;
  sourceUrl: string;
  source: string;
}

export interface OpportunityRow {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  funder: string;
  source: string;
  opportunity_number: string | null;
  deadline: string | null;
  funding_max: string | null;
  status: string;
  eligibility: string | null;
  bid_recommendation: string | null;
  created_at: string;
}

export interface OpportunityDetail {
  opportunity: OpportunityRow & { injection_warnings: unknown[] };
  eligibility: {
    overall: string;
    rule_findings: Array<{ ruleKey: string; status: string; evidence: string }>;
    missing_facts: string[];
  } | null;
  bid: {
    id: string;
    scores: Array<{ key: string; label: string; score: number; weight: number; note: string }>;
    total: string | number;
    recommendation: string;
    rationale: string;
    decision: string | null;
  } | null;
  application: { id: string; run_id: string; status: string } | null;
}

export interface ApplicationRow {
  id: string;
  project_id: string;
  opportunity_id: string;
  run_id: string;
  status: string;
  opportunity_title: string;
  funder: string;
  deadline: string | null;
  outcome: string | null;
  award_amount: string | null;
}

// ---- Phase 4: websites ----

export interface SiteRow {
  id: string;
  project_id: string;
  project_name: string;
  slug: string;
  name: string;
  status: "draft" | "preview" | "published";
  preview_version: number | null;
  live_version: number | null;
  submissions: number;
  created_at: string;
}

export interface SiteCheckRow {
  name: string;
  page: string | null;
  pass: boolean;
  detail: string;
}

export interface SiteReleaseRow {
  id: string;
  version: number;
  status: "built" | "published" | "superseded";
  checks: SiteCheckRow[];
  published_at: string | null;
  created_at: string;
}

export interface SiteDetail {
  site: {
    id: string;
    project_id: string;
    slug: string;
    name: string;
    status: string;
    preview_release_id: string | null;
    active_release_id: string | null;
  };
  pages: Array<{ slug: string; title: string; order_idx: number }>;
  releases: SiteReleaseRow[];
}

export interface SubmissionRow {
  id: string;
  form_key: string;
  payload: Record<string, string>;
  created_at: string;
}

export type WorkflowEvent =
  | { type: "run_updated"; tenantId: string; runId: string; status: RunStatus; step: string }
  | { type: "message_created"; tenantId: string; channelId: string };

// ---- chat ----

export interface TeammateInfo {
  agentKey: string;
  name: string;
  role: string;
  team: string;
}

export interface ChannelInfo {
  id: string;
  key: string;
  name: string;
  kind: "team" | "project" | "dm";
  project_id: string | null;
  project_type: string | null;
  agent_key: string | null;
  starred: boolean;
  last_message_at: string | null;
}

export interface ChatMessage {
  id: string;
  author_kind: "user" | "agent" | "system";
  author_user: string | null;
  author_agent: string | null;
  author_name: string | null;
  body: string;
  metadata: {
    searchResults?: Array<{
      index: number; title: string; funder?: string; number?: string;
      closeDate?: string | null; sourceUrl?: string; externalId?: string;
    }>;
    openWorkspace?: boolean;
    pendingUpload?: boolean;
    approvalId?: string;
    approvalKind?: string;
    approvalPayload?: Record<string, unknown>;
    /** Structured info-request fields (older messages carried bare keys). */
    infoRequest?: Array<string | {
      key: string; label: string;
      inputType: "text" | "textarea" | "number" | "date" | "boolean" | "choice";
      choices?: string[]; help: string; reason: string; required: boolean; group: string;
    }>;
    runId?: string;
    siteId?: string;
    fileId?: string;
    goToChannelId?: string;
    huddleId?: string;
    huddleEvent?: string;
    /** Grant-platform tasks started by this turn (working indicator). */
    gcpTasks?: Array<{ task_id: string; task_type: string; status: string }>;
    /** Bridge milestone for a finished platform task (clears the indicator). */
    gcpTaskId?: string;
  };
  created_at: string;
}

// ---- grant-platform observable execution (Activity/Sources panels) ---------

export interface GcpActivityEvent {
  event_id: string;
  event_type: string;
  label: string;
  message: string | null;
  metadata: Record<string, unknown>;
  at: string;
}

export interface GcpActivityTask {
  task_id: string;
  task_type: string;
  status: "queued" | "running" | "completed" | "failed" | string;
  title: string | null;
  capability: string | null;
  service: string | null;
  progress: string | null;
  result_summary: string | null;
  failure_code: string | null;
  failure_message: string | null;
  application_id: string | null;
  document_id: string | null;
  run_count: number | null;
  attempts: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  elapsed_ms: number | null;
  events: GcpActivityEvent[];
}

export interface GcpActivity {
  tasks: GcpActivityTask[];
  counts: { tasks: number; running: number; failed: number };
}

export interface GcpResearchSources {
  task_id: string;
  answer: string | null;
  sources: Array<{ id?: string; title: string | null; url: string | null; domain: string | null; quality: string | null }>;
  web_search_queries: string[];
}

export interface MemberInfo {
  id: string;
  display_name: string;
  email: string;
  role: OrgRole;
}

// ---- grant application workspace (workspace spec) --------------------------

export interface WorkspaceEvent {
  id: string; run_id: string | null; event_type: string; title: string; summary: string;
  status: "in_progress" | "completed" | "failed" | "blocked";
  agent_key: string | null; artifact_id: string | null;
  metadata: Record<string, unknown>; error: string | null;
  created_at: string; completed_at: string | null;
}

export interface ResearchSource {
  id: string; url: string | null; title: string; publisher: string | null;
  source_type: string; reliability: string; fetch_status: string;
  file_id: string | null; excerpt: string; retrieved_at: string;
}

export interface WorkspaceQuestion {
  key: string; label: string; reasonNeeded: string; prefill: string | null;
  inputType?: "text" | "textarea" | "number" | "date" | "boolean" | "choice";
  choices?: string[]; help?: string; required?: boolean; group?: string;
}

export interface GrantWorkspace {
  project: {
    id: string; name: string; type: string; workspace_status: string; workspace_phase: string;
    pending_intent: Record<string, unknown> | null;
    grant_title: string | null; funder: string | null; opportunity_number: string | null;
    deadline: string | null; source_url: string | null;
  };
  run: { id: string; status: string; current_step: string; last_error: string | null } | null;
  completion: number;
  events: WorkspaceEvent[];
  sources: ResearchSource[];
  artifacts: Array<{ id: string; type: string; title: string; current_version: number; updated_at: string }>;
  requirements: Array<{ key?: string; kind?: string; text?: string; mandatory?: boolean; sourceLine?: string;
    status?: string; statusReason?: string | null; wordLimit?: number | null }>;
  eligibility: { overall: string; rule_findings: unknown[]; missing_facts: string[]; created_at: string } | null;
  files: Array<{ id: string; filename: string; mime: string; size_bytes: number; created_at: string;
    ingestion_status?: string; fact_count?: number }>;
  questions: WorkspaceQuestion[];
  /** Present when this project runs on the external grant platform. */
  gcp?: GcpWorkspaceBlock | null;
}

/** Real persisted state from the grant platform — nothing computed client-side. */
export interface GcpWorkspaceBlock {
  application: {
    application_id: string; status: string; funder: string; program_name: string;
    official_url: string | null; deadline_text: string | null; deadline_date: string | null;
    grant_opportunity?: { recommendation?: string | null; mission_fit_score?: number | null } | null;
  } | null;
  readiness: { total?: number; complete?: number; percent_complete?: number } | null;
  strategy: {
    version: number; status: string; blocking_gap_count?: number;
    funder_priorities?: unknown[]; organization_fit?: string | null;
    recommended_project?: string | null; recommended_project_rationale?: string | null;
    strongest_evidence?: unknown[]; positioning?: string | null;
    narrative_themes?: unknown[]; weaknesses?: unknown[]; risks?: unknown[];
    evidence_gaps?: Array<Record<string, unknown>>; required_decisions?: unknown[];
  } | null;
  strategyApprovedVersion: number | null;
  sections: {
    progress: { total: number; not_started: number; draft: number; review: number;
      approved: number; blocked?: number; total_blockers?: number };
    sections: Array<{
      section_id: string; section_title: string; question_text?: string; status: string;
      current_revision_number: number; word_limit?: number | null; char_limit?: number | null;
      unresolved_gaps?: unknown[]; blockers?: unknown[];
    }>;
  } | null;
  budget: {
    version: number; status: string; validation_status?: string; currency?: string;
    requested_amount?: number; total_project_cost?: number;
    direct_costs?: number; indirect_costs?: number; indirect_rate?: number | null;
    funder_max_amount?: number | null; narrative?: string | null;
    validation_errors?: unknown[]; validation_warnings?: unknown[];
    lines?: Array<Record<string, unknown>>;
  } | null;
  compliance: {
    result: string; hard_blocker_count: number; soft_warning_count?: number;
    checks_run?: number; checks_passed?: number; created_at: string;
    blockers?: Array<Record<string, unknown>>; warnings?: Array<Record<string, unknown>>;
    checks?: Array<Record<string, unknown>>;
  } | null;
  deliverables: Array<{
    deliverable_id: string; deliverable_type: string; format: string; status: string;
    size_bytes?: number | null; version?: number; created_at: string;
    generated_from?: Record<string, unknown> | null;
  }>;
  documents: Array<Record<string, unknown>>;
  evidenceCount: number;
  activity: { tasks: Array<Record<string, unknown>>; counts: { running?: number; failed?: number } };
}

export interface GrantActionRef {
  type: "start_grant_application";
  index?: number | null; title: string; number?: string | null; funder?: string | null;
  closeDate?: string | null; sourceUrl?: string | null; externalId?: string | null;
}
