import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // workspace 包为 TS 源码，需转译
  transpilePackages: ["@jargon/ui", "@jargon/contracts", "@jargon/db", "@jargon/matcher", "@jargon/quiz"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
