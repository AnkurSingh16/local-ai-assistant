import type { AccountClient, FeedbackKind } from '@local-ai/client';
import type { ReactElement, SyntheticEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

const maxFeedbackChars = 1000;

const kindLabels: Record<FeedbackKind, string> = {
  feedback: 'Feedback on this answer',
  correction: 'A correction',
  preference: 'Something to remember about me',
};

type State = 'closed' | 'open' | 'sending' | 'sent' | 'failed';

/**
 * Sends feedback, a correction or a preference for my review (ADR-0009).
 * Nothing changes the assistant until I approve it, and the user is told so:
 * the reply is the same whether the item was queued or dropped by moderation.
 */
export function Feedback({ account }: { readonly account: AccountClient }): ReactElement {
  const [state, setState] = useState<State>('closed');
  const [kind, setKind] = useState<FeedbackKind>('feedback');
  const [text, setText] = useState('');
  const [support, setSupport] = useState<string | undefined>(undefined);
  const id = useId();
  const firstField = useRef<HTMLSelectElement>(null);
  const result = useRef<HTMLParagraphElement>(null);

  // Keyboard and screen-reader users land in the form when it opens, and on
  // the outcome when it replaces the Send button, instead of on the page body.
  useEffect(() => {
    if (state === 'open') firstField.current?.focus();
    if (state === 'sent') result.current?.focus();
  }, [state]);

  if (state === 'closed') {
    return (
      <button
        type="button"
        className="link"
        onClick={() => {
          setState('open');
        }}
      >
        Send feedback
      </button>
    );
  }
  if (state === 'sent') {
    // Someone who wrote something that reads as self-harm sees where to get help.
    return support === undefined ? (
      <p className="note" role="status" tabIndex={-1} ref={result}>
        Thanks. I review feedback before anything changes.
      </p>
    ) : (
      <p className="refusal" role="status" tabIndex={-1} ref={result}>
        {support}
      </p>
    );
  }

  const submit = async (e: SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (text.trim() === '') return;
    setState('sending');
    try {
      setSupport(await account.sendFeedback(kind, text.trim(), AbortSignal.timeout(15_000)));
      setText('');
      setState('sent');
    } catch {
      setState('failed');
    }
  };

  return (
    <form
      className="feedback"
      aria-label="Feedback"
      onSubmit={(e) => {
        void submit(e);
      }}
    >
      <label htmlFor={`${id}-kind`}>Type</label>
      <select
        ref={firstField}
        id={`${id}-kind`}
        value={kind}
        onChange={(e) => {
          const value = e.target.value;
          if (value === 'feedback' || value === 'correction' || value === 'preference')
            setKind(value);
        }}
      >
        {Object.entries(kindLabels).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-text`}>Details</label>
      <textarea
        id={`${id}-text`}
        value={text}
        maxLength={maxFeedbackChars}
        rows={2}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      {state === 'failed' && (
        <p className="error" role="alert">
          Feedback could not be sent. Please try again.
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={state === 'sending' || text.trim() === ''}>
          Send
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setState('closed');
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
