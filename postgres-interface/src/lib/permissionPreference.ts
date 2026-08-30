const PERMISSION_VALUE = 'allow';

/** Return the key for an approval that is scoped to one manager's installation. */
export function permissionKey(managerId: string, resourceId: string): string {
  return `deploy-commander:postgres:create-connection:${managerId}:${resourceId}`;
}

/** Read an approval, failing closed when storage is unavailable or has another value. */
export function isPermissionRemembered(
  storage: Storage,
  managerId: string,
  resourceId: string,
): boolean {
  try {
    return storage.getItem(permissionKey(managerId, resourceId)) === PERMISSION_VALUE;
  } catch {
    return false;
  }
}

/** Remember an approval and report whether the storage operation succeeded. */
export function rememberPermission(
  storage: Storage,
  managerId: string,
  resourceId: string,
): boolean {
  try {
    storage.setItem(permissionKey(managerId, resourceId), PERMISSION_VALUE);
    return true;
  } catch {
    return false;
  }
}

/** Remove only the requested installation approval and report storage success. */
export function clearPermission(
  storage: Storage,
  managerId: string,
  resourceId: string,
): boolean {
  try {
    storage.removeItem(permissionKey(managerId, resourceId));
    return true;
  } catch {
    return false;
  }
}
