// The OAuth connect page: sign in with Privy, let our server sign x402
// payments from your embedded wallet (within a Privy policy), then hand the
// grant back to the MCP client.

import { PrivyProvider, usePrivy, useSigners, type WalletWithMetadata } from "@privy-io/react-auth";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { baseSepolia } from "viem/chains";

interface Session {
  clientName: string;
  privyAppId: string;
  signerId: string;
  policyId: string;
  maxPerCallUsd: string;
  dailyBudgetUsd: string;
}

const req = new URLSearchParams(location.search).get("req");

function Connect({ session }: { session: Session }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { addSigners } = useSigners();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The Privy embedded wallet, not an external wallet the user may have signed in with.
  const address = user?.linkedAccounts.find(
    (a): a is WalletWithMetadata => a.type === "wallet" && a.walletClientType === "privy" && a.chainType === "ethereum",
  )?.address;

  async function allow() {
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      try {
        await addSigners({ address, signers: [{ signerId: session.signerId, policyIds: [session.policyId] }] });
      } catch (e) {
        // Already added on an earlier connect; the server checks for real.
        console.warn("addSigners", e);
      }
      const res = await fetch("/authorize/complete", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await getAccessToken()}` },
        body: JSON.stringify({ req }),
      });
      const body = (await res.json()) as { redirectTo?: string; error?: string };
      if (!res.ok || !body.redirectTo) throw new Error(body.error ?? `HTTP ${res.status}`);
      location.href = body.redirectTo;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (!ready) return <p>Loading…</p>;
  if (!authenticated) {
    return (
      <>
        <h1>Connect {session.clientName}</h1>
        <p>Sign in to get a wallet that pays for APIs on the x402 gateway, one call at a time, in USDC on Base Sepolia.</p>
        <button onClick={login}>Sign in</button>
      </>
    );
  }
  return (
    <>
      <h1>Allow {session.clientName} to pay</h1>
      <div className="wallet">
        <p style={{ margin: 0 }}>Your wallet</p>
        <code>{address ?? "creating…"}</code>
      </div>
      <ul>
        <li>Only USDC payments on Base Sepolia, up to ${session.maxPerCallUsd} each</li>
        <li>At most ${session.dailyBudgetUsd} per 24 hours</li>
        <li>You're only charged when the API call succeeds</li>
      </ul>
      <p>
        Fund it with test USDC from the <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Circle faucet</a> (Base
        Sepolia). No ETH needed.
      </p>
      <button onClick={allow} disabled={busy || !address}>
        {busy ? "Connecting…" : "Allow payments"}
      </button>
      <button className="secondary" onClick={logout} disabled={busy}>
        Use a different account
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/authorize/session?req=${encodeURIComponent(req ?? "")}`)
      .then(async (r) => (r.ok ? setSession(await r.json()) : setError("This sign-in link expired. Start again from your MCP client.")))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!session) return <p>Loading…</p>;
  return (
    <PrivyProvider
      appId={session.privyAppId}
      config={{
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
        defaultChain: baseSepolia,
        supportedChains: [baseSepolia],
      }}
    >
      <Connect session={session} />
    </PrivyProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <App />
    </main>
  </StrictMode>,
);
