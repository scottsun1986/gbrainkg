import { Provider } from '@nestjs/common';
import { WeKnoraClient } from './weknora-client';

export const WEKNORA_CLIENT = 'WEKNORA_CLIENT';

export const weknoraClientProvider: Provider = {
  provide: WEKNORA_CLIENT,
  useFactory: () => {
    const baseUrl = process.env.WEKNORA_BASE_URL;
    const apiKey = process.env.WEKNORA_API_KEY;
    const enabled = process.env.WEKNORA_ENABLED === 'true' || process.env.WEKNORA_ENABLED === '1';

    if (enabled && baseUrl && apiKey) {
      try {
        return new WeKnoraClient({ baseUrl, apiKey });
      } catch (e) {
        console.warn(`[WeKnoraProvider] Failed to initialize WeKnoraClient: ${e}`);
        return null;
      }
    }
    return null;
  },
};
