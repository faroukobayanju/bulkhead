// Login lookup (E22): a key may log in as an account only if it is a FullAccess key on it. view_access_key also succeeds for
// FunctionCall keys, which a limited dapp key must not turn into a login. A missing key is `false`; anything else that goes
// wrong (RPC down, timeout, an answer we do not understand) throws, so the caller answers 503 and never "key_not_on_account".
const RPC_TIMEOUT_MS = 10_000; // well under the 60 s nonce skew, so a stalled lookup cannot outlive replay protection

export function makeViewAccessKey(o: { fetch: typeof fetch; rpcUrl: string; timeoutMs?: number }) {
  return async function viewAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    const res = await o.fetch(o.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "bulkhead", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }),
      signal: AbortSignal.timeout(o.timeoutMs ?? RPC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const body: any = await res.json();
    const name = body?.error?.cause?.name;
    if (name === "UNKNOWN_ACCESS_KEY" || name === "UNKNOWN_ACCOUNT") return false;
    if (body?.error) throw new Error(`rpc error ${name ?? body.error.name ?? "unknown"}`);
    const r = body?.result;
    // older nodes answer 200 with result.error for a missing key
    if (typeof r?.error === "string" && /does not exist/.test(r.error)) return false;
    if (typeof r?.error === "string" || r === undefined || r === null) throw new Error("rpc: unexpected answer");
    return r.permission === "FullAccess";
  };
}
