/**
 * Inline Markdown tokenizer pattern for the app's lightweight renderer.
 *
 * Groups: 1 escaped char · 2/3 code span · 4/5 image · 6/7 link · 8 bare URL ·
 * 9/10 ``*``/``~~`` emphasis · 11 inline math · 12/13 ``_`` emphasis.
 *
 * ``_``, ``__`` and ``___`` follow CommonMark's intraword rule: they open only
 * when not preceded by a letter or digit and close only when not followed by
 * one, with no whitespace just inside. So ``snake_case`` and
 * ``OPENAGENT_MCP_SECRET_TOKEN`` stay literal, while ``_emphasis_`` still works.
 * ``*`` keeps working inside words (``foo*bar*`` is emphasis in CommonMark too).
 */
const WORD = 'A-Za-z0-9\\u00C0-\\uFFFF';

export const INLINE_MARKDOWN_SOURCE =
  '\\\\([\\`*_{}\\[\\]()#+\\-.!|~])' +
  '|(`+)([^`]+?)\\2' +
  '|!\\[([^\\]]*)\\]\\(([^\\s)]+)\\)' +
  '|\\[([^\\]]+)\\]\\(([^\\s)]+)\\)' +
  '|(<(?:https?:\\/\\/|mailto:)[^<>\\s]+>|https?:\\/\\/[^\\s<>"`]+)' +
  '|(\\*\\*\\*|\\*\\*|\\*|~~)([^\\n]+?)\\9' +
  '|\\$([^$\\n]+?)\\$' +
  `|(?<![${WORD}_])(___|__|_)(?![\\s_])([^\\n]*?[^\\s_])\\12(?![${WORD}_])` +
  '|(?<![\\w#])#[\\da-fA-F]{3,8}(?!\\w)';

export function inlineMarkdownPattern(): RegExp {
  return new RegExp(INLINE_MARKDOWN_SOURCE, 'g');
}
