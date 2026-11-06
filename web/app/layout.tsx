import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import { ConvexRoot } from "@/components/Live";
import { Nav } from "@/components/Nav";
import { isMock, network } from "@/lib/arena";
import "./globals.css";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Drain Me · Bulkhead", template: "%s · Drain Me" },
  description: "Three AI guards hold real coins. Talk one into paying you. Bulkhead's firewall and spending cap are what stop them.",
};
export const viewport: Viewport = { themeColor: "#0E1A24", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const net = network();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="site-header">
          <div className="inner">
            <Link href="/" className="brand" aria-label="Drain Me, home">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/wordmark-bone.svg" alt="Bulkhead" width={116} height={22} />
            </Link>
            <span className="net" title="The NEAR network this site reads">
              NEAR {net}
              {isMock() ? ", demo data" : ""}
            </span>
            <Nav />
          </div>
        </header>
        <main id="main">
          <ConvexRoot>{children}</ConvexRoot>
        </main>
        <footer className="site-footer">
          <div className="inner">
            <span>Drain Me is the live arena for Bulkhead.</span>
            {net === "testnet" && <span>Testnet: these coins have no value.</span>}
            <Link href="/rules">Rules</Link>
            <a href="https://github.com/faroukobayanju/bulkhead">Source</a>
          </div>
        </footer>
      </body>
    </html>
  );
}
