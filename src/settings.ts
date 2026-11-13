// Settings come from the Worker's environment (variables and secrets). The older names used before this was a package
// (HONEYPOT_URL, HONEYPOT_SECRET, TARPIT_MS) are still accepted, so an existing deployment keeps working unchanged.

export interface HoneytarEnv {
  /** Where decoy visits are reported (the ingest endpoint). Public. Without it, nothing is reported. */
  HONEYTAR_URL?: string;
  /** The shared secret the ingest endpoint expects. Set it as a Worker secret; never commit it. */
  HONEYTAR_SECRET?: string;
  /** How long to hold decoy responses, in milliseconds. Unset or 0 turns the tarpit off. */
  HONEYTAR_TARPIT_MS?: string;
  /** @deprecated Older name for HONEYTAR_URL. */
  HONEYPOT_URL?: string;
  /** @deprecated Older name for HONEYTAR_SECRET. */
  HONEYPOT_SECRET?: string;
  /** @deprecated Older name for HONEYTAR_TARPIT_MS. */
  TARPIT_MS?: string;
}

export interface Settings {
  url: string | undefined;
  secret: string | undefined;
  tarpitMs: string | undefined;
}

/** The effective settings: the new name wins; an empty value counts as unset. */
export function readSettings(env: HoneytarEnv): Settings {
  const pick = (a?: string, b?: string) => (a && a.trim() ? a : b && b.trim() ? b : undefined);
  return {
    url: pick(env.HONEYTAR_URL, env.HONEYPOT_URL),
    secret: pick(env.HONEYTAR_SECRET, env.HONEYPOT_SECRET),
    tarpitMs: pick(env.HONEYTAR_TARPIT_MS, env.TARPIT_MS),
  };
}
