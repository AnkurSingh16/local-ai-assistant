import type { AccountClient, MemoryEntry } from '@local-ai/client';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';

/** The wording promised in ADR-0009, shown wherever memory is managed. */
export const memoryDisclosure =
  'Everything stored under your session (conversations, remembered items, feedback and items waiting for my review) is deleted for real when you delete it. If a conversation shows me a useful test, I may write a new, anonymised test case inspired by it. It contains none of your words or personal details and cannot be linked back to you. Your searches are sent through my search server to public search engines.';

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

  return (
    <section className="memory" aria-labelledby="memory-title">
      <div className="memory-head">
        <h2 id="memory-title">What I remember</h2>
        <button type="button" onClick={onClose}>
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
                  <span>{item.content}</span>
                  <button
                    type="button"
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
              <button type="button" className="danger" onClick={() => void deleteEverything()}>
                Yes, delete everything
              </button>
              <button
                type="button"
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
              className="danger"
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
  );
}
