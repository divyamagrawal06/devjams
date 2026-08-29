import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // QA and local production builds can use isolated outputs without racing `.next`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "indexd.app" }],
        destination: "https://www.indexd.app/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
