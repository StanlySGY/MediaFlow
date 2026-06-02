// Extract a human-readable message from an unknown thrown value.
export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
