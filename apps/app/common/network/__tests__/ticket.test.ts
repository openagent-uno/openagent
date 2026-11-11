import { looksLikeTicket, decodeTicket } from '../ticket';
import { strict as assert } from 'node:assert';

assert.equal(looksLikeTicket('oa1ABCD'), true);
assert.equal(looksLikeTicket('Oa1ABCD'), false, 'case-sensitive prefix');
assert.equal(looksLikeTicket('random-string'), false);
assert.equal(looksLikeTicket(''), false);

console.log('ticket: looksLikeTicket ok');
console.log('ticket: all tests passed');
