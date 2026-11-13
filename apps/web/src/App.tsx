import type { AccountClient, ChatClient, TurnView } from '@local-ai/client';
import type { Turn } from '@local-ai/client/react';
import { useChat } from '@local-ai/client/react';
import { maxMessageChars } from '@local-ai/contract';
import type { KeyboardEvent, ReactElement, SyntheticEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Answer } from './Answer.js';
import { Feedback } from './Feedback.js';
import { MemoryPanel } from './MemoryPanel.js';

const phaseLabels: Partial<Record<TurnView['phase'], string>> = {
  sending: 'Sending…',
  moderating: 'Checking your message…',
  searching: 'Searching the web…',
  reading: 'Reading sources…',
  answering: 'Writing…',
};

/** True once the server's requested wait has passed, so Try again cannot hit the same limit at once. */
function useRetryReady(retryAfterMs: number | undefined): boolean {
  // The delay whose timer has run out. Ready only when it matches the current
  // delay, so a new error is never briefly retryable before its timer starts.
  const [expired, setExpired] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (retryAfterMs === undefined) return undefined;
    const timer = setTimeout(() => {
      setExpired(retryAfterMs);
    }, retryAfterMs);
    return () => {
      clearTimeout(timer);
    };
  }, [retryAfterMs]);
  return retryAfterMs === undefined || expired === retryAfterMs;
}

function TurnItem({
  turn,
  onRetry,
  busy,
  account,
}: {
  turn: Turn;
  onRetry: (q: string) => void;
  busy: boolean;
  account: AccountClient | undefined;
}): ReactElement {
  const { view } = turn;
  const label = phaseLabels[view.phase];
  const retryReady = useRetryReady(view.error?.retryAfterMs);
  return (
    <li className="turn">
      <div className="question" aria-label="You">
        {turn.question}
      </div>
      <div
        className="reply"
        aria-label="Assistant"
        aria-live="polite"
        aria-busy={label !== undefined}
      >
        {view.text !== '' && <Answer text={view.text} />}
        {view.citations.length > 0 && (
          <ol className="sources" aria-label="Sources">
            {view.citations.map((c) => (
              <li key={c.n} value={c.n}>
                {/* The contract allows only https URLs here; noopener keeps the opened page from reaching back. */}
                <a href={c.url} target="_blank" rel="noopener noreferrer">
                  {c.title === '' ? new URL(c.url).hostname : c.title}
                </a>
              </li>
            ))}
          </ol>
        )}
        {label !== undefined && <p className="status">{label}</p>}
        {view.truncated && <p className="note">The answer reached its length limit.</p>}
        {view.refusal !== undefined && (
          <p className="refusal" role="note">
            {view.refusal.message}
          </p>
        )}
        {view.error !== undefined && (
          <div className="error" role="alert">
            <p>{view.error.message}</p>
            {view.error.retryable && (
              <button
                type="button"
                disabled={busy || !retryReady}
                onClick={() => {
                  onRetry(turn.question);
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}
        {view.phase === 'cancelled' && <p className="note">Stopped.</p>}
        {account !== undefined && view.phase === 'done' && view.text !== '' && (
          <Feedback account={account} />
        )}
      </div>
    </li>
  );
}

export function App({
  client,
  account,
}: {
  readonly client: ChatClient;
  /** Session and memory calls; without it the memory view is hidden. */
  readonly account?: AccountClient;
}): ReactElement {
  const chat = useChat(client);
  const [draft, setDraft] = useState('');
  const [showMemory, setShowMemory] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat.turns]);

  const submit = (e?: SyntheticEvent): void => {
    e?.preventDefault();
    if (chat.busy || draft.trim() === '') return;
    const question = draft;
    setDraft('');
    void chat.send(question);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <main className="app">
      <header>
        <h1>Local AI Assistant</h1>
        <p className="subtitle">
          Runs on this computer. Answers can be wrong; check anything important.
        </p>
        {chat.turns.length > 0 && (
          <button
            type="button"
            className="link"
            disabled={chat.busy}
            onClick={() => {
              chat.reset();
            }}
          >
            New conversation
          </button>
        )}
        {account !== undefined && (
          <button
            type="button"
            className="link"
            aria-expanded={showMemory}
            onClick={() => {
              setShowMemory((v) => !v);
            }}
          >
            What I remember
          </button>
        )}
      </header>
      {account !== undefined && showMemory && (
        <MemoryPanel
          account={account}
          onClose={() => {
            setShowMemory(false);
          }}
          onDeletedEverything={() => {
            chat.reset();
            // A fresh session, so the next conversation is remembered again.
            void account.startSession(AbortSignal.timeout(10_000)).catch(() => undefined);
          }}
        />
      )}
      <ol className="turns" aria-label="Conversation">
        {chat.turns.map((turn) => (
          <TurnItem
            key={turn.id}
            turn={turn}
            busy={chat.busy}
            account={account}
            onRetry={(q) => void chat.send(q)}
          />
        ))}
      </ol>
      <div ref={end} />
      <form className="composer" onSubmit={submit}>
        <label htmlFor="message" className="visually-hidden">
          Message
        </label>
        <textarea
          id="message"
          value={draft}
          maxLength={maxMessageChars}
          rows={3}
          placeholder="Ask anything"
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        {chat.busy ? (
          <button
            type="button"
            onClick={() => {
              chat.stop();
            }}
          >
            Stop
          </button>
        ) : (
          <button type="submit" disabled={draft.trim() === ''}>
            Send
          </button>
        )}
      </form>
    </main>
  );
}
