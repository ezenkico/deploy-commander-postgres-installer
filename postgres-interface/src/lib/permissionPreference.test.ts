import { describe, expect, it } from 'vitest';
import {
  clearPermission,
  isPermissionRemembered,
  permissionKey,
  rememberPermission,
} from './permissionPreference';

describe('permission preference', () => {
  it('builds an installation-scoped key with the exact contract', () => {
    expect(permissionKey('manager-a', 'resource-1'))
      .toBe('deploy-commander:postgres:create-connection:manager-a:resource-1');
  });

  it('isolates preferences across manager and resource pairs', () => {
    const storage = window.localStorage;

    expect(rememberPermission(storage, 'manager-a', 'resource-1')).toBe(true);
    expect(isPermissionRemembered(storage, 'manager-a', 'resource-1')).toBe(true);
    expect(isPermissionRemembered(storage, 'manager-b', 'resource-1')).toBe(false);
    expect(isPermissionRemembered(storage, 'manager-a', 'resource-2')).toBe(false);
  });

  it('reuses one installation approval for different callers of the same manager and resource', () => {
    const storage = window.localStorage;
    const managerId = 'manager-a';
    const resourceId = 'resource-1';
    const callerA = 'caller-a';
    const callerB = 'caller-b';
    const keyForCaller = (callerId: string) => {
      void callerId;
      return permissionKey(managerId, resourceId);
    };

    expect(keyForCaller(callerA)).toBe(keyForCaller(callerB));
    expect(rememberPermission(storage, managerId, resourceId)).toBe(true);
    expect(isPermissionRemembered(storage, managerId, resourceId)).toBe(true);
  });

  it('accepts only the literal allow value', () => {
    const storage = window.localStorage;
    const key = permissionKey('manager-a', 'resource-1');

    storage.setItem(key, 'true');
    expect(isPermissionRemembered(storage, 'manager-a', 'resource-1')).toBe(false);
    storage.setItem(key, 'allow');
    expect(isPermissionRemembered(storage, 'manager-a', 'resource-1')).toBe(true);
  });

  it('clears only the requested manager and resource key', () => {
    const storage = window.localStorage;
    rememberPermission(storage, 'manager-a', 'resource-1');
    rememberPermission(storage, 'manager-b', 'resource-1');

    expect(clearPermission(storage, 'manager-a', 'resource-1')).toBe(true);
    expect(isPermissionRemembered(storage, 'manager-a', 'resource-1')).toBe(false);
    expect(isPermissionRemembered(storage, 'manager-b', 'resource-1')).toBe(true);
  });

  it('fails closed when storage operations throw', () => {
    const storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;

    expect(isPermissionRemembered(storage, 'manager-a', 'resource-1')).toBe(false);
    expect(rememberPermission(storage, 'manager-a', 'resource-1')).toBe(false);
    expect(clearPermission(storage, 'manager-a', 'resource-1')).toBe(false);
  });
});
