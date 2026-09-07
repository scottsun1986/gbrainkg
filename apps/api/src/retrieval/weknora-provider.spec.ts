import { weknoraClientProvider, WEKNORA_CLIENT } from './weknora.provider';
import { WeKnoraClient } from './weknora-client';

describe('weknoraClientProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns null when WEKNORA_ENABLED is not set or false', () => {
    process.env.WEKNORA_ENABLED = 'false';
    process.env.WEKNORA_BASE_URL = 'http://127.0.0.1:8080';
    process.env.WEKNORA_API_KEY = 'test-key';

    const factory = (weknoraClientProvider as any).useFactory;
    expect(factory()).toBeNull();
  });

  it('returns null when credentials are missing', () => {
    process.env.WEKNORA_ENABLED = 'true';
    delete process.env.WEKNORA_BASE_URL;
    delete process.env.WEKNORA_API_KEY;

    const factory = (weknoraClientProvider as any).useFactory;
    expect(factory()).toBeNull();
  });

  it('returns WeKnoraClient instance when enabled and credentials provided', () => {
    process.env.WEKNORA_ENABLED = 'true';
    process.env.WEKNORA_BASE_URL = 'http://127.0.0.1:8080';
    process.env.WEKNORA_API_KEY = 'test-key';

    const factory = (weknoraClientProvider as any).useFactory;
    const client = factory();
    expect(client).toBeInstanceOf(WeKnoraClient);
  });
});
