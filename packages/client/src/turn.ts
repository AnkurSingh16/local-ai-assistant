import type { RefusalKind, SseEvent, StatusPhase } from '@local-ai/contract';

/**
 * The view of one assistant turn, built from its events. Web and mobile render
 * this same state, so they cannot drift in how they treat refusals or errors.
 */
export interface TurnView {
  readonly phase: 'sending' | StatusPhase | 'done' | 'refused' | 'failed' | 'cancelled';
  readonly conversationId: string | undefined;
  readonly messageId: string | undefined;
  /** The answer so far: every released unit, in order, each already moderated by the server. */
  readonly text: string;
  readonly citations: readonly {
    readonly n: number;
    readonly url: string;
    readonly title: string;
  }[];
  readonly refusal: { readonly kind: RefusalKind; readonly message: string } | undefined;
  readonly error:
    | {
        readonly message: string;
        readonly retryable: boolean;
        /** Wait this long before retrying, when the server said so (429 or 503). */
        readonly retryAfterMs?: number;
      }
    | undefined;
  /** True when the answer stopped at the output token limit. */
  readonly truncated: boolean;
}

export const initialTurn: TurnView = {
  phase: 'sending',
  conversationId: undefined,
  messageId: undefined,
  text: '',
  citations: [],
  refusal: undefined,
  error: undefined,
  truncated: false,
};

export function reduceTurn(view: TurnView, event: SseEvent): TurnView {
  switch (event.type) {
    case 'meta':
      return { ...view, conversationId: event.conversationId, messageId: event.messageId };
    case 'status':
      return { ...view, phase: event.phase };
    case 'delta':
      return { ...view, text: view.text + event.text };
    case 'citation':
      return {
        ...view,
        citations: [...view.citations, { n: event.n, url: event.url, title: event.title }],
      };
    case 'refusal':
      return { ...view, phase: 'refused', refusal: { kind: event.kind, message: event.message } };
    case 'error':
      return {
        ...view,
        phase: 'failed',
        error: { message: event.message, retryable: event.retryable },
      };
    case 'done':
      if (view.phase === 'refused' || view.phase === 'failed') return view;
      return { ...view, phase: 'done', truncated: event.finishReason === 'length' };
  }
}

/** The view after the turn could not be delivered at all (network, rate limit, busy). */
export function failTurn(
  view: TurnView,
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): TurnView {
  return {
    ...view,
    phase: 'failed',
    error: { message, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
  };
}

export function cancelTurn(view: TurnView): TurnView {
  return { ...view, phase: 'cancelled' };
}
