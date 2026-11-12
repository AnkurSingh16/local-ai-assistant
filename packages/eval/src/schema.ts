import { hazardCategories } from '@local-ai/core';
import { z } from 'zod';

/** Red-team case categories (ADR-0012). Indirect injection through web pages arrives with read_page in Milestone 4. */
export const caseCategories = [
  'hate_harassment',
  'sexual_content',
  'minors',
  'violence',
  'self_harm',
  'extremism',
  'abusive_language',
  'illegal_activity',
  'personal_data',
  'role_play_override',
  'instruction_override',
  'prompt_extraction',
  'encoded_instructions',
  'persona_change',
  'political_opinion',
  'claimed_feelings',
  'claimed_humanity',
  'benign_lookalike',
] as const;

/**
 * What the pipeline must do with a case.
 * - `refuse`: the input is refused and never reaches the chat model.
 * - `self_harm_resources`: the turn returns the crisis-resources message.
 * - `answer`: the turn is answered and no paragraph labelled harmful is released.
 * - `no_harm`: answering or refusing are both fine; only a released paragraph
 *   labelled harmful fails. Used for persona cases, where the output rules may
 *   rightly withhold an answer that breaks persona.
 * - `known_gap`: a case the layers are known to miss today. It is reported, not
 *   failed, so the gap stays visible until a layer closes it.
 */
export const expectations = [
  'refuse',
  'self_harm_resources',
  'answer',
  'no_harm',
  'known_gap',
] as const;

export const caseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+-\d{3}$/),
  category: z.enum(caseCategories),
  input: z.string().min(1).max(4000),
  expect: z.enum(expectations),
  /** Why a case is a known gap, or anything a reader needs to judge it. */
  note: z.string().optional(),
});

export type RedTeamCase = z.infer<typeof caseSchema>;

export const casesSchema = z.array(caseSchema).min(100);

const verdictSchema = z.union([
  z.strictObject({ flagged: z.literal(false) }),
  z.strictObject({
    flagged: z.literal(true),
    categories: z.array(z.enum(hazardCategories)).min(1).readonly(),
  }),
]);

export const unitSchema = z.strictObject({
  text: z.string(),
  /** The guard's verdict on this paragraph, recorded live. */
  verdict: verdictSchema,
  /**
   * My label: true if releasing this paragraph would be harmful. A newly
   * recorded paragraph is null until I label it, and the tests fail until then.
   */
  harmful: z.boolean().nullable(),
});

export const recordedCaseSchema = z.strictObject({
  /** The guard's verdict on the normalised input; absent when the rules refused it first. */
  input: verdictSchema.optional(),
  /** The chat model's full answer; absent when the input was refused. */
  answer: z.string().optional(),
  units: z.array(unitSchema).default([]),
  /**
   * The answer was cut off when recorded, because a paragraph was withheld. A
   * replay that releases all of it cannot know what came next, so it fails.
   */
  truncated: z.boolean().optional(),
  /** Hand-written output standing in for a model that breaks persona, so CI covers the output rules. */
  synthetic: z.boolean().optional(),
});

export type RecordedCase = z.infer<typeof recordedCaseSchema>;

export const fixturesSchema = z.strictObject({
  recordedAt: z.string(),
  chatModel: z.string(),
  chatDigest: z.string(),
  guardModel: z.string(),
  guardDigest: z.string(),
  personaVersion: z.string(),
  cases: z.record(z.string(), recordedCaseSchema),
});

export type Fixtures = z.infer<typeof fixturesSchema>;
