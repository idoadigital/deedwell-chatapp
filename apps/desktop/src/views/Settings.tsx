import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { BillingTransactionRow, TokenPackage, UsageSummary } from "../api";
import type { Organization } from "../types";
import { Icon } from "../components/Icon";

function fmt(n: number): string {
  return n.toLocaleString();
}

function UsageTab({ org }: { org: Organization }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getUsageSummary(org.id)
      .then((r) => { if (!cancelled) setSummary(r); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load usage"); });
    return () => { cancelled = true; };
  }, [org.id]);

  if (error) return <p className="error-text" role="alert">{error}</p>;
  if (!summary) return <p className="faint">Loading…</p>;

  return (
    <>
      <div className="card">
        <h2>Token usage — this month</h2>
        <p className="muted">Chat responses and everything the automation teammates do — grant writing, website building, Ad Grants — all draw from the same usage.</p>
        <div className="row" style={{ gap: 24, marginTop: 10 }}>
          <div>
            <div className="faint">Chat</div>
            <strong style={{ fontSize: "1.4rem" }}>{fmt(summary.bySource.chat.thisMonth)}</strong>
          </div>
          <div>
            <div className="faint">Automation</div>
            <strong style={{ fontSize: "1.4rem" }}>{fmt(summary.bySource.workflow.thisMonth)}</strong>
          </div>
          <div>
            <div className="faint">Total</div>
            <strong style={{ fontSize: "1.4rem" }}>{fmt(summary.totals.thisMonth.modelTokens)}</strong>
          </div>
        </div>
      </div>
      <div className="card">
        <h2>All-time</h2>
        <div className="row" style={{ gap: 24, marginTop: 10 }}>
          <div>
            <div className="faint">Chat</div>
            <strong>{fmt(summary.bySource.chat.allTime)}</strong>
          </div>
          <div>
            <div className="faint">Automation</div>
            <strong>{fmt(summary.bySource.workflow.allTime)}</strong>
          </div>
          <div>
            <div className="faint">Total tokens</div>
            <strong>{fmt(summary.totals.allTime.modelTokens)}</strong>
          </div>
        </div>
      </div>
    </>
  );
}

function BillingTab({ org, banner, onDismissBanner }: { org: Organization; banner: "success" | "cancel" | null; onDismissBanner: () => void }) {
  const [balance, setBalance] = useState<{ tokenBalance: number; configured: boolean } | null>(null);
  const [packages, setPackages] = useState<TokenPackage[] | null>(null);
  const [transactions, setTransactions] = useState<BillingTransactionRow[] | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canBuy = org.role === "admin" || org.role === "owner";

  const refresh = useCallback(() => {
    api.getBillingBalance(org.id).then(setBalance).catch((err) => setError(err instanceof Error ? err.message : "Could not load balance"));
    api.getBillingPackages(org.id).then((r) => setPackages(r.packages)).catch(() => undefined);
    api.getBillingTransactions(org.id).then((r) => setTransactions(r.transactions)).catch(() => undefined);
  }, [org.id]);
  useEffect(refresh, [refresh]);

  async function buy(packageId: string) {
    setBuying(packageId);
    setError(null);
    try {
      const { url } = await api.startCheckout(org.id, packageId);
      window.location.href = url;
    } catch (err) {
      setBuying(null);
      setError(err instanceof Error ? err.message : "Could not start checkout");
    }
  }

  return (
    <>
      {banner && (
        <div className="card" style={{ borderColor: banner === "success" ? "var(--accent, #2f6f4f)" : undefined }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <span>{banner === "success" ? "Payment received — your balance has been updated." : "Checkout cancelled — no charge was made."}</span>
            <button className="ghost" onClick={onDismissBanner}><Icon name="x" size={14} /></button>
          </div>
        </div>
      )}
      <div className="card">
        <h2>Token balance</h2>
        {!balance ? (
          <p className="faint">Loading…</p>
        ) : !balance.configured ? (
          <p className="muted">Billing isn't configured yet — an admin needs to set up Payments in Platform Admin first.</p>
        ) : (
          <strong style={{ fontSize: "1.6rem" }}>{fmt(balance.tokenBalance)} tokens</strong>
        )}
      </div>
      {balance?.configured && (
        <div className="card">
          <h2>Buy more</h2>
          {!canBuy && <p className="faint">Ask an admin to buy more tokens for this workspace.</p>}
          <div className="row" style={{ gap: 12, marginTop: 10, flexWrap: "wrap" }}>
            {packages?.map((pkg) => (
              <div key={pkg.id} className="card" style={{ flex: "1 1 160px" }}>
                <strong>{pkg.label}</strong>
                <p className="faint">{fmt(pkg.tokens)} tokens</p>
                <button
                  className="primary"
                  disabled={!canBuy || buying !== null}
                  onClick={() => buy(pkg.id)}
                  style={{ marginTop: 8 }}
                >
                  {buying === pkg.id ? "Redirecting…" : `$${(pkg.priceCents / 100).toFixed(0)}`}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      {transactions && transactions.length > 0 && (
        <div className="card">
          <h2>History</h2>
          <div className="field" style={{ marginTop: 10 }}>
            {transactions.map((t) => (
              <div className="row" key={t.id} style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <span>
                  <strong>{fmt(t.tokenAmount)} tokens</strong>
                  <br />
                  <span className="faint">${(t.amountCents / 100).toFixed(2)} · {new Date(t.createdAt).toLocaleDateString()}</span>
                </span>
                <span className="faint">{t.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export function SettingsView({
  org, tab, onTabChange, billingBanner, onDismissBanner,
}: {
  org: Organization;
  tab: "usage" | "billing";
  onTabChange: (tab: "usage" | "billing") => void;
  billingBanner: "success" | "cancel" | null;
  onDismissBanner: () => void;
}) {
  return (
    <>
      <div className="seg-control" role="tablist" aria-label="Settings sections">
        <button role="tab" aria-selected={tab === "usage"} className={`seg-btn ${tab === "usage" ? "active" : ""}`} onClick={() => onTabChange("usage")}>
          Usage
        </button>
        <button role="tab" aria-selected={tab === "billing"} className={`seg-btn ${tab === "billing" ? "active" : ""}`} onClick={() => onTabChange("billing")}>
          Billing
        </button>
      </div>
      <div style={{ marginTop: 16 }}>
        {tab === "usage" ? <UsageTab org={org} /> : <BillingTab org={org} banner={billingBanner} onDismissBanner={onDismissBanner} />}
      </div>
    </>
  );
}
