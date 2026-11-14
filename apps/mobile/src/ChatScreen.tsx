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
import { colors, radius, shadow } from './theme';

const phaseLabels: Partial<Record<TurnView['phase'], string>> = {
  sending: 'Sending…',
  moderating: 'Checking your message…',
  searching: 'Searching the web…',
  reading: 'Reading sources…',
  answering: 'Writing…',
};

/** Starting points for an empty conversation, as on the web: one needs the web, the rest do not. */
const suggestions = [
  'What is the latest version of Node.js?',
  'Explain how vaccines train the immune system',
  'Write a haiku about autumn rain',
  'Help me plan a relaxed weekend in Lisbon',
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The assistant's mark, a purple disc with a four-pointed star, as on the web. */
function Mark({ size = 30 }: { readonly size?: number }): ReactElement {
  return (
    <View
      style={[styles.mark, { width: size, height: size, borderRadius: size / 2 }]}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Text style={[styles.markGlyph, { fontSize: size * 0.5 }]}>{'\u2726'}</Text>
    </View>
  );
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
      <View style={styles.questionRow}>
        <Text style={styles.question} accessibilityLabel={`You: ${turn.question}`}>
          {turn.question}
        </Text>
      </View>
      <View style={styles.replyRow}>
        <Mark size={28} />
        <View style={styles.reply} accessibilityLabel="Assistant" accessibilityLiveRegion="polite">
          {toBlocks(view.text).map((block, i) => (
            // Blocks only ever append, so the index is a stable key.
            <Text key={i} style={block.kind === 'code' ? styles.code : styles.answer} selectable>
              {block.content}
            </Text>
          ))}
          {view.citations.length > 0 && (
            <View accessibilityLabel="Sources" style={styles.sources}>
              {view.citations.map((c) => (
                <Pressable
                  key={c.n}
                  accessibilityRole="link"
                  accessibilityLabel={`Source ${String(c.n)}: ${c.title === '' ? hostOf(c.url) : c.title}`}
                  style={({ pressed }) => [styles.source, pressed && styles.pressed]}
                  onPress={() => {
                    // The contract already allows only https; checked again before leaving the app.
                    if (c.url.startsWith('https://')) openUrl(c.url);
                  }}
                >
                  <Text style={styles.sourceN}>{String(c.n)}</Text>
                  <View style={styles.sourceBody}>
                    <Text style={styles.sourceTitle} numberOfLines={2}>
                      {c.title === '' ? hostOf(c.url) : c.title}
                    </Text>
                    <Text style={styles.sourceHost} numberOfLines={1}>
                      {hostOf(c.url)}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}
          {label !== undefined && (
            <View style={styles.statusRow}>
              <View style={styles.statusDot} />
              <Text style={styles.status}>{label}</Text>
            </View>
          )}
          {view.truncated && <Text style={styles.note}>The answer reached its length limit.</Text>}
          {view.refusal !== undefined && (
            <Text style={styles.refusal} accessibilityRole="alert">
              {view.refusal.message}
            </Text>
          )}
          {view.error !== undefined && (
            <View style={styles.errorCard}>
              <Text style={styles.error} accessibilityRole="alert">
                {view.error.message}
              </Text>
              {view.error.retryable && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
                  onPress={() => {
                    onRetry(turn.question);
                  }}
                >
                  <Text style={styles.pillText}>Try again</Text>
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

  const ask = (question: string): void => {
    if (chat.busy) return;
    atEnd.current = true;
    void chat.send(question);
  };

  const canSend = draft.trim() !== '';

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <Mark size={32} />
          <View>
            <Text style={styles.title} accessibilityRole="header">
              Local AI Assistant
            </Text>
            <Text style={styles.badge}>Private · runs on your computer</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          {chat.turns.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New conversation"
              accessibilityState={{ disabled: chat.busy }}
              disabled={chat.busy}
              style={({ pressed }) => [
                styles.ghost,
                chat.busy && styles.disabled,
                pressed && styles.pressed,
              ]}
              onPress={() => {
                chat.reset();
              }}
            >
              <Text style={styles.ghostText}>New</Text>
            </Pressable>
          )}
          {onShowMemory !== undefined && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="What I remember"
              style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}
              onPress={onShowMemory}
            >
              <Text style={styles.ghostText}>Memory</Text>
            </Pressable>
          )}
        </View>
      </View>
      <ScrollView
        ref={scroll}
        style={styles.turns}
        contentContainerStyle={styles.turnsContent}
        accessibilityLabel="Conversation"
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={100}
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
        }}
        onContentSizeChange={() => {
          if (chat.busy && atEnd.current) scroll.current?.scrollToEnd({ animated: true });
        }}
      >
        {chat.turns.length === 0 && (
          <View style={styles.welcome}>
            <Mark size={56} />
            <Text style={styles.welcomeTitle} accessibilityRole="header">
              How can I help today?
            </Text>
            <Text style={styles.subtitle}>
              Answers come from the model, or from fresh web results with numbered sources when you
              ask about something recent.
            </Text>
            <View style={styles.suggestions} accessibilityLabel="Suggestions">
              {suggestions.map((q) => (
                <Pressable
                  key={q}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
                  onPress={() => {
                    ask(q);
                  }}
                >
                  <Text style={styles.suggestionText}>{q}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
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
      <View style={styles.dock}>
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
              accessibilityLabel="Stop"
              hitSlop={8}
              style={({ pressed }) => [styles.round, styles.roundStop, pressed && styles.pressed]}
              onPress={() => {
                chat.stop();
              }}
            >
              <View style={styles.stopSquare} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              hitSlop={8}
              style={({ pressed }) => [
                styles.round,
                !canSend && styles.roundIdle,
                pressed && styles.pressed,
              ]}
              onPress={send}
            >
              <Text style={styles.roundGlyph}>{'\u2191'}</Text>
            </Pressable>
          )}
        </View>
        <Text style={styles.hint}>Answers can be wrong; check anything important.</Text>
      </View>
    </View>
  );
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  title: { fontSize: 17, fontWeight: '700', color: colors.text },
  badge: { fontSize: 12, color: colors.muted, marginTop: 1 },
  headerActions: { flexDirection: 'row', gap: 8 },
  ghost: {
    minHeight: 36,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  ghostText: { color: colors.text, fontWeight: '600', fontSize: 14 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  mark: { backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  markGlyph: { color: colors.onAccent, fontWeight: '700' },
  turns: { flex: 1 },
  turnsContent: { padding: 16, paddingBottom: 8, flexGrow: 1 },
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  welcomeTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    marginTop: 16,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.muted,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 20,
    lineHeight: 21,
    maxWidth: 340,
  },
  suggestions: { alignSelf: 'stretch', gap: 10 },
  suggestion: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  suggestionText: { color: colors.text, fontSize: 15 },
  turn: { marginBottom: 20, gap: 10 },
  questionRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  question: {
    maxWidth: '85%',
    backgroundColor: colors.accent,
    color: colors.onAccent,
    fontSize: 16,
    lineHeight: 22,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderBottomRightRadius: 6,
    overflow: 'hidden',
  },
  replyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  reply: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius,
    borderTopLeftRadius: 6,
    padding: 14,
    gap: 8,
    ...shadow,
  },
  answer: { color: colors.text, fontSize: 16, lineHeight: 24 },
  code: {
    color: colors.text,
    fontFamily: mono,
    fontSize: 13,
    backgroundColor: colors.codeBg,
    borderRadius: 10,
    padding: 10,
    overflow: 'hidden',
  },
  sources: { gap: 6, marginTop: 2 },
  source: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface2,
    borderRadius: 12,
    padding: 10,
  },
  sourceN: {
    width: 22,
    height: 22,
    lineHeight: 22,
    borderRadius: 11,
    overflow: 'hidden',
    textAlign: 'center',
    backgroundColor: colors.accentSoft,
    color: colors.link,
    fontSize: 12,
    fontWeight: '700',
  },
  sourceBody: { flex: 1 },
  sourceTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  sourceHost: { color: colors.muted, fontSize: 12, marginTop: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  status: { color: colors.muted, fontSize: 14 },
  note: { color: colors.muted, fontSize: 14 },
  refusal: {
    color: colors.warnText,
    backgroundColor: colors.warnBg,
    borderColor: colors.warnLine,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    lineHeight: 21,
    overflow: 'hidden',
  },
  errorCard: {
    backgroundColor: colors.errBg,
    borderColor: colors.errLine,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 10,
    alignItems: 'flex-start',
  },
  error: { color: colors.errText, lineHeight: 21 },
  pill: {
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.errLine,
  },
  pillText: { color: colors.errText, fontWeight: '600' },
  dock: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 4, backgroundColor: colors.bg },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    backgroundColor: colors.surface,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.line,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    ...shadow,
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 140,
    fontSize: 16,
    paddingTop: 8,
    paddingBottom: 8,
    color: colors.text,
  },
  round: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  roundIdle: { backgroundColor: colors.line },
  roundStop: { backgroundColor: colors.text },
  roundGlyph: { color: colors.onAccent, fontSize: 18, fontWeight: '700' },
  stopSquare: { width: 12, height: 12, borderRadius: 3, backgroundColor: colors.onAccent },
  hint: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 6 },
});
