import { useCallback, useRef, useState } from 'react';

import type { ChatClient } from './client.js';
import { ChatClientError } from './client.js';
import type { TurnView } from './turn.js';
import { cancelTurn, failTurn, initialTurn, reduceTurn } from './turn.js';

export interface Turn {
  readonly id: number;
  readonly question: string;
  readonly view: TurnView;
}

export interface Chat {
  readonly turns: readonly Turn[];
  readonly busy: boolean;
  send(question: string): Promise<void>;
  stop(): void;
  /** Clears the conversation, after its data was deleted. */
  reset(): void;
}

const genericFailure = 'Something went wrong. Please try again.';

/**
 * Runs turns through the shared client and turn reducer, one at a time. A
 * React hook with no DOM or native code, so the web and Expo apps share it.
 */
export function useChat(client: ChatClient): Chat {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const conversationId = useRef<string | undefined>(undefined);
  const nextId = useRef(1);

  const update = useCallback((id: number, change: (view: TurnView) => TurnView) => {
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, view: change(t.view) } : t)));
  }, []);

  const send = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (text === '' || controller.current !== null) return;
      const id = nextId.current++;
      const abort = new AbortController();
      controller.current = abort;
      setBusy(true);
      setTurns((all) => [...all, { id, question: text, view: initialTurn }]);
      try {
        for await (const event of client.send(
          {
            message: text,
            ...(conversationId.current === undefined
              ? {}
              : { conversationId: conversationId.current }),
          },
          abort.signal,
        )) {
          if (event.type === 'meta') conversationId.current = event.conversationId;
          update(id, (view) => reduceTurn(view, event));
        }
      } catch (err) {
        if (abort.signal.aborted) update(id, cancelTurn);
        else if (err instanceof ChatClientError)
          update(id, (v) => failTurn(v, err.message, err.retryable, err.retryAfterMs));
        else update(id, (v) => failTurn(v, genericFailure, true));
      } finally {
        controller.current = null;
        setBusy(false);
      }
    },
    [client, update],
  );

  const stop = useCallback(() => {
    controller.current?.abort();
  }, []);

  const reset = useCallback(() => {
    controller.current?.abort();
    conversationId.current = undefined;
    setTurns([]);
  }, []);

  return { turns, busy, send, stop, reset };
}
