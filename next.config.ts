import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  env: {
    // Stamped into every client cache entry. A new deploy changes this, which
    // invalidates payloads written by an older build — otherwise a cached
    // result from a previous shape replays forever and the fix looks unshipped.
    NEXT_PUBLIC_BUILD:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ??
      process.env.VERCEL_DEPLOYMENT_ID?.slice(-8) ??
      "dev",
  },
  // There is a stray package.json/package-lock.json in the home directory from
  // 2023. Without pinning the root, Turbopack walks up and picks that as the
  // workspace root, which changes module resolution. Pin it to this repo.
  turbopack: {
    root: path.resolve(process.cwd()),
  },
};

export default nextConfig;
