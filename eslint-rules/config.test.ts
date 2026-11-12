import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Lints snippets through the repository's own config, as an existing source
 * file, to prove the rule is wired in and cannot be switched off with a comment.
 */
const root = `${import.meta.dirname}/..`;
const filePath = `${root}/packages/providers/src/mock/sleep.ts`;
const header = "import type { ModeratedText } from '@local-ai/core';\n";

async function ruleIds(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(header + code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
}

describe('repository ESLint config', () => {
  it('applies the brand rule to package sources', async () => {
    expect(await ruleIds("export const a = 'x' as ModeratedText;\n")).toContain(
      'local/no-brand-cast',
    );
  }, 30_000);

  it.each([
    "// eslint-disable-next-line local/no-brand-cast\nexport const a = 'x' as ModeratedText;\n",
    "/* eslint-disable local/no-brand-cast */\nexport const a = 'x' as ModeratedText;\n",
    "/* eslint-disable */\nexport const a = 'x' as ModeratedText;\n",
    "// eslint-disable-next-line eslint-comments/no-restricted-disable, local/no-brand-cast\nexport const a = 'x' as ModeratedText;\n",
  ])(
    'rejects a disable comment for it: %j',
    async (code) => {
      const ids = await ruleIds(code);
      expect(ids.some((id) => id.startsWith('eslint-comments/'))).toBe(true);
    },
    30_000,
  );
});
