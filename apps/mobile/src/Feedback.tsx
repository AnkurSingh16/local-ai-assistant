import type { AccountClient, FeedbackKind } from '@local-ai/client';
import { maxFeedbackChars } from '@local-ai/contract';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors } from './theme';

const kinds: readonly { readonly kind: FeedbackKind; readonly label: string }[] = [
  { kind: 'feedback', label: 'Feedback' },
  { kind: 'correction', label: 'Correction' },
  { kind: 'preference', label: 'Remember this' },
];

type State = 'closed' | 'open' | 'sending' | 'sent' | 'failed';

const sentMessage = 'Thanks. I review feedback before anything changes.';
const failedMessage = 'Feedback could not be sent. Please try again.';

/**
 * Sends feedback, a correction or a preference for my review (ADR-0009), as
 * the web app does. Nothing changes the assistant until I approve it; text
 * that reads as self-harm is answered with crisis resources.
 */
export function Feedback({
  account,
  announce,
}: {
  readonly account: AccountClient;
  /**
   * Reads the outcome aloud. The form disappears when it is sent, and VoiceOver
   * does not read live regions, so without this a screen-reader user would
   * never hear the confirmation or the crisis resources.
   */
  readonly announce: (message: string) => void;
}): ReactElement {
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
        <Text style={styles.open}>Send feedback</Text>
      </Pressable>
    );
  }
  if (state === 'sent') {
    return (
      <Text
        style={support === undefined ? styles.note : styles.support}
        accessibilityLiveRegion="polite"
      >
        {support ?? sentMessage}
      </Text>
    );
  }

  const send = async (): Promise<void> => {
    if (text.trim() === '') return;
    setState('sending');
    try {
      const reply = await account.sendFeedback(kind, text.trim(), AbortSignal.timeout(15_000));
      setSupport(reply);
      setText('');
      setState('sent');
      announce(reply ?? sentMessage);
    } catch {
      setState('failed');
      announce(failedMessage);
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
          {failedMessage}
        </Text>
      )}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: state === 'sending' || text.trim() === '' }}
          disabled={state === 'sending' || text.trim() === ''}
          style={[
            styles.button,
            styles.primary,
            (state === 'sending' || text.trim() === '') && styles.disabled,
          ]}
          onPress={() => void send()}
        >
          <Text style={styles.primaryText}>Submit</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setState('closed');
          }}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  open: { color: colors.muted, fontSize: 14, fontWeight: '600', paddingVertical: 4 },
  form: {
    marginTop: 4,
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.surface2,
  },
  kinds: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  kind: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  kindChosen: { backgroundColor: colors.accent, borderColor: colors.accent },
  kindText: { color: colors.text, fontSize: 14 },
  kindChosenText: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 10,
    fontSize: 15,
    color: colors.text,
    textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', gap: 8 },
  button: {
    minHeight: 38,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  buttonText: { color: colors.text, fontWeight: '600' },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  primaryText: { color: colors.onAccent, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  note: { color: colors.muted, fontSize: 14 },
  support: {
    color: colors.warnText,
    backgroundColor: colors.warnBg,
    borderRadius: 12,
    padding: 12,
    overflow: 'hidden',
  },
  error: { color: colors.errText },
});
