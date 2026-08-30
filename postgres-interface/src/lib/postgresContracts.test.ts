import { describe, expect, it } from 'vitest';
import {
  isCreateConnectionMetadata,
  parsePlatformConnection,
  type PlatformConnection,
} from './postgresContracts';

describe('isCreateConnectionMetadata', () => {
  it('accepts only the exact create-connection action object', () => {
    expect(isCreateConnectionMetadata({ action: 'create-connection' })).toBe(true);
  });

  it.each([
    null,
    [],
    { action: 'create' },
    { action: 'create-connection', caller: 'manager' },
    { action: 'create-connection', resource: 'resource' },
    { action: 'create-connection', extra: undefined },
  ])('rejects %j', (value) => {
    expect(isCreateConnectionMetadata(value)).toBe(false);
  });
});

describe('parsePlatformConnection', () => {
  it('accepts an exact platform connection with a non-blank network', () => {
    const connection: PlatformConnection = parsePlatformConnection({
      type: 'Platform',
      data: { network: 'postgres-network' },
    });

    expect(connection).toEqual({
      type: 'Platform',
      data: { network: 'postgres-network' },
    });
  });

  it.each([
    { type: 'Platform', data: { network: '' } },
    { type: 'Platform', data: { network: '   ' } },
    { type: 'platform', data: { network: 'postgres-network' } },
    { type: 'Network', data: { network: 'postgres-network' } },
    { type: 'Platform', data: {} },
    { type: 'Platform' },
    { type: 'Platform', data: { network: 123 } },
    { type: 'Platform', data: { network: 'postgres-network', extra: true } },
    { type: 'Platform', data: { network: 'postgres-network' }, extra: true },
    null,
    [],
  ])('rejects malformed value %j', (value) => {
    expect(() => parsePlatformConnection(value)).toThrow();
  });

  it('trims surrounding network whitespace before returning the contract', () => {
    expect(parsePlatformConnection({
      type: 'Platform',
      data: { network: '  postgres-network  ' },
    })).toEqual({
      type: 'Platform',
      data: { network: 'postgres-network' },
    });
  });
});
