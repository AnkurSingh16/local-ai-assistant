import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

import rule from './no-brand-cast.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: `${import.meta.dirname}/fixtures`,
    },
  },
});

const imp = "import type { ModeratedText, UntrustedWebText } from './brand.js';\n";
const brand = [{ messageId: 'brand' as const }];
const launder = [{ messageId: 'launder' as const }];

ruleTester.run('no-brand-cast', rule, {
  valid: [
    { code: `${imp}export const s = 'x' as string;` },
    { code: `${imp}export const s = ['a'] as const;` },
    { code: `${imp}export function f(m: ModeratedText): string { return m; }` },
    { code: `${imp}export const set = new Set<string>();` },
    { code: `${imp}export const a = JSON.parse('{}') as { text: string; n: number[] };` },
    { code: `${imp}export const a = new Map<string, Date>() as Map<string, Date>;` },
    {
      code: `${imp}export function isText(v: unknown): v is string { return typeof v === 'string'; }`,
    },
  ],
  invalid: [
    { code: `${imp}export const a = 'x' as ModeratedText;`, errors: brand },
    { code: `${imp}export const a = <UntrustedWebText>'x';`, errors: brand },
    { code: `${imp}export const a = 'x' as unknown as ModeratedText;`, errors: brand },
    { code: `${imp}export const a = 'x' as ModeratedText | undefined;`, errors: brand },
    {
      code: "import type { ModeratedText as M } from './brand.js';\nexport const a = 'x' as M;",
      errors: brand,
    },
    { code: `${imp}type M = ModeratedText;\nexport const a = 'x' as M;`, errors: brand },
    {
      code: "import type * as C from './brand.js';\nexport const a = 'x' as C.ModeratedText;",
      errors: brand,
    },
    { code: `${imp}export const a: ModeratedText = 'x' as never;`, errors: launder },
    {
      code: `${imp}export function brandIt<T>(s: string): T { return s as T; }`,
      errors: launder,
    },
    {
      code: `${imp}declare function brandIt<T>(s: string): T;\nexport const a = brandIt<ModeratedText>('x');`,
      errors: brand,
    },
    {
      code: `${imp}export function g(s: string): s is ModeratedText { return s.length > 0; }`,
      errors: brand,
    },
    { code: `${imp}export const a = JSON.parse('{}') as { text: ModeratedText };`, errors: brand },
    { code: `${imp}export const a = [] as ModeratedText[];`, errors: brand },
    {
      code: `${imp}export const a = Promise.resolve('x') as Promise<UntrustedWebText>;`,
      errors: brand,
    },
    {
      code: `${imp}interface Row { readonly nested: { readonly m: ModeratedText } }\nexport const a = {} as Row;`,
      errors: brand,
    },
  ],
});
