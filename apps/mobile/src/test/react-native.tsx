/**
 * A stand-in for react-native in Vitest. React Native's own entry point is Flow
 * source that needs its Jest preset, so the tests render the same component
 * tree onto plain host elements with the names React Native Testing Library
 * looks for (Text, TextInput). It checks behaviour, not native rendering; the
 * device check is in apps/mobile/README.md.
 */
import type { ReactElement, ReactNode } from 'react';
import { createElement } from 'react';

type Props = Record<string, unknown> & { readonly children?: ReactNode };

function host(name: string): (props: Props) => ReactElement {
  return function Host(props: Props) {
    return createElement(name, props);
  };
}

export const View = host('View');
export const Text = host('Text');
export const TextInput = host('TextInput');
export const ScrollView = host('RCTScrollView');
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
