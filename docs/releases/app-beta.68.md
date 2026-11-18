# App beta68 — consistent legacy transcript dates

Turn times and their accessible date use the same epoch normalizer as the day
divider. Legacy second timestamps and canonical millisecond timestamps now
identify the same day, preserving missing/invalid timestamp behavior.

Ten timeline tests passed. The real Electron terminal-frame/reconnect recovery
scenario also passed with legacy second timestamps, checking the accessible year
alongside tool completion, answering-model typography and durable recovery.
Signed native builds and installed acceptance remain separate release gates.
