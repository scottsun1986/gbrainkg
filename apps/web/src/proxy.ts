import { NextResponse } from 'next/server';

export function proxy() {
  // Authentication lives in AppShell and the API; fragment SSO must reach the SPA.
  // Add security headers
  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
