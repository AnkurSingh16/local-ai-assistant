import type { ChatClient, TurnView } from '@local-ai/client';
import { maxMessageChars } from '@local-ai/contract';
import type { KeyboardEvent, ReactElement, SyntheticEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Answer } from './Answer.js';
import type { Turn } from './useChat.js';
import { useChat } from './useChat.js';

const phaseLabels: Partial<Record<TurnView['phase'], string>> = {
  sending: 'Sending…',
  moderating: 'Checking your message…',
  searching: 'Searching the web…',
  reading: 'Reading sources…',
  answering: 'Writing…',
};

function TurnItem({
  turn,
  onRetry,
  busy,
}: {
  turn: Turn;
  onRetry: (q: string) => void;
  busy: boolean;
}): ReactElement {
  const { view } = turn;
  const label = phaseLabels[view.phase];
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
                disabled={busy}
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
      </div>
    </li>
  );
}

export function App({ client }: { readonly client: ChatClient }): ReactElement {
  const chat = useChat(client);
  const [draft, setDraft] = useState('');
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
      </header>
      <ol className="turns" aria-label="Conversation">
        {chat.turns.map((turn) => (
          <TurnItem key={turn.id} turn={turn} busy={chat.busy} onRetry={(q) => void chat.send(q)} />
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
