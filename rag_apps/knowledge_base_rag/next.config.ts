import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse pulls in pdfjs-dist, which ships its own worker/legacy build and
  // doesn't survive Next's server bundling. Keep it external so it's required
  // from node_modules at runtime instead of being traced into the bundle.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
