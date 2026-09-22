import { formatVectorValues } from '../db/tenant-context.service';

describe('object-storage path safety', () => {
  it('rejects path traversal in object keys (via resolveLocal semantics)', async () => {
    // Mirrors ObjectStorageService.resolveLocal guard without instantiating Nest DI.
    const { ObjectStorageService } = await import('../storage/object-storage.service');
    const svc = new ObjectStorageService();
    const anySvc = svc as any;
    expect(() => anySvc.resolveLocal('../etc/passwd')).toThrow(/escapes storage root/);
    expect(() => anySvc.resolveLocal('raw/../..//secret')).toThrow();
    const ok = anySvc.resolveLocal('raw/doc-1/abc');
    expect(ok).toContain('raw');
  });

  it('formatVectorValues is used for batch SQL (integration smoke)', () => {
    const out = formatVectorValues([
      { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', vec: '[0.5,-0.25]' },
    ]);
    expect(out).toContain('::vector');
    expect(out).not.toContain('DROP');
  });
});
