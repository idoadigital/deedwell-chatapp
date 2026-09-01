export interface TokenPackage {
  id: string;
  label: string;
  priceCents: number;
  tokens: number;
}

// Prepaid top-up tiers. Round numbers, deliberately not tied to any one
// model provider's real per-token cost — MODEL_PROVIDER=mock has none, and
// the real providers' pricing differs — revisit once a provider's pricing
// is locked in for production.
export const TOKEN_PACKAGES: TokenPackage[] = [
  { id: "starter", label: "Starter", priceCents: 1_000, tokens: 1_000_000 },
  { id: "standard", label: "Standard", priceCents: 4_000, tokens: 5_000_000 },
  { id: "team", label: "Team", priceCents: 15_000, tokens: 25_000_000 },
];

export function findPackage(id: string): TokenPackage | undefined {
  return TOKEN_PACKAGES.find((p) => p.id === id);
}
