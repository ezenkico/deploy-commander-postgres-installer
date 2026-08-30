import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PermissionDialog from './PermissionDialog';
import { rememberPermission } from '../lib/permissionPreference';

afterEach(cleanup);

function renderDialog(overrides: Partial<React.ComponentProps<typeof PermissionDialog>> = {}) {
  const props: React.ComponentProps<typeof PermissionDialog> = {
    callerId: 'calling-manager-7',
    busy: false,
    onAllow: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { ...render(<PermissionDialog {...props} />), props };
}

describe('PermissionDialog', () => {
  it('renders an accessible dialog identifying the untrusted caller', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: 'Allow PostgreSQL connection?' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'Allow PostgreSQL connection?' })).toBeVisible();
    expect(screen.getByText('calling-manager-7')).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: /don.t ask me again/i })).not.toBeChecked();
    expect(screen.getByText(/installation-wide approval.*all future callers/i)).toBeVisible();
  });

  it('traps tab focus inside the dialog and restores focus on unmount', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    opener.textContent = 'Open permission dialog';
    document.body.append(opener);
    opener.focus();
    const view = renderDialog();
    const allow = screen.getByRole('button', { name: 'Allow' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    await user.tab();
    expect(screen.getByRole('checkbox')).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(allow).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();

    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('reports whether the installation-wide preference checkbox was selected', async () => {
    const user = userEvent.setup();
    const onAllow = vi.fn();
    renderDialog({ onAllow });

    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAllow).toHaveBeenCalledWith(false);
  });

  it('passes true when Allow is checked and Cancel never approves', async () => {
    const user = userEvent.setup();
    const onAllow = vi.fn();
    const onCancel = vi.fn();
    const view = renderDialog({ onAllow, onCancel });

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAllow).toHaveBeenCalledWith(true);
    expect(onCancel).not.toHaveBeenCalled();

    view.unmount();
    renderDialog({ onAllow, onCancel });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('disables controls and announces the busy state', () => {
    renderDialog({ busy: true });

    expect(screen.getByRole('status')).toHaveTextContent('Requesting access');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('cancels on Escape only while it is not busy', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const view = renderDialog({ onCancel });

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    view.unmount();

    renderDialog({ busy: true, onCancel });
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit Allow independent from preference persistence failures', async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    const storage = {
      setItem: () => { throw new Error('storage blocked'); },
    } as unknown as Storage;
    function Harness() {
      return <PermissionDialog callerId="caller-a" busy={false} onCancel={vi.fn()} onAllow={(value) => {
        request({ remember: value, stored: rememberPermission(storage, 'manager-a', 'resource-1') });
      }} />;
    }

    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(request).toHaveBeenCalledWith({ remember: false, stored: false });
  });
});
