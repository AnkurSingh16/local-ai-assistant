declare const moderatedBrand: unique symbol;
declare const untrustedWebBrand: unique symbol;

/**
 * Text that has passed the guardrail pipeline. It is minted in exactly one place,
 * `packages/guardrails/src/mint.ts`, and lint forbids casting to it anywhere else,
 * so stores and the agent cannot be handed text that skipped moderation.
 */
export type ModeratedText = string & { readonly [moderatedBrand]: true };

/**
 * Web content that has been wrapped as untrusted data. It is minted only by the
 * wrapping function in `packages/tools`, so page text cannot reach a prompt
 * without its delimiters.
 */
export type UntrustedWebText = string & { readonly [untrustedWebBrand]: true };
