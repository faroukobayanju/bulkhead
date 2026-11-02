// Wrap any agent action in a firewall check. Runs in browsers: no imports, no node: APIs.
export type Verdict = { verdict: "allow" | "escalate" | "block"; risk: number; reason: string };
export async function guardedCall<T>(o: {
  check: () => Promise<Verdict>;
  act: () => Promise<T>;
  askHuman: (v: Verdict) => Promise<boolean>;
}): Promise<{ done: true; result: T } | { done: false; verdict: Verdict }> {
  const v = await o.check();
  if (v.verdict === "block") return { done: false, verdict: v };
  if (v.verdict === "escalate" && !(await o.askHuman(v))) return { done: false, verdict: v };
  return { done: true, result: await o.act() };
}
