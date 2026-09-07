/**
 * Every transactional email the platform sends, one function per kind. A
 * template turns a stored payload (what the outbox row carries) into an
 * EmailDoc; rendering to HTML/text happens at send time so copy fixes never
 * need a data migration. Keep payloads small and JSON-plain.
 */
import type { EmailConfig } from "./config.js";
import type { Block, EmailDoc } from "./layout.js";

export type EmailCategory = "account" | "billing" | "activity" | "ops";

export interface EmailPayloads {
  // ---- account ------------------------------------------------------------
  welcome: { displayName: string };
  workspace_created: { displayName: string; orgName: string; orgSlug: string };
  added_to_workspace: { displayName: string; orgName: string; role: string; addedBy?: string | null };
  password_reset: { displayName: string; resetUrl: string; expiresMinutes: number };
  password_changed: { displayName: string; sessionsRevoked: boolean };
  temp_password: { displayName: string; tempPassword: string; orgName?: string | null; reason: "created" | "reset" };
  support_received: { displayName: string; orgName: string; body: string };
  support_reply: { displayName: string; orgName: string; body: string };
  // ---- billing ------------------------------------------------------------
  topup_receipt: { orgName: string; packageName: string; tokens: number; amountCents: number; currency: string; transactionId: string; resumedRuns: number; purchasedBy?: string | null };
  out_of_tokens: { orgName: string; what: string };
  low_balance: { orgName: string; tokenBalance: number };
  billing_exempt: { orgName: string };
  // ---- activity -----------------------------------------------------------
  site_preview_ready: { orgName: string; siteName: string; version: number; previewUrl: string | null; warnings: string[] };
  site_build_failed: { orgName: string; siteName: string; version: number; previewUrl: string | null; blocking: string[] };
  site_published: { orgName: string; siteName: string; liveUrl: string | null; partnerBuilt?: boolean };
  run_failed: { orgName: string; title: string; error: string | null; status: "failed" | "suspended_budget" };
  approval_needed: { orgName: string; title: string; agentName: string; nextAction: string };
  info_needed: { orgName: string; title: string; agentName: string; nextAction: string };
  grant_package_ready: { orgName: string; opportunityTitle: string; funder: string | null };
  content_campaign_finished: { orgName: string; title: string; status: "ready" | "failed"; error?: string | null };
  post_failed: { orgName: string; platform: string; accountName: string | null; scheduledAt: string | null; error: string; content: string };
  connector_attention: { orgName: string; provider: string; accountName: string | null; detail: string | null };
  form_submission: { orgName: string; siteName: string; formKey: string; fields: [string, string][] };
  ad_grants_review: { orgName: string; status: "approved" | "rejected"; reason: string | null };
  ad_grants_reconnect: { orgName: string; step: string };
  ad_grants_live: { orgName: string; campaignId: string | null };
  task_approval_requested: { orgName: string; taskTitle: string; agentName: string };
  task_completed: { orgName: string; taskTitle: string; agentName: string; summary: string; deliverables: string[]; runNumber: number | null; nextRunAt: string | null };
  task_failed: { orgName: string; taskTitle: string; agentName: string; error: string };
  task_needs_input: { orgName: string; taskTitle: string; agentName: string; question: string };
  teammate_message: { orgName: string; agentName: string; agentRole: string; message: string };
  unread_digest: { orgName: string; displayName: string; total: number; channels: { name: string; count: number }[] };
  // ---- ops (internal) -----------------------------------------------------
  ops_alert: { title: string; rows: [string, string][]; body?: string | null; tone?: "info" | "warn" | "danger" | "ok" };
}

export type EmailKind = keyof EmailPayloads;

export const EMAIL_CATEGORY: Record<EmailKind, EmailCategory> = {
  welcome: "account", workspace_created: "account", added_to_workspace: "account", password_reset: "account",
  password_changed: "account", temp_password: "account", support_received: "account", support_reply: "account",
  topup_receipt: "billing", out_of_tokens: "billing", low_balance: "billing", billing_exempt: "billing",
  site_preview_ready: "activity", site_build_failed: "activity", site_published: "activity", run_failed: "activity",
  approval_needed: "activity", info_needed: "activity", grant_package_ready: "activity", content_campaign_finished: "activity",
  post_failed: "activity", connector_attention: "activity", form_submission: "activity", ad_grants_review: "activity",
  ad_grants_reconnect: "activity", ad_grants_live: "activity", task_approval_requested: "activity", task_completed: "activity",
  task_failed: "activity", task_needs_input: "activity", teammate_message: "activity", unread_digest: "activity",
  ops_alert: "ops",
};

