import type { AccountClient, FeedbackKind } from '@local-ai/client';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors } from './theme';

const maxFeedbackChars = 1000;

const kinds: readonly { readonly kind: FeedbackKind; readonly label: string }[] = [
  { kind: 'feedback', label: 'Feedback' },
  { kind: 'correction', label: 'Correction' },
  { kind: 'preference', label: 'Remember this' },
];

type State = 'closed' | 'open' | 'sending' | 'sent' | 'failed';

/**
 * Sends feedback, a correction or a preference for my review (ADR-0009), as
 * the web app does. Nothing changes the assistant until I approve it; text
 * that reads as self-harm is answered with crisis resources.
 */
export function Feedback({ account }: { readonly account: AccountClient }): ReactElement {
  const [state, setState] = useState<State>('closed');
  const [kind, setKind] = useState<FeedbackKind>('feedback');
  const [text, setText] = useState('');
  const [support, setSupport] = useState<string | undefined>(undefined);

  if (state === 'closed') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setState('open');
        }}
      >
        <Text style={styles.link}>Send feedback</Text>
      </Pressable>
    );
  }
  if (state === 'sent') {
    return (
      <Text
        style={support === undefined ? styles.note : styles.support}
        accessibilityLiveRegion="polite"
      >
        {support ?? 'Thanks. I review feedback before anything changes.'}
      </Text>
    );
  }

  const send = async (): Promise<void> => {
    if (text.trim() === '') return;
    setState('sending');
    try {
      setSupport(await account.sendFeedback(kind, text.trim(), AbortSignal.timeout(15_000)));
      setText('');
      setState('sent');
    } catch {
      setState('failed');
    }
  };

  return (
    <View accessibilityLabel="Feedback" style={styles.form}>
      <View style={styles.kinds} accessibilityRole="radiogroup" accessibilityLabel="Type">
        {kinds.map((k) => (
          <Pressable
            key={k.kind}
            accessibilityRole="radio"
            accessibilityState={{ checked: kind === k.kind }}
            style={[styles.kind, kind === k.kind ? styles.kindChosen : null]}
            onPress={() => {
              setKind(k.kind);
            }}
          >
            <Text style={kind === k.kind ? styles.kindChosenText : styles.kindText}>{k.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.input}
        accessibilityLabel="Details"
        value={text}
        maxLength={maxFeedbackChars}
        multiline
        onChangeText={setText}
      />
      {state === 'failed' && (
        <Text style={styles.error} accessibilityRole="alert">
          Feedback could not be sent. Please try again.
        </Text>
      )}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: state === 'sending' || text.trim() === '' }}
          disabled={state === 'sending' || text.trim() === ''}
          onPress={() => void send()}
        >
          <Text style={styles.link}>Submit</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setState('closed');
          }}
        >
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: 8, gap: 6 },
  kinds: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  kind: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  kindChosen: { backgroundColor: colors.link, borderColor: colors.link },
  kindText: { color: colors.text },
  kindChosenText: { color: colors.onLink },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 8,
    color: colors.text,
  },
  actions: { flexDirection: 'row', gap: 16 },
  link: { color: colors.link, textDecorationLine: 'underline', paddingVertical: 6 },
  note: { color: colors.muted, marginTop: 6 },
  support: { color: colors.text, fontStyle: 'italic', marginTop: 6 },
  error: { color: colors.danger },
});
