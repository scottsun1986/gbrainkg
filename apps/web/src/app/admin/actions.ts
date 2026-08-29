'use server';

/**
 * Kept for compatibility with the initial standalone admin route.  The
 * production admin UI is rendered by the main prototype and writes through
 * the API; this action deliberately does not persist secrets from a server
 * action with no authenticated admin context.
 */
export async function saveModelConfig(_formData: FormData): Promise<void> {
  void _formData;
  throw new Error('Use the authenticated admin API to save model configuration.');
}
