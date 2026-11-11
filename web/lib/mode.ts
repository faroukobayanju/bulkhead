// MOCK_AGENT=1 serves fixtures as if they were the arena. That must never reach players: it refuses to run in Vercel production
// or on mainnet. Called at server start (instrumentation.ts) and on every isMock() read.
type Env = Record<string, string | undefined>;

export function checkMode(env: Env = process.env): boolean {
  if (env.MOCK_AGENT !== "1") return false;
  if (env.VERCEL_ENV === "production" || env.NEXT_PUBLIC_NETWORK === "mainnet") {
    throw new Error("MOCK_AGENT=1 serves fixture data and is refused in production and on mainnet. Unset MOCK_AGENT.");
  }
  return true;
}
