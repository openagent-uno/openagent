// La classificazione dei modelli, provata contro i runtime VERI registrati.
//
// Il selettore raggruppa per famiglia e ordina per sforzo, e lo deduce dal
// nome del runtime. Il modo in cui una cosa cosi' si rompe non e' un errore:
// e' un modello nuovo che finisce in un gruppo "Altri" con sforzo "standard",
// e nessuno se ne accorge perche' la lista continua a disegnarsi. Quindi il
// test tiene l'elenco vero dei runtime e pretende che ognuno sia riconosciuto.
//
// Quando ne arriva uno nuovo: aggiungerlo qui. Se non e' classificabile dal
// nome, dichiarare family/effort nei metadata del modello — l'euristica
// e' la comodita', non il contratto.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { modelFamily, modelEffort, modelEffortRank } from '../types.ts';

// provider:model, come li registra il gateway (25-ago-2026).
const REGISTERED = [
  ['codex:gpt-5.6-sol-high',      'GPT',      'high'],
  ['codex:gpt-5.6-sol',           'GPT',      'standard'],
  ['codex:gpt-5.6-luna',          'GPT',      'standard'],
  ['codex:gpt-5.3-codex-spark',   'GPT',      'light'],
  ['local:claude-opus-5',         'Claude',   'high'],
  ['local:claude-opus-4-8',       'Claude',   'high'],
  ['local:claude-sonnet-5',       'Claude',   'standard'],
  ['local:claude-sonnet-4-6',     'Claude',   'standard'],
  ['local:claude-haiku-4-5',      'Claude',   'light'],
  ['deepseek:deepseek-v4-pro',    'DeepSeek', 'standard'],
  ['deepseek:deepseek-v4-flash',  'DeepSeek', 'light'],
  ['windows-local:qwen3-27b-local',  'Local', 'standard'],
  ['windows-local:qwen3-moe-local',  'Local', 'standard'],
];

test('ogni runtime registrato finisce nella sua famiglia', () => {
  for (const [runtime_id, family] of REGISTERED) {
    assert.equal(modelFamily({ runtime_id }), family, runtime_id);
  }
});

test('ogni runtime registrato ha lo sforzo che dice il suo nome', () => {
  for (const [runtime_id, , effort] of REGISTERED) {
    assert.equal(modelEffort({ runtime_id }), effort, runtime_id);
  }
});

test('"sol-high" non si legge come "sol"', () => {
  // La trappola del confronto per sottostringa: l'ordine delle regole e'
  // load-bearing, e qui e' dove si rompe per primo.
  assert.equal(modelEffort({ runtime_id: 'codex:gpt-5.6-sol-high' }), 'high');
  assert.equal(modelEffort({ runtime_id: 'codex:gpt-5.6-sol' }), 'standard');
});

test('i metadata dichiarati battono il nome', () => {
  // Il nome e' un indizio; se qualcuno dichiara, si obbedisce.
  assert.equal(
    modelFamily({ runtime_id: 'local:claude-opus-5', metadata: { family: 'Anthropic' } }),
    'Anthropic',
  );
  assert.equal(
    modelEffort({ runtime_id: 'local:claude-opus-5', metadata: { effort: 'max' } }),
    'max',
  );
  // Uno sforzo dichiarato ma inventato non passa: si torna all'euristica
  // invece di mostrare un livello che il selettore non sa ordinare.
  assert.equal(
    modelEffort({ runtime_id: 'local:claude-haiku-4-5', metadata: { effort: 'turbo' } }),
    'light',
  );
});

test('l\'ordinamento va dal leggero al pesante', () => {
  const ranks = ['light', 'standard', 'high', 'max'].map(modelEffortRank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.ok(modelEffortRank('light') < modelEffortRank('max'));
});

test('uno sconosciuto e\' visibile, non silenzioso', () => {
  // Non deve inventarsi una famiglia: cade sul provider, che almeno dice
  // dove sta e da dove viene il conto.
  assert.equal(modelFamily({ runtime_id: 'nuovo:mistral-x', provider_name: 'mistral' }), 'mistral');
  assert.equal(modelFamily({ runtime_id: 'nuovo:mistral-x' }), 'Other');
});
