import { splitFrontmatter, wikiLinkText } from '../frontmatter';
import { strict as assert } from 'node:assert';

const note = [
  '---',
  'title: "OpenAgent — App Shell"',
  'tags: [projects, openagent]',
  'status: active',
  'created: 2026-08-14',
  'related:',
  '  - "[[openagent]]"',
  '  - "[[virgil|Virgil]]"',
  '---',
  '',
  '# Heading',
  'Body text.',
].join('\n');

const split = splitFrontmatter(note);
assert.equal(split.raw, null);
assert.deepEqual(split.entries, [
  { key: 'title', value: 'OpenAgent — App Shell' },
  { key: 'tags', value: ['projects', 'openagent'] },
  { key: 'status', value: 'active' },
  { key: 'created', value: '2026-08-14' },
  { key: 'related', value: ['[[openagent]]', '[[virgil|Virgil]]'] },
]);
assert.equal(split.body, '# Heading\nBody text.');

// No frontmatter: body untouched.
assert.deepEqual(splitFrontmatter('# Just markdown\n---\nrule'), {
  entries: null, raw: null, body: '# Just markdown\n---\nrule',
});

// Unterminated block is treated as plain markdown.
assert.equal(splitFrontmatter('---\ntitle: x\nno close').entries, null);

// Invalid YAML keeps the raw block instead of dropping it.
const bad = splitFrontmatter('---\ntitle: [unclosed\n---\nbody');
assert.equal(bad.entries, null);
assert.equal(bad.raw, 'title: [unclosed');
assert.equal(bad.body, 'body');

// CRLF fences.
assert.equal(splitFrontmatter('---\r\na: 1\r\n---\r\nbody').body, 'body');

assert.equal(wikiLinkText('[[openagent]]'), 'openagent');
assert.equal(wikiLinkText('[[virgil|Virgil]]'), 'Virgil');
assert.equal(wikiLinkText('plain'), 'plain');

console.log('frontmatter: all tests passed');
