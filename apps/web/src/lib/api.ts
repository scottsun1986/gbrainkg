export const API_BASE_URL = typeof window !== 'undefined'
  ? ''
  : (process.env.INTERNAL_API_URL || 'http://127.0.0.1:3000');

export const apiHeaders = (): Record<string, string> => {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('llmwiki_token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const COLORS = {
  evidence: '#B7791F',
  evidenceSoft: '#F5E9C9',
};