export const EMAIL_KINDS = Object.keys(EMAIL_CATEGORY) as EmailKind[];

type Links = ReturnType<typeof linksFor>;

export function linksFor(cfg: Pick<EmailConfig, "appOrigin" | "coworkersOrigin">) {
  const d = `${cfg.appOrigin}/dashboard`;
  return {
    home: cfg.appOrigin,
    dashboard: d,
    login: `${cfg.appOrigin}/auth`,
    billing: `${d}/settings?tab=billing`,
    account: `${d}/settings?tab=account`,
    website: `${d}/website`,
    content: `${d}/content`,
    tasks: `${d}/tasks`,
    connectors: `${d}/connectors`,
    adGrants: `${d}/ad-grants`,
    chat: `${d}/chat`,
    coworkers: cfg.coworkersOrigin,
    support: `${d}/settings?tab=account`,
    grants: `${d}/chat`,
  };
}

const first = (name: string) => (name ?? "").trim().split(/\s+/)[0] || "there";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtTokens = (n: number) => `${Math.round(n).toLocaleString("en-US")} tokens`;
const fmtMoney = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(cents / 100);
const fmtWhen = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
};
const p = (text: string): Block => ({ type: "p", text });
const kv = (rows: [string, string][]): Block => ({ type: "kv", rows });
const list = (items: string[]): Block => ({ type: "list", items });
const quote = (text: string, by?: string): Block => ({ type: "quote", text, ...(by ? { by } : {}) });
const callout = (text: string, tone: "info" | "ok" | "warn" | "danger" = "info"): Block => ({ type: "callout", text, tone });

type Renderer<K extends EmailKind> = (payload: EmailPayloads[K], links: Links) => EmailDoc;

