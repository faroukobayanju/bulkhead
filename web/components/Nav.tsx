"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/", "Arena"],
  ["/firewall", "Firewall"],
  ["/verify", "Verify"],
  ["/dataset", "Dataset"],
  ["/rules", "Rules"],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map(([href, label]) => {
        const here = href === "/" ? path === "/" || path.startsWith("/tier") : path.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={here ? "page" : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
