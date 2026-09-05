import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { RPCCaller, RPC, Wire } from '@ezenki/deploy-commander-installer-interface';
import ConnectionRequest from './ConnectionRequest';
import type { ReadyPrimaryState } from '../lib/primaryState';
import { createRunEventSource } from '../lib/runMonitor';

afterEach(cleanup);

const resource = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  created_at: 'now', updated_at: 'now',
} as RPC.ResourceItem;

const primary: ReadyPrimaryState = {
  phase: 'ready', operationId: 'primary-1',
  credentials: {
    username: 'pg_admin_0123456789abcdef0123456789abcdef',
    password: 'admin-password',
  },
  runId: 'run-1', resourceId: resource.id,
  initializedAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};

function baseProps(caller: RPCCaller, wire: Wire) {
  return {
    caller,
    wire,
    events: createRunEventSource(),
    currentManagerId: 'postgres-manager',
    callingManagerId: 'consumer-manager',
    resource,
    primary,
    storage: {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage,
  };
}

describe('ConnectionRequest child errors', () => {
  it.each([
    ['A calling manager is required', 400, 'A calling manager is required'],
    ['A PostgreSQL operation is already in progress', 409, 'A PostgreSQL operation is already in progress'],
    ['Database access was cancelled', 499, 'Database access was cancelled'],
    ['PostgreSQL recovery is required', 503, 'PostgreSQL recovery is required'],
  ])('maps %s to a fixed non-secret response', async (error, status, message) => {
    const wire = { close: vi.fn() } as unknown as Wire;

    render(<ConnectionRequest
      {...baseProps({} as RPCCaller, wire)}
      initialError={error}
    />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status, message },
    }));
  });

  it('maps unexpected errors to a fixed non-secret 500 response', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;

    render(<ConnectionRequest
      {...baseProps({} as RPCCaller, wire)}
      initialError="database password is secret-in-the-error"
    />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status: 500, message: 'Unable to create the PostgreSQL connection' },
    }));
  });

  it('maps an invalid authoritative platform connection to recovery-required', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getResource: vi.fn().mockResolvedValue({
        config: { platform_connection: { type: 'Platform', data: { network: '' } } },
      }),
    } as unknown as RPCCaller;

    render(<ConnectionRequest {...baseProps(caller, wire)} />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status: 503, message: 'PostgreSQL recovery is required' },
    }));
  });
});

describe('ConnectionRequest lifecycle', () => {
  it('closes an initial success exactly once across a rerender', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {} as RPCCaller;
    const initialResult = {
      connection: { id: 'connection-1' },
      config: { metadata: {} },
    } as RPC.CreateConnection;
    const props = { ...baseProps(caller, wire), initialResult };
    const view = render(<ConnectionRequest {...props} />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledTimes(1));
    view.rerender(<ConnectionRequest {...props} />);
    await waitFor(() => expect(wire.close).toHaveBeenCalledTimes(1));
  });

  it('does not close after an in-flight request is unmounted', async () => {
    let resolveResource: (value: unknown) => void = () => undefined;
    const resourceRequest = new Promise((resolve) => { resolveResource = resolve; });
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = { getResource: vi.fn().mockReturnValue(resourceRequest) } as unknown as RPCCaller;
    const view = render(<ConnectionRequest {...baseProps(caller, wire)} />);

    view.unmount();
    resolveResource({ config: { platform_connection: { type: 'Platform', data: { network: 'postgres-network' } } } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wire.close).not.toHaveBeenCalled();
  });
});
