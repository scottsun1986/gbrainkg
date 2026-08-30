import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const token = request.cookies.get('llmwiki_token')?.value || 
                request.headers.get('authorization')?.replace('Bearer ', '');
  
  const isLoginPage = request.nextUrl.pathname === '/login';
  const isPublicPath = request.nextUrl.pathname.startsWith('/api/') || 
                       request.nextUrl.pathname.startsWith('/_next/');
  
  if (isPublicPath) return NextResponse.next();
  
  // Don't redirect if already on login-ish path or if token exists
  if (!token && !isLoginPage) {
    // The SPA handles its own auth, so just let it through
    // This is a soft guard; the real auth is in the API
  }
  
  // Add security headers
  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
