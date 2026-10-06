/** @type {import('next').NextConfig} */
const basePath = process.env.NEXT_PUBLIC_APP_BASE_PATH || undefined

const nextConfig = {
  reactStrictMode: true,
  // The development badge sits over the sidebar on a small screen.
  devIndicators: false,
  distDir: process.env.NEXT_BUILD_DIR || '.next',
  basePath,
  assetPrefix: basePath,
}

export default nextConfig
