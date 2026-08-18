import { runAgentTask, type ModelProvider } from "@deedwell/agent-runtime";
import type { FactExtractionOutput } from "@deedwell/schemas";
import { factExtractor } from "./agents.js";

/**
 * Reads real evidence-document text and proposes organizational facts, each
 * citing the exact line/quote it came from. This is the only path allowed to
 * produce status "verified" facts — see facts.ts writeOrgFact.
 */
export async function extractFactsFromDocument(
  provider: ModelProvider,
  documentText: string
): Promise<FactExtractionOutput & { tokensEstimated: number }> {
  const result = await runAgentTask<FactExtractionOutput>(
    provider,
    factExtractor,
    "Extract organizational facts from the attached evidence document.",
    [{ label: "document", content: documentText.slice(0, 40_000) }]
  );
  return { ...result.output, tokensEstimated: result.tokensEstimated };
}