const templates: { [K in EmailKind]: Renderer<K> } = {
  // ---- account ------------------------------------------------------------
  welcome: (x, L) => ({
    subject: "Welcome to Deedwell",
    preheader: "Your AI co-workers are ready. Here's where to start.",
    eyebrow: "Welcome",
    heading: `Welcome aboard, ${first(x.displayName)}.`,
    blocks: [
      p("Your Deedwell account is live. From here you can get your Google Ad Grant approved, have a grant-qualifying website built for free, and hand day-to-day content and research to your AI co-workers."),
      list([
        "**Google Ad Grant** — qualify, apply and put up to $10,000/month of Google advertising to work.",
        "**Free website** — a new site or redesign, built for you and ready for the grant.",
        "**Co-Workers** — an autonomous team for content, grants and research that reports back here and by email.",
      ]),
      p("Start by filling in your Mission Profile: everything your co-workers produce is grounded in it."),
    ],
    cta: { label: "Open your dashboard", url: L.dashboard },
    footnote: "Questions? Reply to this email and a person answers, usually the same day.",
  }),

  workspace_created: (x, L) => ({
    subject: `${x.orgName} is set up on Deedwell`,
    preheader: "Your workspace is ready. Invite teammates and set your Mission Profile.",
    eyebrow: "Your workspace",
    heading: `${x.orgName} is ready.`,
    blocks: [
      p(`You're the owner of the **${x.orgName}** workspace. Teammates you add will see the same dashboard, chat and files.`),
      kv([["Workspace", x.orgName], ["Workspace ID", x.orgSlug], ["Owner", x.displayName]]),
      p("Three things worth doing first: complete the Mission Profile, connect the accounts you publish to, and ask a co-worker for something small to see how they work."),
    ],
    cta: { label: "Go to the dashboard", url: L.dashboard },
    secondaryCta: { label: "Complete your Mission Profile", url: `${L.dashboard}/mission` },
  }),

  added_to_workspace: (x, L) => ({
    subject: `You've been added to ${x.orgName} on Deedwell`,
    preheader: `${x.addedBy ?? "A teammate"} added you as ${x.role}.`,
    eyebrow: "Workspace access",
    heading: `You're now part of ${x.orgName}.`,
    blocks: [
      p(`${x.addedBy ? `**${x.addedBy}**` : "A teammate"} added you to the **${x.orgName}** workspace with the **${x.role}** role. Log in with your existing Deedwell email and password to see it.`),
    ],
    cta: { label: "Open the workspace", url: L.dashboard },
    footnote: "If you weren't expecting this, you can ignore the email or let us know by replying.",
  }),

  password_reset: (x) => ({
    subject: "Reset your Deedwell password",
    preheader: `This link works for ${x.expiresMinutes} minutes.`,
    eyebrow: "Account security",
    heading: "Reset your password",
    blocks: [
      p(`Hi ${first(x.displayName)}, someone asked to reset the password for this Deedwell account. Use the button below to choose a new one.`),
      callout(`The link expires in ${x.expiresMinutes} minutes and can be used once.`),
    ],
    cta: { label: "Choose a new password", url: x.resetUrl },
    footnote: "If you didn't request this, no action is needed. Your password stays the same until you use the link.",
  }),

  password_changed: (x, L) => ({
    subject: "Your Deedwell password was changed",
    preheader: "If this wasn't you, reset it right away.",
    eyebrow: "Account security",
    heading: "Your password was changed.",
    blocks: [
      p(`${x.displayName ? `Hi ${first(x.displayName)}, the` : "The"} password for your Deedwell account was just changed.${x.sessionsRevoked ? " Every other signed-in session was logged out." : ""}`),
      callout("Wasn't you? Reset your password now and reply to this email so we can look into it.", "warn"),
    ],
    cta: { label: "Log in", url: L.login },
  }),

  temp_password: (x, L) => ({
    subject: x.reason === "created" ? "Your Deedwell account is ready" : "Your Deedwell temporary password",
    preheader: "Log in with the temporary password, then choose your own.",
    eyebrow: "Your account",
    heading: x.reason === "created" ? `Hi ${first(x.displayName)}, your account is ready.` : "Here's your temporary password.",
    blocks: [
      p(x.reason === "created"
        ? `A Deedwell team member created an account for you${x.orgName ? ` in the **${x.orgName}** workspace` : ""}. Log in with the temporary password below; you'll be asked to choose your own straight away.`
        : "A Deedwell team member reset your password. Log in with the temporary password below; you'll be asked to choose your own straight away."),
      { type: "code", text: x.tempPassword, label: "Temporary password" },
    ],
    cta: { label: "Log in", url: L.login },
    footnote: "Keep this email private. Anyone with the temporary password can log in until you change it.",
  }),

  support_received: (x, L) => ({
    subject: "We got your message",
    preheader: "A person will reply here and in your dashboard.",
    eyebrow: "Support",
    heading: `Thanks, ${first(x.displayName)}. We're on it.`,
    blocks: [
      p(`Your message from the **${x.orgName}** workspace reached the Deedwell team. Someone will reply, usually the same day. You'll get an email when they do.`),
      quote(clip(x.body, 1200), "You wrote"),
    ],
    cta: { label: "View the conversation", url: L.support },
  }),

  support_reply: (x, L) => ({
    subject: "Deedwell replied to your support message",
    preheader: clip(x.body, 90),
    eyebrow: "Support",
    heading: "A Deedwell team member replied.",
    blocks: [
      p(`Hi ${first(x.displayName)}, there's a new reply on the **${x.orgName}** support thread:`),
      quote(clip(x.body, 2000), "Deedwell support"),
      p("Reply from your dashboard so the whole thread stays in one place."),
    ],
    cta: { label: "Read and reply", url: L.support },
  }),

  // ---- billing ------------------------------------------------------------
  topup_receipt: (x, L) => ({
    subject: `Receipt: ${x.packageName} pack for ${x.orgName}`,
    preheader: `${fmtTokens(x.tokens)} added to your balance.`,
    eyebrow: "Billing",
    heading: "Thanks — your balance is topped up.",
    blocks: [
      p(`${fmtTokens(x.tokens)} were added to the **${x.orgName}** workspace.${x.resumedRuns > 0 ? ` ${x.resumedRuns === 1 ? "One piece of work that was waiting on tokens has resumed." : `${x.resumedRuns} pieces of work that were waiting on tokens have resumed.`}` : ""}`),
      kv([
        ["Package", x.packageName],
        ["Tokens", fmtTokens(x.tokens)],
        ["Amount", fmtMoney(x.amountCents, x.currency)],
        ...(x.purchasedBy ? [["Purchased by", x.purchasedBy] as [string, string]] : []),
        ["Reference", x.transactionId],
      ]),
    ],
    cta: { label: "View usage and billing", url: L.billing },
    footnote: "Stripe emails a separate payment receipt if you entered an email at checkout. Keep this one for your records.",
  }),

  out_of_tokens: (x, L) => ({
    subject: `${x.orgName} is out of tokens — work is paused`,
    preheader: `${x.what} is waiting until you top up.`,
    eyebrow: "Billing",
    heading: "Your co-workers have paused.",
    blocks: [
      p(`The **${x.orgName}** workspace has run out of tokens, so **${x.what}** stopped before it could finish. Nothing was lost: it resumes automatically the moment the balance is back above zero.`),
      callout("Top up now and paused work restarts on its own within a minute.", "warn"),
    ],
    cta: { label: "Top up tokens", url: L.billing },
  }),

  low_balance: (x, L) => ({
    subject: `${x.orgName} is running low on tokens`,
    preheader: `${fmtTokens(x.tokenBalance)} left. Top up before work pauses.`,
    eyebrow: "Billing",
    heading: "Your token balance is running low.",
    blocks: [
      p(`The **${x.orgName}** workspace has **${fmtTokens(x.tokenBalance)}** left. When it reaches zero, your co-workers pause until you top up. Adding a pack now keeps everything moving.`),
      kv([["Balance", fmtTokens(x.tokenBalance)], ["Smallest pack", "1,000,000 tokens for $10"]]),
    ],
    cta: { label: "Top up tokens", url: L.billing },
    footnote: "You'll only get this reminder once a week while the balance stays low.",
  }),

  billing_exempt: (x, L) => ({
    subject: `Payments waived for ${x.orgName}`,
    preheader: "Your workspace can use Deedwell without a token balance.",
    eyebrow: "Billing",
    heading: "Payments are waived for your workspace.",
    blocks: [
      p(`The Deedwell team has waived payments for **${x.orgName}**. Your co-workers keep working without a token balance, and anything that was paused for lack of tokens has resumed.`),
    ],
    cta: { label: "Open the dashboard", url: L.dashboard },
  }),

  // ---- activity -----------------------------------------------------------
  site_preview_ready: (x, L) => ({
    subject: `Preview ready: ${x.siteName} v${x.version}`,
    preheader: "Take a look, then approve it to publish.",
    eyebrow: "Your website",
    heading: `Version ${x.version} of ${x.siteName} is ready to review.`,
    blocks: [
      p(`Your website team finished building **${x.siteName}** for **${x.orgName}**. It stays in preview until someone approves it, so nothing goes live without you.`),
      ...(x.warnings.length ? [callout(`${x.warnings.length} non-blocking check${x.warnings.length === 1 ? "" : "s"} to be aware of:`, "warn"), list(x.warnings.slice(0, 6))] : [callout("Every quality check passed.", "ok")]),
    ],
    cta: x.previewUrl ? { label: "Open the preview", url: x.previewUrl } : { label: "Review in the dashboard", url: L.website },
    secondaryCta: x.previewUrl ? { label: "Approve or request changes", url: L.website } : undefined,
  }),

  site_build_failed: (x, L) => ({
    subject: `Action needed: ${x.siteName} v${x.version} didn't pass its checks`,
    preheader: "The preview is up so you can see what went wrong.",
    eyebrow: "Your website",
    heading: `Version ${x.version} of ${x.siteName} needs attention.`,
    blocks: [
      p(`The build for **${x.siteName}** finished, but it failed checks that block publishing. The preview is still available so you can see exactly what's wrong.`),
      list(x.blocking.slice(0, 8)),
      p("Ask your website team in chat to fix these and rebuild, or adjust the brief in the dashboard."),
    ],
    cta: x.previewUrl ? { label: "See the preview", url: x.previewUrl } : { label: "Open the dashboard", url: L.website },
    secondaryCta: { label: "Talk to the website team", url: L.chat },
  }),

  site_published: (x, L) => ({
    subject: `${x.siteName} is live`,
    preheader: x.liveUrl ?? "Your website is published.",
    eyebrow: "Your website",
    heading: `${x.siteName} is live.`,
    blocks: [
      p(x.partnerBuilt
        ? `Your new website for **${x.orgName}** has been delivered and published.`
        : `The approved version of **${x.siteName}** is published for **${x.orgName}**.`),
      ...(x.liveUrl ? [kv([["Live address", x.liveUrl]])] : []),
      p("Share it, link it from your social profiles, and if you're pursuing the Google Ad Grant, it's the site Google will review."),
    ],
    cta: x.liveUrl ? { label: "Visit your site", url: x.liveUrl } : { label: "Open the dashboard", url: L.website },
    secondaryCta: { label: "Manage in the dashboard", url: L.website },
  }),

  run_failed: (x, L) => ({
    subject: x.status === "suspended_budget" ? `Paused: ${x.title}` : `Something went wrong with ${x.title}`,
    preheader: x.error ? clip(x.error, 90) : "Your co-workers stopped and need a hand.",
    eyebrow: "Your co-workers",
    heading: x.status === "suspended_budget" ? `${x.title} needs a human to resume it.` : `${x.title} stopped.`,
    blocks: [
      p(x.status === "suspended_budget"
        ? `**${x.title}** for **${x.orgName}** used up its step budget. That's a safety limit, not an error: review progress and resume it from chat.`
        : `**${x.title}** for **${x.orgName}** stopped after repeated attempts.`),
      ...(x.error ? [quote(clip(x.error, 600), "Last error")] : []),
      p("Open the conversation to see where it got to and tell your co-worker how to proceed."),
    ],
    cta: { label: "Open the conversation", url: L.chat },
  }),

  approval_needed: (x, L) => ({
    subject: `${x.agentName} needs your approval: ${x.title}`,
    preheader: `Waiting for you to ${x.nextAction}.`,
    eyebrow: "Approval needed",
    heading: `${x.agentName} is waiting on you.`,
    blocks: [
      p(`Work on **${x.title}** for **${x.orgName}** is paused until you **${x.nextAction}**. Nothing moves forward without your go-ahead.`),
    ],
    cta: { label: "Review and decide", url: L.chat },
  }),

  info_needed: (x, L) => ({
    subject: `${x.agentName} has a question about ${x.title}`,
    preheader: `To continue, ${x.nextAction}.`,
    eyebrow: "Question for you",
    heading: `${x.agentName} needs a little more from you.`,
    blocks: [
      p(`To keep going on **${x.title}** for **${x.orgName}**, please **${x.nextAction}**. The work resumes as soon as you answer.`),
    ],
    cta: { label: "Answer in chat", url: L.chat },
  }),

  grant_package_ready: (x, L) => ({
    subject: `Ready to submit: ${x.opportunityTitle}`,
    preheader: "Your full application package is exported.",
    eyebrow: "Grants",
    heading: "Your application package is ready.",
    blocks: [
      p(`The application for **${x.opportunityTitle}**${x.funder ? ` (${x.funder})` : ""} is complete for **${x.orgName}**. The package includes the narrative in Markdown, DOCX and PDF plus the budget as CSV.`),
      p("Download it from Artifacts, give it a final read, and submit through the funder's portal."),
    ],
    cta: { label: "Open Artifacts", url: `${L.dashboard}/artifacts` },
  }),

  content_campaign_finished: (x, L) => ({
    subject: x.status === "ready" ? `Your designs are ready: ${x.title}` : `Couldn't finish the designs for ${x.title}`,
    preheader: x.status === "ready" ? "Review, approve and schedule them in Content Studio." : (x.error ? clip(x.error, 90) : "Try a different brief or ask the designer in chat."),
    eyebrow: "Content Studio",
    heading: x.status === "ready" ? `${x.title} is ready to review.` : `${x.title} didn't finish.`,
    blocks: x.status === "ready"
      ? [p(`Your designer finished the **${x.title}** campaign for **${x.orgName}**. Review each design, approve the ones you like, and schedule them to your connected accounts.`)]
      : [p(`The designer couldn't complete **${x.title}** for **${x.orgName}**.`), ...(x.error ? [quote(clip(x.error, 400), "What went wrong")] : []), p("Try again from Content Studio, or ask the designer in chat for a different approach.")],
    cta: { label: "Open Content Studio", url: L.content },
  }),

  post_failed: (x, L) => ({
    subject: `A scheduled ${x.platform} post didn't publish`,
    preheader: clip(x.error, 90),
    eyebrow: "Content Studio",
    heading: `Your ${x.platform} post didn't go out.`,
    blocks: [
      p(`A post scheduled for **${x.orgName}**${x.accountName ? ` on **${x.accountName}**` : ""}${x.scheduledAt ? ` at ${fmtWhen(x.scheduledAt)}` : ""} could not be published.`),
      quote(clip(x.error, 400), "Reason"),
      quote(clip(x.content, 300), "Post"),
      p("If the connection expired, reconnect the account and reschedule the post."),
    ],
    cta: { label: "Check connected accounts", url: L.connectors },
    secondaryCta: { label: "Open Content Studio", url: L.content },
  }),

  connector_attention: (x, L) => ({
    subject: `Reconnect ${x.accountName ?? x.provider} to keep publishing`,
    preheader: x.detail ?? "The connection needs your attention.",
    eyebrow: "Connected accounts",
    heading: `${x.accountName ?? x.provider} needs to be reconnected.`,
    blocks: [
      p(`The **${x.provider}** connection${x.accountName ? ` for **${x.accountName}**` : ""} in the **${x.orgName}** workspace stopped working. Scheduled posts and uploads to it will fail until it's reconnected.`),
      ...(x.detail ? [callout(x.detail, "warn")] : []),
      p("Reconnecting takes about a minute: open Connected accounts and choose Reconnect."),
    ],
    cta: { label: "Reconnect now", url: L.connectors },
  }),

  form_submission: (x, L) => ({
    subject: `New ${x.formKey === "contact" ? "contact" : x.formKey} message from your website`,
    preheader: x.fields.map(([, v]) => v).find((v) => v.length > 12)?.slice(0, 90) ?? "Someone reached out through your site.",
    eyebrow: "Your website",
    heading: `Someone wrote to ${x.orgName} through ${x.siteName}.`,
    blocks: [
      p(`A visitor submitted the **${x.formKey}** form on your website. Here's what they sent:`),
      kv(x.fields.slice(0, 12).map(([k, v]) => [k.replace(/_/g, " "), clip(v, 1500)] as [string, string])),
      p("Reply directly to the visitor; this notification came from Deedwell, not from them."),
    ],
    cta: { label: "See all submissions", url: L.website },
  }),

  ad_grants_review: (x, L) => ({
    subject: x.status === "approved" ? "Google approved your Ad Grants application" : "Google needs changes to your Ad Grants application",
    preheader: x.status === "approved" ? "Your co-workers are activating the grant now." : (x.reason ?? "Your co-workers have a plan to address it."),
    eyebrow: "Google Ad Grants",
    heading: x.status === "approved" ? `Congratulations — ${x.orgName} is approved.` : "Google asked for changes.",
    blocks: x.status === "approved"
      ? [p(`Google reviewed **${x.orgName}**'s application and approved it. Your co-workers are activating the Ad Grants account and preparing the first campaign; you'll hear from them when it's ready to publish.`)]
      : [p(`Google reviewed **${x.orgName}**'s application and didn't approve it yet.`), ...(x.reason ? [quote(x.reason, "Google's reason")] : []), p("Your co-workers have paused with a proposed fix. Open the Ad Grants page to review it and decide how to proceed.")],
    cta: { label: "Open Ad Grants", url: L.adGrants },
  }),

  ad_grants_reconnect: (x, L) => ({
    subject: "Reconnect Google to continue your Ad Grants application",
    preheader: `Paused at: ${x.step.replace(/_/g, " ")}.`,
    eyebrow: "Google Ad Grants",
    heading: "Your Google session expired.",
    blocks: [
      p(`The Google session your co-workers use for **${x.orgName}**'s Ad Grants application expired while they were working on **${x.step.replace(/_/g, " ")}**. The application is safely paused.`),
      p("Sign in to Google again from the Ad Grants page and the work picks up exactly where it stopped."),
    ],
    cta: { label: "Reconnect Google", url: L.adGrants },
  }),

  ad_grants_live: (x, L) => ({
    subject: `Your first Google Ads campaign is live`,
    preheader: "Grant-funded ads are now running.",
    eyebrow: "Google Ad Grants",
    heading: `${x.orgName}'s campaign is live.`,
    blocks: [
      p(`Your co-workers published the first Google Ads campaign for **${x.orgName}**, funded by your Ad Grant.${x.campaignId ? ` Campaign ID: ${x.campaignId}.` : ""}`),
      p("They'll keep it compliant with Google's grant policies and report back as results come in."),
    ],
    cta: { label: "Open Ad Grants", url: L.adGrants },
  }),

  task_approval_requested: (x, L) => ({
    subject: `${x.agentName} needs your go-ahead: ${x.taskTitle}`,
    preheader: "Approve when you're ready, or reject to skip it.",
    eyebrow: "Tasks",
    heading: `${x.agentName} is ready to start.`,
    blocks: [
      p(`Before starting **${x.taskTitle}** for **${x.orgName}**, ${x.agentName} needs your approval. Approve it to begin, or reject it to skip this run.`),
    ],
    cta: { label: "Review the task", url: L.tasks },
  }),

  task_completed: (x, L) => ({
    subject: `Done: ${x.taskTitle}`,
    preheader: clip(x.summary, 90),
    eyebrow: "Tasks",
    heading: x.runNumber && x.runNumber > 1 ? `Run #${x.runNumber} of ${x.taskTitle} is done.` : `${x.taskTitle} is done.`,
    blocks: [
      p(`${x.agentName} finished **${x.taskTitle}** for **${x.orgName}**.`),
      quote(clip(x.summary, 1200), x.agentName),
      ...(x.deliverables.length ? [p("Deliverables:"), list(x.deliverables.slice(0, 10))] : []),
      ...(x.nextRunAt ? [callout(`Next run: ${fmtWhen(x.nextRunAt)}.`)] : []),
    ],
    cta: { label: "Open the task", url: L.tasks },
  }),

  task_failed: (x, L) => ({
    subject: `Couldn't finish: ${x.taskTitle}`,
    preheader: clip(x.error, 90),
    eyebrow: "Tasks",
    heading: `${x.agentName} couldn't finish ${x.taskTitle}.`,
    blocks: [
      p(`After several attempts, **${x.taskTitle}** for **${x.orgName}** couldn't be completed.`),
      quote(clip(x.error, 500), "Reason"),
      p("Once the underlying issue is sorted, retry it from Tasks."),
    ],
    cta: { label: "Open Tasks", url: L.tasks },
  }),

  task_needs_input: (x, L) => ({
    subject: `${x.agentName} has a question about ${x.taskTitle}`,
    preheader: clip(x.question, 90),
    eyebrow: "Tasks",
    heading: `Quick question from ${x.agentName}.`,
    blocks: [
      p(`To finish **${x.taskTitle}** for **${x.orgName}**, ${x.agentName} needs an answer:`),
      quote(clip(x.question, 800), x.agentName),
    ],
    cta: { label: "Answer in chat", url: L.chat },
  }),

  teammate_message: (x, L) => ({
    subject: `${x.agentName}: ${clip(x.message.replace(/\s+/g, " "), 60)}`,
    preheader: clip(x.message, 90),
    eyebrow: "Message from your co-worker",
    heading: `${x.agentName} left you a note.`,
    blocks: [
      quote(clip(x.message, 2000), `${x.agentName}, ${x.agentRole}`),
      p(`Reply in the ${x.orgName} workspace to keep the conversation going.`),
    ],
    cta: { label: "Reply in chat", url: L.chat },
  }),

  unread_digest: (x, L) => ({
    subject: `${x.total} unread ${x.total === 1 ? "message" : "messages"} from your co-workers`,
    preheader: x.channels.map((c) => `${c.name} (${c.count})`).join(", "),
    eyebrow: "While you were away",
    heading: `${first(x.displayName)}, your co-workers have been busy.`,
    blocks: [
      p(`You have **${x.total} unread ${x.total === 1 ? "message" : "messages"}** in the **${x.orgName}** workspace:`),
      kv(x.channels.slice(0, 10).map((c) => [c.name, `${c.count} unread`] as [string, string])),
    ],
    cta: { label: "Catch up", url: L.chat },
    footnote: "You'll get at most one of these every 12 hours, and only when you've been away.",
  }),

  // ---- ops ----------------------------------------------------------------
  ops_alert: (x, L) => ({
    subject: `[Deedwell] ${x.title}`,
    eyebrow: "Platform alert",
    heading: x.title,
    blocks: [
      ...(x.body ? [callout(x.body, x.tone ?? "info")] : []),
      kv(x.rows),
    ],
    cta: { label: "Open Platform Admin", url: `${L.dashboard}/admin` },
  }),
};

export function renderTemplate<K extends EmailKind>(kind: K, payload: EmailPayloads[K], cfg: Pick<EmailConfig, "appOrigin" | "coworkersOrigin">): EmailDoc {
  const fn = templates[kind] as Renderer<K> | undefined;
  if (!fn) throw new Error(`Unknown email template "${kind}"`);
  return fn(payload, linksFor(cfg));
}
