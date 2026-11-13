import type { ChatClient, TurnView } from '@local-ai/client';
import { toBlocks } from '@local-ai/client';
import type { Turn } from '@local-ai/client/react';
import { useChat } from '@local-ai/client/react';
import { maxMessageChars } from '@local-ai/contract';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors } from './theme';

const phaseLabels: Partial<Record<TurnView['phase'], string>> = {
  sending: 'Sending…',
  moderating: 'Checking your message…',
  searching: 'Searching the web…',
  reading: 'Reading sources…',
  answering: 'Writing…',
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function TurnItem({
  turn,
  busy,
  onRetry,
  openUrl,
}: {
  readonly turn: Turn;
  readonly busy: boolean;
  readonly onRetry: (question: string) => void;
  readonly openUrl: (url: string) => void;
}): ReactElement {
  const { view } = turn;
  const label = phaseLabels[view.phase];
  return (
    <View style={styles.turn}>
      <Text style={styles.question} accessibilityLabel={`You: ${turn.question}`}>
        {turn.question}
      </Text>
      <View accessibilityLabel="Assistant" accessibilityLiveRegion="polite">
        {toBlocks(view.text).map((block, i) => (
          // Blocks only ever append, so the index is a stable key.
          <Text key={i} style={block.kind === 'code' ? styles.code : styles.answer} selectable>
            {block.content}
          </Text>
        ))}
        {view.citations.length > 0 && (
          <View accessibilityLabel="Sources">
            {view.citations.map((c) => (
              <Pressable
                key={c.n}
                accessibilityRole="link"
                accessibilityLabel={`Source ${String(c.n)}: ${c.title === '' ? hostOf(c.url) : c.title}`}
                onPress={() => {
                  openUrl(c.url);
                }}
              >
                <Text style={styles.source}>
                  {`[${String(c.n)}] ${c.title === '' ? hostOf(c.url) : c.title}`}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {label !== undefined && <Text style={styles.status}>{label}</Text>}
        {view.truncated && <Text style={styles.note}>The answer reached its length limit.</Text>}
        {view.refusal !== undefined && (
          <Text style={styles.refusal} accessibilityRole="alert">
            {view.refusal.message}
          </Text>
        )}
        {view.error !== undefined && (
          <View>
            <Text style={styles.error} accessibilityRole="alert">
              {view.error.message}
            </Text>
            {view.error.retryable && (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => {
                  onRetry(turn.question);
                }}
              >
                <Text style={styles.link}>Try again</Text>
              </Pressable>
            )}
          </View>
        )}
        {view.phase === 'cancelled' && <Text style={styles.note}>Stopped.</Text>}
      </View>
    </View>
  );
}

/** The conversation: streamed answers with sources, a composer, and Stop while answering. */
export function ChatScreen({
  client,
  openUrl,
  onShowMemory,
}: {
  readonly client: ChatClient;
  /** Opens a cited source in the system browser; injected so tests need no native module. */
  readonly openUrl: (url: string) => void;
  readonly onShowMemory?: () => void;
}): ReactElement {
  const chat = useChat(client);
  const [draft, setDraft] = useState('');

  const send = (): void => {
    if (chat.busy || draft.trim() === '') return;
    const question = draft;
    setDraft('');
    void chat.send(question);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          Local AI Assistant
        </Text>
        <View style={styles.headerActions}>
          {chat.turns.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: chat.busy }}
              disabled={chat.busy}
              onPress={() => {
                chat.reset();
              }}
            >
              <Text style={styles.link}>New conversation</Text>
            </Pressable>
          )}
          {onShowMemory !== undefined && (
            <Pressable accessibilityRole="button" onPress={onShowMemory}>
              <Text style={styles.link}>What I remember</Text>
            </Pressable>
          )}
        </View>
      </View>
      <Text style={styles.note}>
        Runs on your computer. Answers can be wrong; check anything important.
      </Text>
      <ScrollView style={styles.turns} accessibilityLabel="Conversation">
        {chat.turns.map((turn) => (
          <TurnItem
            key={turn.id}
            turn={turn}
            busy={chat.busy}
            openUrl={openUrl}
            onRetry={(q) => void chat.send(q)}
          />
        ))}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          accessibilityLabel="Message"
          placeholder="Ask anything"
          placeholderTextColor={colors.muted}
          value={draft}
          maxLength={maxMessageChars}
          multiline
          onChangeText={setDraft}
        />
        {chat.busy ? (
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={() => {
              chat.stop();
            }}
          >
            <Text style={styles.buttonText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: draft.trim() === '' }}
            disabled={draft.trim() === ''}
            style={styles.button}
            onPress={send}
          >
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: colors.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerActions: { flexDirection: 'row', gap: 16 },
  title: { fontSize: 20, fontWeight: '600', color: colors.text },
  turns: { flex: 1, marginTop: 8 },
  turn: { marginBottom: 16 },
  question: { fontWeight: '600', color: colors.text, marginBottom: 4 },
  answer: { color: colors.text, marginBottom: 8, lineHeight: 22 },
  code: {
    color: colors.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: colors.codeBg,
    padding: 8,
    marginBottom: 8,
  },
  source: { color: colors.link, marginBottom: 4 },
  status: { color: colors.muted, fontStyle: 'italic' },
  note: { color: colors.muted, marginVertical: 4 },
  refusal: { color: colors.text, fontStyle: 'italic' },
  error: { color: colors.danger },
  link: { color: colors.link, textDecorationLine: 'underline' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 10,
    color: colors.text,
  },
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.link,
  },
  buttonText: { color: colors.onLink, fontWeight: '600' },
});
