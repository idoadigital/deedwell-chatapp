import type { ModelRequest } from "./index.js";
import type { IntentOutput } from "@deedwell/schemas";

/**
 * MOCK intent router (see mock-provider.ts banner). Rule-based understanding
 * of the core workspace phrases; anything else gets an honest "clarify".
 * The OpenAI provider replaces this with real language understanding.
 */

export interface AssistantContext {
  orgName: string;
  channelKind: "team" | "project";
  projectType: string | null;
  lastSearchResults: Array<{ index: number; title: string; number?: string | null; sourceUrl?: string }>;
  pendingIntent?: {
    projectId?: string; grantTitle?: string; opportunityNumber?: string | null;
    sourceUrl?: string | null; type?: string;
  } | null;
  lastAssistantRequest?: string | null;
  lastUploadedFileId: string | null;
  pendingApprovals: Array<{ id: string; kind: string }>;
  waitingRuns: Array<{ id: string; status: string; missingFacts: string[] }>;
  hasSite: boolean;
  knownUrls?: Record<string, string>;
  knownArtifacts?: Array<{ id: string; type: string; title: string }>;
}

export function mockIntent(request: ModelRequest): IntentOutput {
  const text = request.dataBlocks.find((b) => b.label === "user_message")?.content?.trim() ?? "";
  let ctx: AssistantContext;
  try {
    ctx = JSON.parse(request.dataBlocks.find((b) => b.label === "context")?.content ?? "{}");
  } catch {
    ctx = {
      orgName: "", channelKind: "team", projectType: null, lastSearchResults: [],
      lastUploadedFileId: null, pendingApprovals: [], waitingRuns: [], hasSite: false,
    };
  }
  const lower = text.toLowerCase();

  // Missing-info replies: "annual_budget: $420,000" style lines.
  const missingKeys = new Set(ctx.waitingRuns?.flatMap((r) => r.missingFacts ?? []) ?? []);
  const factLines = [...text.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9_ ]{1,40})\s*[:=]\s*(.+?)\s*$/gm)]
    .map((m) => ({ key: m[1]!.trim().toLowerCase().replace(/\s+/g, "_"), value: m[2]!.trim() }))
    .filter((f) => f.value.length > 0);
  if (factLines.length && (missingKeys.size === 0 || factLines.some((f) => missingKeys.has(f.key)))) {
    if (missingKeys.size > 0) return { action: "provide_info", facts: factLines };
  }

  if (/\b(find|search|look(ing)? for|discover)\b/.test(lower) && /\b(grant|fund|opportunit)/.test(lower)) {
    const afterFor = text.match(/\bfor\s+(?:our\s+|the\s+|a\s+)?(.{3,80}?)(?:\.|$)/i)?.[1];
    const keyword = (afterFor ?? lower
      .replace(/\b(please|can you|could you|find|search|look(ing)? for|discover|grants?|funding|opportunit(y|ies))\b/g, " ")
      .replace(/\s+/g, " ")
      .trim())
      .replace(/\bprograms?\b\s*$/, "")
      .trim();
    return { action: "search_grants", keyword: keyword.length >= 2 ? keyword : "nonprofit" };
  }

  const applyMatch = lower.match(/\b(apply|start|go)\b[^#\d]*#?\s*(\d{1,2})/);
  if (applyMatch && ctx.lastSearchResults?.length) {
    return { action: "start_grant_application", resultIndex: Number(applyMatch[2]) };
  }
  // Ordinal words resolve against the most recent result set immediately.
  const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  const ordinal = lower.match(/\b(apply|start|use|open)\b.*\b(first|second|third|fourth|fifth|last)\b/);
  if (ordinal && ctx.lastSearchResults?.length) {
    const n = ordinal[2] === "last" ? ctx.lastSearchResults.length : ORDINALS[ordinal[2]!]!;
    return { action: "start_grant_application", resultIndex: n };
  }

  // Follow-ups about a requested document resolve against the active saved
  // application — never a generic "which document do you mean?" (spec §7–§9).
  const pending = ctx.pendingIntent;
  if (pending?.grantTitle &&
      /\b(where|how)\b.*\b(find|get|download|locate)\b.*\b(announcement|document|file|it)\b/.test(lower)) {
    const num = pending.opportunityNumber ? `, opportunity ${pending.opportunityNumber}` : "";
    const link = pending.sourceUrl ? ` Open the details link beside that grant (${pending.sourceUrl}) and look for the funding announcement or application package section.` : " Check the funder's opportunity page for the funding announcement or application package.";
    return {
      action: "answer",
      text: `You mean the announcement for "${pending.grantTitle}"${num} — the document I asked you to upload.${link} Download the PDF, Word, HTML, or text version and upload it here. Your application selection is already saved, so I'll continue automatically once it arrives.`,
    };
  }
  // "apply for it / that grant": one active candidate → act; several → name them.
  if (/\b(apply|go ahead|start)\b.*\b(it|that( grant)?|this( grant)?)\b/.test(lower)) {
    if (pending?.grantTitle) {
      return {
        action: "answer",
        text: `"${pending.grantTitle}"${pending.opportunityNumber ? ` (${pending.opportunityNumber})` : ""} is already saved as your active application — it's waiting on the announcement document. Upload it here and I'll continue automatically.`,
      };
    }
    if (ctx.lastSearchResults?.length === 1) {
      return { action: "start_grant_application", resultIndex: 1 };
    }
    if ((ctx.lastSearchResults?.length ?? 0) > 1) {
      const names = ctx.lastSearchResults.slice(0, 2).map((r) => `"${r.title}"`).join(" or ");
      return { action: "clarify", question: `Do you mean ${names}? Say "apply for #N" with the number you want.` };
    }
  }

  // Memory recall: the agent must never ask for links it generated itself.
  if (/\b(link|url|preview|website|site)\b/.test(lower) &&
      /\b(you (built|created|made|gave)|the website|what.*(build|built)|open|show me|where)\b/.test(lower) &&
      ctx.knownUrls && Object.keys(ctx.knownUrls).length > 0) {
    const entries = Object.entries(ctx.knownUrls);
    const live = entries.find(([k]) => k.endsWith("_live"));
    const preview = entries.find(([k]) => k.endsWith("_preview"));
    const parts = [];
    if (live) parts.push(`live site: ${live[1]}`);
    if (preview) parts.push(`preview: ${preview[1]}`);
    return {
      action: "answer",
      text: `I found it in the project's artifact registry — ${parts.join(" · ")}. I can update it, republish, or roll it back; just say the word.`,
    };
  }

  if (/\b(build|create|make|set ?up)\b/.test(lower) && /\b(web ?site|web ?page|site)\b/.test(lower)) {
    if (ctx.hasSite && ctx.knownUrls && Object.keys(ctx.knownUrls).length > 0) {
      const first = Object.values(ctx.knownUrls)[0];
      return {
        action: "answer",
        text: `This project already has a website (${first}). Tell me what to change and Noah will patch it — or say "build a new website" in a fresh project if you want to start over.`,
      };
    }
    return { action: "build_website", siteName: null };
  }

  if (/\b(approve[d]?|publish it|go ahead|ship it|looks good|lgtm|yes do it)\b/.test(lower) && ctx.pendingApprovals?.length) {
    return { action: "approve", note: null };
  }
  if (/\b(reject|decline|don'?t (publish|apply|pursue)|do not (publish|apply|pursue)|send it back)\b/.test(lower) && ctx.pendingApprovals?.length) {
    return { action: "reject", note: null };
  }

  if (/\b(social (media )?(post|image|graphic|content)|instagram|facebook post|linkedin post|flyer|event (graphic|promo|poster)|buying guide)\b/.test(lower)
    && /\b(create|make|design|generate|draw|produce|need|want)\b/.test(lower)) {
    const kind = /flyer/.test(lower) ? "flyer" : /buying guide|guide cover/.test(lower) ? "buying_guide" : /event/.test(lower) ? "event_promo" : "social";
    return { action: "create_content", kind, prompt: text };
  }

  if (ctx.hasSite && /\b(change|update|add|remove|replace|rename|rewrite|make the)\b/.test(lower)) {
    return { action: "update_website", instruction: text };
  }

  if (/\b(status|progress|update me|what('| i)s (happening|going on)|show me .*(project|run|work))\b/.test(lower)) {
    return { action: "status" };
  }

  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(lower)) {
    return {
      action: "answer",
      text: `Hello! I'm Maya, your Executive Assistant. I can search for grants ("find grants for youth programs"), start applications, build and update your website, and route approvals. What would you like to work on?`,
    };
  }
  if (/\bwhat can you do|help\b/.test(lower)) {
    return {
      action: "answer",
      text: `I coordinate your AI team. Try: "find grants for <your program>", "apply for #1", "build our website", "change the tagline to \\"…\\"", "status", or answer my questions when the team needs information. Sensitive steps always come back to you for approval.`,
    };
  }

  return {
    action: "clarify",
    question:
      "I couldn't map that to an action I can take. [mock router — with a real model provider I'd understand free-form requests] Try: \"find grants for …\", \"apply for #N\", \"build our website\", \"change the tagline to '…'\", or \"status\".",
  };
}
