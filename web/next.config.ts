import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// The app imports ../shared and ../agent/src/address.ts, so the build root is the repo root.
const root = fileURLToPath(new URL("..", import.meta.url));

const config: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
          { key: "x-frame-options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
