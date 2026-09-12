/**
 * Shared LLM client for the evaluation tooling (independent eval).
 *
 * Loads the page-configured route from apps/api/.env (same source of truth as
 * the runtime) and adds provider-required headers (OpenCode Zen Go needs
 * x-opencode-session). Never hardcodes a model name.
 */
import fs from 'fs';
import path from 'path';

let loaded = false;

export function loadApiEnv(): void {
  if (loaded) return;
  loaded = true;
  const envPath = path.join(__dirname, '..', '..', 'apps', 'api', '.env');
  try {
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#]*))\s*$/);
      const value = m?.[2] ?? m?.[3] ?? m?.[4]?.trim();
      if (m?.[1] && value !== undefined && process.env[m[1]] === undefined) {
        process.env[m[1]] = value;
      }
    }
  } catch {
    // Env may already be provided by the CI runner.
  }
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  headers: Record<string, string>;
}

export function llmConfig(): LlmConfig | null {
  loadApiEnv();
  const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';
  const modelName = process.env.LLM_MODEL || '';
  if (!baseUrl || !apiKey || !modelName) return null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (baseUrl.includes('opencode.ai')) headers['x-opencode-session'] = 'llmwiki-eval';
  return { baseUrl, apiKey, modelName, headers };
}

/** Chat completion returning assistant text (reasoning_content fallback). */
export async function llmChat(
  messages: Array<{ role: string; content: string }>,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const config = llmConfig();
  if (!config) return '';
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: config.headers,
    body: JSON.stringify({
      model: config.modelName,
      messages,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 800,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
  });
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
  const payload: any = await response.json();
  const message = payload?.choices?.[0]?.message || {};
  const content = String(message.content || '').trim();
  if (content) return content;
  const reasoning = String(message.reasoning_content || '').trim();
  if (!reasoning) return '';
  const parts = reasoning.split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : reasoning.slice(-800);
}

export function extractJson<T = any>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}
