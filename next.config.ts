import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // There is a stray package.json/package-lock.json in the home directory from
  // 2023. Without pinning the root, Turbopack walks up and picks that as the
  // workspace root, which changes module resolution. Pin it to this repo.
  turbopack: {
    root: path.resolve(process.cwd()),
  },
};

export default nextConfig;
