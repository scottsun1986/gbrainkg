import { BrainRepoAdapter } from '@llmwiki/gbrain-adapter';

let sharedAdapter: BrainRepoAdapter | null = null;

export function getSharedBrainRepoAdapter(): BrainRepoAdapter {
  if (!sharedAdapter) {
    sharedAdapter = new BrainRepoAdapter(
      process.env.BRAIN_REPO_BASE_PATH || '/tmp/llmwiki/brain_repos',
    );
  }
  return sharedAdapter;
}

export const brainAdapterProvider = {
  provide: 'BRAIN_REPO_ADAPTER',
  useFactory: () => {
    return getSharedBrainRepoAdapter();
  },
};
