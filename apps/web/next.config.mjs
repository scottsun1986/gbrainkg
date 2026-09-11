const configuredApiOrigin = (() => {
  const value = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
})();

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.OUTPUT_STANDALONE === 'true' ? { output: 'standalone' } : {}),
  allowedDevOrigins: ['127.0.0.1', 'localhost', '10.0.185.143', '45.42.214.20', '0.0.0.0'],
  async rewrites() {
    const apiTarget = process.env.INTERNAL_API_URL || 'http://127.0.0.1:3000';
    return [
      {
        source: '/api/:path*',
        destination: `${apiTarget}/api/:path*`,
      },
      {
        source: '/open-api/:path*',
        destination: `${apiTarget}/open-api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '') + "; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' http: https: ws: wss:; object-src 'self' blob: data:; frame-src 'self' blob: data:; frame-ancestors 'self'; form-action 'self'; base-uri 'self';" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
