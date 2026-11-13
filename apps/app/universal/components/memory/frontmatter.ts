/**
 * Split a vault note into its YAML frontmatter and Markdown body.
 *
 * The preview renders the body as Markdown and the frontmatter as a
 * properties panel; handing the whole file to the Markdown renderer turns
 * the ``---`` fences into rules and the YAML into one run-on paragraph.
 * Pure (no React Native imports) so it is testable under Node.
 */
import { parse } from 'yaml';

export type FrontmatterValue = string | string[];

export interface FrontmatterEntry {
  key: string;
  value: FrontmatterValue;
}

export interface SplitNote {
  /** Parsed properties in source order; null when there is no block or it is not a mapping. */
  entries: FrontmatterEntry[] | null;
  /** The raw YAML between the fences when it could not be parsed as a mapping. */
  raw: string | null;
  body: string;
}

const OPEN = /^﻿?---[ \t]*\r?\n/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/m;

function scalar(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function toValue(v: unknown): FrontmatterValue {
  if (Array.isArray(v)) return v.map(scalar).filter((s) => s !== '');
  return scalar(v);
}

export function splitFrontmatter(text: string): SplitNote {
  const open = OPEN.exec(text);
  if (!open) return { entries: null, raw: null, body: text };
  const rest = text.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) return { entries: null, raw: null, body: text };
  const raw = rest.slice(0, close.index).replace(/\s+$/, '');
  const body = rest.slice(close.index + close[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
  if (!raw.trim()) return { entries: [], raw: null, body };
  try {
    const data = parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { entries: null, raw, body };
    }
    const entries = Object.entries(data as Record<string, unknown>).map(([key, v]) => ({
      key,
      value: toValue(v),
    }));
    return { entries, raw: null, body };
  } catch {
    return { entries: null, raw, body };
  }
}

/** ``[[target]]`` / ``[[target|alias]]`` → display text. */
export function wikiLinkText(value: string): string {
  const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(value.trim());
  return m ? (m[2] ?? m[1]!).trim() : value;
}
