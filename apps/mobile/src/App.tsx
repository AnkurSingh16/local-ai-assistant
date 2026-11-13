import { createAccountClient, createChatClient } from '@local-ai/client';
import { StatusBar } from 'expo-status-bar';
import { fetch as expoFetch } from 'expo/fetch';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Linking, StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ChatScreen } from './ChatScreen';
import { apiBaseUrl } from './config';
import { MemoryScreen } from './MemoryScreen';
import { secureTokenStore } from './secure-store';
import { createSession } from './session';
import { colors } from './theme';

/**
 * The composition root of the Expo app. `expo/fetch` streams the response body
 * on iOS and Android, which React Native's built-in fetch does not, and the
 * session token travels as a bearer header from secure storage (ADR-0007,
 * ADR-0009).
 */
export function App(): ReactElement {
  const session = useMemo(() => createSession(secureTokenStore), []);
  const clients = useMemo(() => {
    // expo/fetch takes the same arguments as fetch, with a narrower RequestInit.
    const fetchLike = (input: string, init: RequestInit): Promise<Response> =>
      expoFetch(input, {
        headers: new Headers(init.headers),
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    return {
      chat: createChatClient({ baseUrl: apiBaseUrl, fetch: fetchLike, token: session.token }),
      account: createAccountClient({ baseUrl: apiBaseUrl, fetch: fetchLike, token: session.token }),
    };
  }, [session]);
  const [showMemory, setShowMemory] = useState(false);
  const [chatKey, setChatKey] = useState(0);

  useEffect(() => {
    // Best effort: without a session the assistant still answers, just without memory.
    void session.ensure(clients.account, AbortSignal.timeout(10_000)).catch(() => undefined);
  }, [session, clients]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar style="dark" />
        {showMemory ? (
          <MemoryScreen
            account={clients.account}
            onClose={() => {
              setShowMemory(false);
            }}
            onDeletedEverything={() => {
              setChatKey((k) => k + 1);
              void session
                .forget()
                .then(() => session.ensure(clients.account, AbortSignal.timeout(10_000)))
                .catch(() => undefined);
            }}
          />
        ) : (
          <ChatScreen
            key={chatKey}
            client={clients.chat}
            openUrl={(url) => void Linking.openURL(url)}
            onShowMemory={() => {
              setShowMemory(true);
            }}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.bg } });
