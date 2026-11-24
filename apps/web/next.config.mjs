/** @type {import('next').NextConfig} */
const apiUrl = (process.env.API_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');

const nextConfig = {
  transpilePackages: ['@nexus/shared'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/preview/:path*', destination: `${apiUrl}/preview/:path*` },
    ];
  },
};

export default nextConfig;
