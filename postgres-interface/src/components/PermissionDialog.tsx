import { useEffect, useRef, useState } from 'react';

export interface PermissionDialogProps {
  callerId: string;
  busy: boolean;
  onAllow: (remember: boolean) => void;
  onCancel: () => void;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function PermissionDialog({
  callerId,
  busy,
  onAllow,
  onCancel,
}: PermissionDialogProps) {
  const [remember, setRemember] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const cancelRef = useRef(onCancel);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialog.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!busyRef.current) {
          event.preventDefault();
          cancelRef.current();
        }
        return;
      }

      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = elements[0];
      const last = elements[elements.length - 1];
      const activeIsFocusable = elements.includes(document.activeElement as HTMLElement);
      if (event.shiftKey && (document.activeElement === first || !activeIsFocusable)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !activeIsFocusable)) {
        event.preventDefault();
        first?.focus();
      }
    };

    dialog.addEventListener('keydown', handleKeyDown);
    return () => {
      dialog.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        tabIndex={-1}
        aria-labelledby="permission-dialog-title"
        aria-describedby="permission-dialog-description"
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 id="permission-dialog-title" className="text-xl font-semibold">
          Allow PostgreSQL connection?
        </h2>
        <p id="permission-dialog-description" className="mt-3 text-sm text-gray-700">
          The calling manager <span className="font-mono">{callerId}</span> requests a logical database and credentials from this PostgreSQL installation.
        </p>
        <label className="mt-4 flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={remember}
            disabled={busy}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>
            Don&apos;t ask me again. This gives installation-wide approval for all future callers.
          </span>
        </label>
        {busy && (
          <p role="status" aria-live="polite" className="mt-4 text-sm text-gray-700">
            Requesting access…
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" disabled={busy} onClick={onCancel} className="rounded border px-4 py-2">
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={() => onAllow(remember)} className="rounded bg-blue-600 px-4 py-2 text-white">
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

export default PermissionDialog;
