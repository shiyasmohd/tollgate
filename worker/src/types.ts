import type { EndpointRow } from "./db";

export type Address = `0x${string}`;

/** The upstream outcome of a paid request, set by the proxy handler for recordCall. */
export interface UpstreamOutcome {
  status: number;
  latencyMs: number;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    seller: Address;
    endpoint: EndpointRow;
    upstreamBody: string | null;
    upstream: UpstreamOutcome;
  };
}
