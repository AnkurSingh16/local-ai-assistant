import type { AccountClient, MemoryEntry } from '@local-ai/client';
import { memoryDisclosure } from '@local-ai/client';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadow } from './theme';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: readonly MemoryEntry[] }
  | { readonly kind: 'error' }
  | { readonly kind: 'deleted' };

const timeoutMs = 10_000;

/** Lists what is remembered about this session and deletes it, one item or all (ADR-0009). */
export function MemoryScreen({
  account,
  onClose,
  onDeletedEverything,
}: {
  readonly account: AccountClient;
  readonly onClose: () => void;
  readonly onDeletedEverything: () => void;
}): ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', items: await account.memory(AbortSignal.timeout(timeoutMs)) });
    } catch {
      setState({ kind: 'error' });
    }
  }, [account]);

  useEffect(() => {
    void load();
  }, [load]);

  const forget = async (id: string): Promise<void> => {
    try {
      await account.forget(id, AbortSignal.timeout(timeoutMs));
      await load();
    } catch {
      setState({ kind: 'error' });
    }
  };

  const deleteEverything = async (): Promise<void> => {
    try {
      await account.deleteEverything(AbortSignal.timeout(timeoutMs));
      setState({ kind: 'deleted' });
      onDeletedEverything();
    } catch {
      setState({ kind: 'error' });
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          What I remember
        </Text>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}>
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
      </View>
      <Text style={styles.note}>{memoryDisclosure}</Text>
      {state.kind === 'loading' && <Text style={styles.note}>Loading…</Text>}
      {state.kind === 'error' && (
        <View>
          <Text style={styles.error} accessibilityRole="alert">
            That didn&apos;t work. Please try again.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setState({ kind: 'loading' });
              void load();
            }}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      )}
      {state.kind === 'deleted' && (
        <Text style={styles.text}>Everything stored under your session is deleted.</Text>
      )}
      {state.kind === 'ready' && (
        <View>
          <View style={styles.card}>
            {state.items.length === 0 ? (
              <Text style={[styles.text, styles.empty]}>
                Nothing is remembered yet. Items appear here only after I approve them.
              </Text>
            ) : (
              state.items.map((item) => (
                <View key={item.id} style={styles.item}>
                  <Text style={[styles.text, styles.itemText]}>
                    {item.always ? `${item.content} (used in every answer)` : item.content}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Forget: ${item.content}`}
                    onPress={() => void forget(item.id)}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>Forget</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>
          {confirming ? (
            <View accessibilityLabel="Confirm deletion" style={styles.confirm}>
              <Text style={styles.text}>
                Delete your conversations, remembered items and feedback? This cannot be undone.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void deleteEverything()}
                style={[styles.button, styles.dangerSolid]}
              >
                <Text style={styles.dangerSolidText}>Yes, delete everything</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setConfirming(false);
                }}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setConfirming(true);
              }}
              style={[styles.button, styles.dangerOutline]}
            >
              <Text style={styles.dangerText}>Delete everything</Text>
            </Pressable>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  text: { color: colors.text, fontSize: 15, lineHeight: 22 },
  note: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  error: { color: colors.errText },
  card: { backgroundColor: colors.surface, borderRadius: radius, padding: 4, ...shadow },
  item: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  itemText: { flex: 1 },
  empty: { padding: 12 },
  button: {
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  buttonText: { color: colors.text, fontWeight: '600' },
  dangerOutline: { borderColor: colors.errLine, marginTop: 8 },
  dangerText: { color: colors.danger, fontWeight: '600' },
  dangerSolid: { backgroundColor: colors.danger, borderColor: colors.danger },
  dangerSolidText: { color: colors.onAccent, fontWeight: '600' },
  confirm: {
    marginTop: 8,
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.errBg,
    borderWidth: 1,
    borderColor: colors.errLine,
  },
});
