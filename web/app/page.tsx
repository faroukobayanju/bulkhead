import { ArrowRight } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { Home } from "@/components/Home";
import { isMock, loadArena } from "@/lib/arena";
import { FwStat } from "@/components/FwStat";
import { GENERAL_EVAL } from "@/lib/content";
import { loadPublic } from "@/lib/public-data";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [arena, pub] = await Promise.all([loadArena(), loadPublic()]);
  const live = !isMock() && !!process.env.NEXT_PUBLIC_CONVEX_URL;
  return (
    <>
      <section className="hero">
        <div className="stack">
          <h1>An AI firewall for agents that hold money, proven on a live pot.</h1>
          <p className="muted">Each AI guard watches a pot of coins on Bitcoin or Base. A NEAR contract signs for those coins and caps every payout. Talk a guard into paying you and the payout is yours.</p>
        </div>
        <FwStat />
      </section>

      <div className="section" style={{ marginTop: 40 }}>
        <Home arena={arena} pub={pub} live={live} />
      </div>

      <section className="section split" aria-labelledby="fw-h">
        <div className="stack">
          <h2 id="fw-h">Put the same firewall in front of your agent</h2>
          <p className="muted">
            One HTTP call before your agent acts. In general mode, where you send your own tools and rules, 80 held-out cases: it stopped {GENERAL_EVAL.summary.attacksStopped} attacks and allowed {GENERAL_EVAL.summary.legitAllowed} legitimate requests.
          </p>
        </div>
        <div className="row" style={{ alignSelf: "end" }}>
          <Link href="/firewall" className="btn">
            Firewall API <ArrowRight size={16} weight="bold" aria-hidden="true" />
          </Link>
        </div>
      </section>
    </>
  );
}
