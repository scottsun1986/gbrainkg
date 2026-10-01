export function instanceIdentity(env = process.env): string {
  if (env.INSTANCE_ID || env.DB_NAME) return String(env.INSTANCE_ID || env.DB_NAME);
  try { return decodeURIComponent(new URL(env.DATABASE_URL_APP || env.DATABASE_URL || '').pathname.slice(1)) || 'local'; }
  catch { return 'local'; }
}
