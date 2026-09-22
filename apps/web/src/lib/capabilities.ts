/** Permission checks shared by navigation and admin screens. */

export function hasCapability(permission: string, capabilities: string[] = []): boolean {
  return capabilities.includes('*') || capabilities.includes(permission);
}

export const ADMIN_NAV_PERMISSIONS = [
  'org.read',
  'org.user.read',
  'role.read',
  'kb.industry.read',
  'kb.industry.create',
  'kb.industry.grant',
  'audit.read',
] as const;

export function canAccessAdmin(capabilities: string[] = []): boolean {
  return (
    capabilities.includes('*') ||
    ADMIN_NAV_PERMISSIONS.some((permission) => capabilities.includes(permission))
  );
}

export function canAccessSettings(capabilities: string[] = []): boolean {
  return (
    hasCapability('system.settings.read', capabilities) ||
    hasCapability('system.settings.manage', capabilities)
  );
}
