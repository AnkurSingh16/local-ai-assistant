/**
 * A stand-in for react-native in Vitest. React Native's own entry point is Flow
 * source that needs its Jest preset, so the tests render the same component
 * tree onto plain host elements with the names React Native Testing Library
 * looks for (Text, TextInput). It checks behaviour, not native rendering; the
 * device check is in apps/mobile/README.md.
 */
import type { ReactElement, ReactNode, Ref } from 'react';
import { createElement, useImperativeHandle } from 'react';

type Props = Record<string, unknown> & { readonly children?: ReactNode };

function host(name: string): (props: Props) => ReactElement {
  return function Host(props: Props) {
    return createElement(name, props);
  };
}

export const View = host('View');
export const Text = host('Text');
export const TextInput = host('TextInput');
/** Every scrollToEnd call, so tests can check when the list follows new text. */
export const scrollToEndCalls: number[] = [];

export function ScrollView({
  ref,
  ...props
}: Props & { readonly ref?: Ref<unknown> }): ReactElement {
  // Components call scrollToEnd on the ref; the stand-in records each call.
  useImperativeHandle(ref, () => ({
    scrollToEnd: () => {
      scrollToEndCalls.push(1);
    },
  }));
  return createElement('RCTScrollView', props);
}
export const SafeAreaView = host('View');

export function Pressable({ children, disabled, onPress, ...rest }: Props): ReactElement {
  return createElement(
    'View',
    { ...rest, accessible: true, onPress: disabled === true ? undefined : onPress },
    children,
  );
}

type Style = Readonly<Record<string, unknown>> | readonly Style[] | false | null | undefined;

function flatten(style: Style): Record<string, unknown> {
  if (style === false || style === null || style === undefined) return {};
  if (isStyleList(style)) {
    const out: Record<string, unknown> = {};
    for (const s of style) Object.assign(out, flatten(s));
    return out;
  }
  return { ...style };
}

function isStyleList(style: Style): style is readonly Style[] {
  return Array.isArray(style);
}

export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  flatten,
};

export const Linking = { openURL: (): Promise<void> => Promise.resolve() };

export const Platform = { OS: 'ios' };

export const AccessibilityInfo = { announceForAccessibility: (): void => undefined };
