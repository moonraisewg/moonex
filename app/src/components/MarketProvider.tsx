"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useSearchParams } from "next/navigation";

import { MARKET as DEFAULT_MARKET, type MarketConfig } from "@/lib/market";
import { fetchMarketConfig } from "@/lib/marketSource";

interface Ctx {
  market: MarketConfig;
  loading: boolean;
  error: string | null;
}

const MarketCtx = createContext<Ctx>({
  market: DEFAULT_MARKET,
  loading: false,
  error: null,
});

export function useMarket(): MarketConfig {
  return useContext(MarketCtx).market;
}

export function useMarketCtx(): Ctx {
  return useContext(MarketCtx);
}

/** Reads `?market=<addr>` from the URL and hydrates a full MarketConfig
 *  from chain. Falls back to the bundled default when the param is
 *  missing or matches the build-time market. */
export function MarketProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const search = useSearchParams();
  const [state, setState] = useState<Ctx>({
    market: DEFAULT_MARKET,
    loading: false,
    error: null,
  });

  useEffect(() => {
    const raw = search?.get("market");
    if (!raw || raw === DEFAULT_MARKET.market.toBase58()) {
      setState({ market: DEFAULT_MARKET, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      try {
        const cfg = await fetchMarketConfig(connection, new PublicKey(raw));
        if (!cancelled) setState({ market: cfg, loading: false, error: null });
      } catch (e) {
        if (!cancelled)
          setState({
            market: DEFAULT_MARKET,
            loading: false,
            error: (e as Error).message,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search, connection]);

  return <MarketCtx.Provider value={state}>{children}</MarketCtx.Provider>;
}
