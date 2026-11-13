import type { AccountClient, MemoryEntry } from '@local-ai/client';
import { memoryDisclosure } from '@local-ai/client';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from './theme';

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
    <ScrollView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          What I remember
        </Text>
        <Pressable accessibilityRole="button" onPress={onClose}>
          <Text style={styles.link}>Close</Text>
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
          >
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      )}
      {state.kind === 'deleted' && (
        <Text style={styles.text}>Everything stored under your session is deleted.</Text>
      )}
      {state.kind === 'ready' && (
        <View>
          {state.items.length === 0 ? (
            <Text style={styles.text}>
              Nothing is remembered yet. Items appear here only after I approve them.
            </Text>
          ) : (
            state.items.map((item) => (
              <View key={item.id} style={styles.item}>
                <Text style={[styles.text, styles.itemText]}>{item.content}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Forget: ${item.content}`}
                  onPress={() => void forget(item.id)}
                >
                  <Text style={styles.link}>Forget</Text>
                </Pressable>
              </View>
            ))
          )}
          {confirming ? (
            <View accessibilityLabel="Confirm deletion" style={styles.confirm}>
              <Text style={styles.text}>
                Delete your conversations, remembered items and feedback? This cannot be undone.
              </Text>
              <Pressable accessibilityRole="button" onPress={() => void deleteEverything()}>
                <Text style={styles.danger}>Yes, delete everything</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setConfirming(false);
                }}
              >
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setConfirming(true);
              }}
            >
              <Text style={styles.danger}>Delete everything</Text>
            </Pressable>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: colors.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '600', color: colors.text },
  text: { color: colors.text, marginVertical: 4 },
  note: { color: colors.muted, marginVertical: 8 },
  error: { color: colors.danger, marginVertical: 8 },
  link: { color: colors.link, textDecorationLine: 'underline', paddingVertical: 8 },
  danger: { color: colors.danger, textDecorationLine: 'underline', paddingVertical: 8 },
  item: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  itemText: { flex: 1 },
  confirm: { marginTop: 8 },
});
