export const API_BASE_URL = typeof window !== 'undefined'
  ? (['3000', '3001', '3200'].includes(window.location.port)
    ? (process.env.NEXT_PUBLIC_API_URL || `${window.location.protocol}//${window.location.hostname}:3202`)
    : window.location.origin)
  : (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3202');

export const apiHeaders = (): Record<string, string> => {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('llmwiki_token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const COLORS = {
  evidence: '#B7791F',
  evidenceSoft: '#F5E9C9',
};
