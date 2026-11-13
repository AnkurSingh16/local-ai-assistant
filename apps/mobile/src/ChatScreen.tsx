import type { AccountClient, ChatClient, TurnView } from '@local-ai/client';
import { toBlocks } from '@local-ai/client';
import type { Turn } from '@local-ai/client/react';
import { useChat } from '@local-ai/client/react';
import { maxMessageChars } from '@local-ai/contract';
import type { ReactElement } from 'react';
import type { ScrollViewInstance } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Feedback } from './Feedback';
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
  account,
  announce,
}: {
  readonly turn: Turn;
  readonly busy: boolean;
  readonly onRetry: (question: string) => void;
  readonly openUrl: (url: string) => void;
  readonly account: AccountClient | undefined;
  readonly announce: (message: string) => void;
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
                  // The contract already allows only https; checked again before leaving the app.
                  if (c.url.startsWith('https://')) openUrl(c.url);
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
        {account !== undefined && view.phase === 'done' && view.text !== '' && (
          <Feedback account={account} announce={announce} />
        )}
      </View>
    </View>
  );
}

/**
 * What a screen reader hears when a turn ends: the refusal or error as shown,
 * "Stopped." after Stop (not the partial answer the user just cut off), and for
 * an answer its first paragraph, so a long reply is not read out in one go.
 */
export function spokenSummary(view: TurnView): string {
  if (view.refusal !== undefined) return view.refusal.message;
  if (view.error !== undefined) return view.error.message;
  if (view.phase === 'cancelled') return 'Stopped.';
  const first = toBlocks(view.text).find((b) => b.kind === 'text')?.content ?? '';
  const sources = view.citations.length > 0 ? ' Sources are listed below.' : '';
  if (first === '') return `Answer ready.${sources}`;
  // Cut at a word boundary, so the screen reader never says half a word.
  const short = first.length <= 300 ? first : `${first.slice(0, first.lastIndexOf(' ', 300))}…`;
  return `${short}${sources}`;
}

function defaultAnnounce(message: string): void {
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
}

/** The conversation: streamed answers with sources, a composer, and Stop while answering. */
export function ChatScreen({
  client,
  account,
  openUrl,
  onShowMemory,
  announce = defaultAnnounce,
}: {
  readonly client: ChatClient;
  /** Session calls for feedback; without it no feedback form is shown. */
  readonly account?: AccountClient;
  /** Reads a finished answer aloud on iOS, where live regions are not announced. */
  readonly announce?: (message: string) => void;
  /** Opens a cited source in the system browser; injected so tests need no native module. */
  readonly openUrl: (url: string) => void;
  readonly onShowMemory?: () => void;
}): ReactElement {
  const chat = useChat(client);
  const [draft, setDraft] = useState('');
  const scroll = useRef<ScrollViewInstance>(null);
  // Follow new text only while the reader is at the end. Someone who scrolled
  // up to read, or opened feedback on an earlier answer, is left where they are.
  const atEnd = useRef(true);

  // VoiceOver ignores accessibilityLiveRegion (Android only), so a finished
  // answer, refusal or error is announced once when the turn ends.
  const last = chat.turns.at(-1);
  const announced = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (last === undefined || chat.busy || announced.current === last.id) return;
    announced.current = last.id;
    const v = last.view;
    announce(spokenSummary(v));
  }, [last, chat.busy, announce]);

  const send = (): void => {
    if (chat.busy || draft.trim() === '') return;
    const question = draft;
    setDraft('');
    // Asking something new means wanting to see its answer.
    atEnd.current = true;
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
      <ScrollView
        ref={scroll}
        style={styles.turns}
        accessibilityLabel="Conversation"
        scrollEventThrottle={100}
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
        }}
        onContentSizeChange={() => {
          if (chat.busy && atEnd.current) scroll.current?.scrollToEnd({ animated: true });
        }}
      >
        {chat.turns.map((turn) => (
          <TurnItem
            key={turn.id}
            turn={turn}
            busy={chat.busy}
            account={account}
            announce={announce}
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
