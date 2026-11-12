/**
 * Why a provider call failed, in terms the API can map to a generic client
 * error. The vendor's own message is kept out of `message` so it cannot leak
 * into responses or logs.
 */
export type ProviderErrorKind = 'unavailable' | 'model_missing' | 'bad_response';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** HTTP status from the provider, when there was one. */
  readonly status: number | undefined;

  constructor(kind: ProviderErrorKind, status?: number, options?: ErrorOptions) {
    super(`provider error: ${kind}`, options);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}
