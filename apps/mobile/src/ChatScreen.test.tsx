import type { AccountClient, ChatClient } from '@local-ai/client';
import { createChatClient, toBlocks } from '@local-ai/client';
import type { ChatRequestBody, SseEvent } from '@local-ai/contract';
import { chatRequestSchema, encodeSseEvent, sseEventId } from '@local-ai/contract';
import { fixtureMessageId, fixtureTurns } from '@local-ai/contract/fixtures';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native/dist/pure';
import { describe, expect, it } from 'vitest';

import { ChatScreen } from './ChatScreen';

const encoder = new TextEncoder();

/**
 * A fetch that streams the encoded events in small chunks, the way expo/fetch
 * delivers a response body, so the real shared client parses them.
 */
function streamingFetch(events: readonly SseEvent[], chunkSize = 7) {
  const bodies: ChatRequestBody[] = [];
  const signals: AbortSignal[] = [];
  const fetch = (_url: string, init: RequestInit): Promise<Response> => {
    if (typeof init.body === 'string') {
      const parsed = chatRequestSchema.safeParse(JSON.parse(init.body));
      if (parsed.success) bodies.push(parsed.data);
    }
    if (init.signal) signals.push(init.signal);
    const wire = events.map((e, i) => encodeSseEvent(e, sseEventId(fixtureMessageId, i))).join('');
    const bytes = encoder.encode(wire);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Promise.resolve();
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
    return Promise.resolve(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );
  };
  return { fetch, bodies, signals };
}

function chatWith(events: readonly SseEvent[]) {
  const transport = streamingFetch(events);
  const client = createChatClient({ baseUrl: 'http://api.test', fetch: transport.fetch });
  return { client, transport };
}

async function ask(text: string): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText('Message'), text);
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
}

describe('mobile streaming contract: the shared fixtures render the same as on web', () => {
  it('streams the answered turn into paragraphs and a code block, then lists its source', async () => {
    const { client } = chatWith(fixtureTurns.answered ?? []);
    const opened: string[] = [];
    await render(<ChatScreen client={client} openUrl={(u) => opened.push(u)} />);
    await ask('Hello');
    expect(screen.getByLabelText('You: Hello')).toBeTruthy();
    const expected = toBlocks(
      (fixtureTurns.answered ?? []).flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join(''),
    );
    for (const block of expected) {
      expect(await screen.findByText(block.content)).toBeTruthy();
    }
    await fireEvent.press(await screen.findByRole('link', { name: 'Source 1: Example' }));
    expect(opened).toEqual(['https://example.com/a?b=c']);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    });
    expect(screen.queryByText('Writing…')).toBeNull();
  });

  it('shows a refusal with the fixed message', async () => {
    const { client } = chatWith(fixtureTurns.refused ?? []);
    await render(<ChatScreen client={client} openUrl={() => undefined} />);
    await ask('Something bad');
    expect(await screen.findByText("I can't help with that.")).toBeTruthy();
  });

  it('keeps what was released before a mid-answer refusal, then shows the refusal', async () => {
    const { client } = chatWith(fixtureTurns.refusedMidAnswer ?? []);
    await render(<ChatScreen client={client} openUrl={() => undefined} />);
    await ask('Hello');
    expect(await screen.findByText("I can't help with that.")).toBeTruthy();
    expect(screen.getByText('Released before the flag.')).toBeTruthy();
  });

  it('shows a model error with Try again, which resends the question', async () => {
    const { client, transport } = chatWith(fixtureTurns.failed ?? []);
    await render(<ChatScreen client={client} openUrl={() => undefined} />);
    await ask('Hello');
    expect(await screen.findByText('The assistant is not available right now.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(transport.bodies).toHaveLength(2);
    });
    expect(transport.bodies[1]?.message).toBe('Hello');
  });
});

