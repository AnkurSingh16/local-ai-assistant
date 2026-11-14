import type { AccountClient, MemoryEntry } from '@local-ai/client';
import { memoryDisclosure } from '@local-ai/client';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CloseIcon } from './Icons.js';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: readonly MemoryEntry[] }
  | { readonly kind: 'error' }
  | { readonly kind: 'deleted' };

/** Lists what is remembered about this session and deletes it, one item or all. */
export function MemoryPanel({
  account,
  onClose,
  onDeletedEverything,
}: {
  readonly account: AccountClient;
  readonly onClose: () => void;
  readonly onDeletedEverything: () => void;
}): ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', items: await account.memory(AbortSignal.timeout(10_000)) });
    } catch {
      setState({ kind: 'error' });
    }
  }, [account]);

  useEffect(() => {
    void load();
  }, [load]);

  const forget = async (id: string): Promise<void> => {
    try {
      await account.forget(id, AbortSignal.timeout(10_000));
      await load();
    } catch {
      setState({ kind: 'error' });
    }
  };

  const deleteEverything = async (): Promise<void> => {
    try {
      await account.deleteEverything(AbortSignal.timeout(10_000));
      setState({ kind: 'deleted' });
      onDeletedEverything();
    } catch {
      setState({ kind: 'error' });
    }
  };

  // A modal drawer: focus moves into it on open and goes back to whatever
  // opened it on close, so keyboard and screen reader users are not left on a
  // control hidden behind the backdrop. The page behind it is inert (App).
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  // Escape closes the panel, as it does any overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <>
      <div className="backdrop" aria-hidden="true" onClick={onClose} />
      <section className="memory" role="dialog" aria-modal="true" aria-labelledby="memory-title">
        <div className="memory-head">
          <h2 id="memory-title">What I remember</h2>
          <button ref={closeButton} type="button" className="btn btn-ghost" onClick={onClose}>
            <CloseIcon />
            Close
          </button>
        </div>
        <p className="note">{memoryDisclosure}</p>
        {state.kind === 'loading' && <p className="status">Loading…</p>}
        {state.kind === 'error' && (
          <p className="error" role="alert">
            That didn't work. Please try again.
          </p>
        )}
        {state.kind === 'deleted' && (
          <p role="status">Everything stored under your session is deleted.</p>
        )}
        {state.kind === 'ready' && (
          <>
            {state.items.length === 0 ? (
              <p>Nothing is remembered yet. Items appear here only after I approve them.</p>
            ) : (
              <ul className="memory-items">
                {state.items.map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.content}
                      {item.always && <span className="note"> (used in every answer)</span>}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void forget(item.id)}
                      aria-label={`Forget: ${item.content}`}
                    >
                      Forget
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {confirming ? (
              <div className="confirm" role="group" aria-label="Confirm deletion">
                <p>
                  Delete your conversations, remembered items and feedback? This cannot be undone.
                </p>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void deleteEverything()}
                >
                  Yes, delete everything
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Delete everything
              </button>
            )}
          </>
        )}
      </section>
    </>
  );
}
