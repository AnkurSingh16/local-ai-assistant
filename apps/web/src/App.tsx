import type { AccountClient, ChatClient, TurnView } from '@local-ai/client';
import type { Turn } from '@local-ai/client/react';
import { useChat } from '@local-ai/client/react';
import { maxMessageChars } from '@local-ai/contract';
import type { KeyboardEvent, ReactElement, SyntheticEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Answer } from './Answer.js';
import { Feedback } from './Feedback.js';
import {
  BrainIcon,
  LinkIcon,
  LockIcon,
  Mark,
  PlusIcon,
  RetryIcon,
  SendIcon,
  StopIcon,
} from './Icons.js';
import { MemoryPanel } from './MemoryPanel.js';

/** Starting points for an empty conversation: one needs the web, the rest do not. */
const suggestions = [
  'What is the latest version of Node.js?',
  'Explain how vaccines train the immune system',
  'Write a haiku about autumn rain',
  'Help me plan a relaxed weekend in Lisbon',
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

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
      <div className="question-row">
        <div className="question" aria-label="You">
          {turn.question}
        </div>
      </div>
      <div className="reply-row">
        <Mark size={30} />
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
                    <span className="source-n" aria-hidden="true">
                      {c.n}
                    </span>
                    <span className="source-title">{c.title === '' ? hostOf(c.url) : c.title}</span>
                    <span className="source-host" aria-hidden="true">
                      <LinkIcon />
                      {hostOf(c.url)}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          )}
          {label !== undefined && (
            <p className="status">
              <span className="dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {label}
            </p>
          )}
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
                  className="btn btn-quiet"
                  disabled={busy || !retryReady}
                  onClick={() => {
                    onRetry(turn.question);
                  }}
                >
                  <RetryIcon />
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
  const input = useRef<HTMLTextAreaElement>(null);

  // The box grows with the text, up to about eight lines, then scrolls.
  useEffect(() => {
    const box = input.current;
    if (box === null) return;
    box.style.height = 'auto';
    box.style.height = `${String(Math.min(box.scrollHeight, 220))}px`;
  }, [draft]);

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

  const ask = (question: string): void => {
    if (chat.busy) return;
    void chat.send(question);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Mark size={30} />
          <div>
            <h1>Local AI Assistant</h1>
            <p className="badge">
              <LockIcon />
              Private · runs on this computer
            </p>
          </div>
        </div>
        <nav className="actions" aria-label="Conversation actions">
          {chat.turns.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={chat.busy}
              onClick={() => {
                chat.reset();
              }}
            >
              <PlusIcon />
              <span className="btn-label">New conversation</span>
            </button>
          )}
          {account !== undefined && (
            <button
              type="button"
              className="btn btn-ghost"
              aria-expanded={showMemory}
              onClick={() => {
                setShowMemory((v) => !v);
              }}
            >
              <BrainIcon />
              <span className="btn-label">What I remember</span>
            </button>
          )}
        </nav>
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
      <main className="app">
        {chat.turns.length === 0 && (
          <section className="welcome" aria-labelledby="welcome-title">
            <Mark size={56} />
            <h2 id="welcome-title">How can I help today?</h2>
            <p className="subtitle">
              Answers come from the model, or from fresh web results with numbered sources when you
              ask about something recent.
            </p>
            <ul className="suggestions" aria-label="Suggestions">
              {suggestions.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    className="suggestion"
                    onClick={() => {
                      ask(s);
                    }}
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </section>
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
      </main>
      <div className="dock">
        <form className="composer" onSubmit={submit}>
          <label htmlFor="message" className="visually-hidden">
            Message
          </label>
          <textarea
            id="message"
            ref={input}
            value={draft}
            maxLength={maxMessageChars}
            rows={1}
            placeholder="Ask anything"
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={onKeyDown}
          />
          {chat.busy ? (
            <button
              type="button"
              className="round round-stop"
              aria-label="Stop"
              title="Stop"
              onClick={() => {
                chat.stop();
              }}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              className="round"
              aria-label="Send"
              title="Send"
              disabled={draft.trim() === ''}
            >
              <SendIcon />
            </button>
          )}
        </form>
        <p className="hint">
          Enter to send, Shift + Enter for a new line. Answers can be wrong; check anything
          important.
        </p>
      </div>
    </div>
  );
}
