import type { AccountClient, MemoryEntry } from '@local-ai/client';
import { fireEvent, render, screen } from '@testing-library/react-native/dist/pure';
import { describe, expect, it } from 'vitest';

import { MemoryScreen } from './MemoryScreen';

function fakeAccount(items: MemoryEntry[], failing = false) {
  const calls: string[] = [];
  let current = [...items];
  const account: AccountClient = {
    startSession: () => Promise.resolve('t'.repeat(43)),
    hasSession: () => Promise.resolve(true),
    memory: () => (failing ? Promise.reject(new Error('down')) : Promise.resolve(current)),
    forget: (id) => {
      calls.push(`forget ${id}`);
      current = current.filter((i) => i.id !== id);
      return Promise.resolve();
    },
    deleteEverything: () => {
      calls.push('delete everything');
      current = [];
      return Promise.resolve();
    },
    sendFeedback: () => Promise.resolve(undefined),
  };
  return { account, calls };
}

const sam = { id: 'm1', content: 'Call me Sam.', createdAt: '2026-11-13T00:00:00Z' };

describe('mobile memory screen', () => {
  it('lists what is remembered with the disclosure, and forgets one item', async () => {
    const { account, calls } = fakeAccount([sam]);
    await render(
      <MemoryScreen
        account={account}
        onClose={() => undefined}
        onDeletedEverything={() => undefined}
      />,
    );
    expect(await screen.findByText('Call me Sam.')).toBeTruthy();
    expect(screen.getByText(/deleted for real/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Forget: Call me Sam.' }));
    expect(await screen.findByText(/Nothing is remembered yet/)).toBeTruthy();
    expect(calls).toEqual(['forget m1']);
  });

  it('asks before deleting everything, then reports it', async () => {
    const { account, calls } = fakeAccount([]);
    let deleted = false;
    await render(
      <MemoryScreen
        account={account}
        onClose={() => undefined}
        onDeletedEverything={() => {
          deleted = true;
        }}
      />,
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete everything' }));
    expect(calls).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: 'Yes, delete everything' }));
    expect(await screen.findByText(/is deleted\./)).toBeTruthy();
    expect(calls).toEqual(['delete everything']);
    expect(deleted).toBe(true);
  });

  it('can cancel deleting everything', async () => {
    const { account, calls } = fakeAccount([]);
    await render(
      <MemoryScreen
        account={account}
        onClose={() => undefined}
        onDeletedEverything={() => undefined}
      />,
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete everything' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('says so when memory cannot be loaded, and closes', async () => {
    const { account } = fakeAccount([], true);
    let closed = false;
    await render(
      <MemoryScreen
        account={account}
        onClose={() => {
          closed = true;
        }}
        onDeletedEverything={() => undefined}
      />,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(closed).toBe(true);
  });
});
