/**
 * Application-wide constants.
 * Operational parameters that operators might want to tune should go in env.ts instead.
 */

/** Default base delay for retry exponential backoff (ms) */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;

/** Default temperature for AI provider calls */
export const DEFAULT_TEMPERATURE = 0.7;