describe('mobile chat screen', () => {
  /** A client whose turn never ends until it is aborted, to test Stop. */
  function hangingClient(): ChatClient & { readonly signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    return {
      signals,
      async *send(_body, signal) {
        signals.push(signal);
        yield { type: 'status', phase: 'answering' };
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      },
    };
  }

  it('stops a streaming answer by aborting its signal', async () => {
    const client = hangingClient();
    await render(<ChatScreen client={client} openUrl={() => undefined} />);
    await ask('Tell me a long story');
    await fireEvent.press(await screen.findByRole('button', { name: 'Stop' }));
    expect(client.signals[0]?.aborted).toBe(true);
    expect(await screen.findByText('Stopped.')).toBeTruthy();
  });

  it('does not send an empty message', async () => {
    const { client, transport } = chatWith(fixtureTurns.answered ?? []);
    await render(<ChatScreen client={client} openUrl={() => undefined} />);
    await fireEvent.changeText(screen.getByLabelText('Message'), '   ');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(transport.bodies).toHaveLength(0);
  });

  it('sends follow-ups in the same conversation and starts a new one on request', async () => {
    const { client, transport } = chatWith(fixtureTurns.answered ?? []);
    await render(
      <ChatScreen client={client} openUrl={() => undefined} onShowMemory={() => undefined} />,
    );
    await ask('First');
    await screen.findByRole('link', { name: 'Source 1: Example' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    });
    await ask('Follow-up');
    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: 'Source 1: Example' })).toHaveLength(2);
    });
    expect(transport.bodies[1]?.conversationId).toBeDefined();
    await fireEvent.press(screen.getByRole('button', { name: 'New conversation' }));
    expect(screen.queryByLabelText('You: First')).toBeNull();
    await ask('Fresh');
    await waitFor(() => {
      expect(transport.bodies).toHaveLength(3);
    });
    expect(transport.bodies[2]?.conversationId).toBeUndefined();
  });

  it('opens the memory view when asked', async () => {
    const { client } = chatWith([]);
    let opened = false;
    await render(
      <ChatScreen
        client={client}
        openUrl={() => undefined}
        onShowMemory={() => {
          opened = true;
        }}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'What I remember' }));
    expect(opened).toBe(true);
  });
});

describe('mobile feedback and announcements', () => {
  function fakeAccount(reply?: string, failing = false) {
    const sent: string[] = [];
    const account: AccountClient = {
      startSession: () => Promise.resolve('t'.repeat(43)),
      hasSession: () => Promise.resolve(true),
      memory: () => Promise.resolve([]),
      forget: () => Promise.resolve(),
      deleteEverything: () => Promise.resolve(),
      sendFeedback: (kind, text) => {
        sent.push(`${kind}: ${text}`);
        return failing ? Promise.reject(new Error('down')) : Promise.resolve(reply);
      },
    };
    return { account, sent };
  }

  it('sends feedback of the chosen kind on an answered turn', async () => {
    const { client } = chatWith(fixtureTurns.answered ?? []);
    const { account, sent } = fakeAccount();
    await render(<ChatScreen client={client} account={account} openUrl={() => undefined} />);
    await ask('Hello');
    await fireEvent.press(await screen.findByRole('button', { name: 'Send feedback' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Correction' }));
    await fireEvent.changeText(screen.getByLabelText('Details'), 'The year is wrong.');
    await fireEvent.press(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(/I review feedback before anything changes/)).toBeTruthy();
    expect(sent).toEqual(['correction: The year is wrong.']);
  });

  it('shows crisis resources when the server answers with them', async () => {
    const { client } = chatWith(fixtureTurns.answered ?? []);
    const crisis = fakeAccount('Call or text 988.');
    await render(<ChatScreen client={client} account={crisis.account} openUrl={() => undefined} />);
    await ask('Hello');
    await fireEvent.press(await screen.findByRole('button', { name: 'Send feedback' }));
    await fireEvent.changeText(screen.getByLabelText('Details'), 'I feel hopeless');
    await fireEvent.press(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Call or text 988.')).toBeTruthy();
  });

  it('keeps the text and says so when feedback cannot be sent', async () => {
    const { client } = chatWith(fixtureTurns.answered ?? []);
    const { account } = fakeAccount(undefined, true);
    await render(<ChatScreen client={client} account={account} openUrl={() => undefined} />);
    await ask('Hello');
    await fireEvent.press(await screen.findByRole('button', { name: 'Send feedback' }));
    await fireEvent.changeText(screen.getByLabelText('Details'), 'Great answer');
    await fireEvent.press(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByLabelText('Details').props.value).toBe('Great answer');
  });

  it('offers no feedback on a refused turn', async () => {
    const { client } = chatWith(fixtureTurns.refusedMidAnswer ?? []);
    const { account } = fakeAccount();
    await render(<ChatScreen client={client} account={account} openUrl={() => undefined} />);
    await ask('Hello');
    await screen.findByText("I can't help with that.");
    expect(screen.queryByRole('button', { name: 'Send feedback' })).toBeNull();
  });

  it('announces a finished answer once, for screen readers that ignore live regions', async () => {
    const { client } = chatWith(fixtureTurns.refused ?? []);
    const spoken: string[] = [];
    await render(
      <ChatScreen client={client} openUrl={() => undefined} announce={(m) => spoken.push(m)} />,
    );
    await ask('Hello');
    await screen.findByText("I can't help with that.");
    await waitFor(() => {
      expect(spoken).toEqual(["I can't help with that."]);
    });
  });
});
