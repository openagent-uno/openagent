import { DeterministicGateway } from './fixtures.mjs';

const connection = (id, vendor, access, label) => ({ id, name: `${vendor}-${access}-${id}`, vendor, access, label,
  framework: 'api-based', kind: 'llm', enabled: true, base_url: null, api_key_display: access === 'api' ? '****test' : '—',
  metadata: { vendor, access, label, ...(access === 'subscription' ? { account_id: `account-${id}` } : {}) } });

export class ProvidersGateway extends DeterministicGateway {
  providers = [connection(1, 'anthropic', 'subscription', 'Personal'), connection(2, 'anthropic', 'subscription', 'Work'),
    connection(3, 'anthropic', 'api', 'Production'), connection(4, 'openai', 'subscription', 'Personal'),
    connection(5, 'openai', 'subscription', 'Work'), connection(6, 'openai', 'api', 'Production')];
  models = this.providers.flatMap((provider) => (provider.id === 6 ? ['llm', 'image', 'tts', 'stt'] : ['llm']).map((kind, index) => ({
    id: provider.id * 10 + index, provider_id: provider.id, provider_name: provider.name, framework: 'api-based', kind,
    runtime_id: `${provider.name}:fixture-${kind}`, model: `fixture-${kind}`, display_name: { llm: 'Reasoning model', image: 'Image model', tts: 'Speech model', stt: 'Transcription model' }[kind],
    enabled: true, is_classifier: provider.id === 1, provider_enabled: true,
    input_cost_per_million: 1, output_cost_per_million: 3,
    metadata: { input_modalities: ['text', 'image'], input_modalities_source: 'provider' },
    settings_schema: kind === 'llm' ? [{ key: 'reasoning_effort', label: 'Reasoning effort', type: 'enum', options: ['low', 'medium', 'high'] }]
      : kind === 'tts' ? [{ key: 'voice_id', label: 'Voice', type: 'string' }] : kind === 'stt' ? [{ key: 'language', label: 'Language', type: 'string' }] : [],
  })));
  accounts = this.providers.filter((p) => p.access === 'subscription').map((p) => ({ provider: p.name, provider_id: p.id,
    enabled: true, reachable: true, sign_in: true, metrics: null, status: p.id === 5 ? 'auth_expired' : 'ok',
    accounts: [{ id: `account-${p.id}`, name: p.label, enabled: true, managed: true, has_refresh_token: true,
      status: p.id === 5 ? 'auth_expired' : 'ok', quota: p.vendor === 'openai' && p.id !== 5 ? { primary_used_percent: 42, primary_window_minutes: 300, primary_reset_after_s: 8100 } : null }] }));
  budgets = [];
  connectionTestOk = true;
  mutations = [];

  async handleHttp(request, response) {
    const path = new URL(request.url, 'http://fixture').pathname;
    const reply = (value, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    const body = async () => { let data = ''; for await (const chunk of request) data += chunk; return JSON.parse(data || '{}'); };
    if (/^\/api\/providers\/\d+\/test$/.test(path)) return reply({ ok: this.connectionTestOk });
    if (path === '/api/providers/contract') return reply({ version: 1 });
    if (path === '/api/providers' && request.method === 'GET') return reply({ providers: this.providers });
    if (path === '/api/models' && request.method === 'GET') return reply({ models: this.models });
    if (path === '/api/accounts') return reply({ providers: this.accounts });
    if (path === '/api/budgets/usage') return reply({ usage: this.budgets });
    if (path === '/api/budgets' && request.method === 'POST') {
      const value = await body(); this.mutations.push({ path, value });
      const rule = { ...value, id: `budget-${this.budgets.length}`, enabled: true, spend: 0, ratio: 0, over: false, remaining: value.amount, enforced: true };
      this.budgets.push(rule); return reply(rule, 201);
    }
    if (path === '/api/models/available') return reply({ models: ['llm', 'image', 'tts', 'stt'].map((kind) => ({
      id: `new-${kind}`, display_name: `New ${kind} model`, kind, runtime_id: `fixture:new-${kind}`, added: this.models.some((m) => m.model === `new-${kind}`),
    })) });
    if (path === '/api/models' && request.method === 'POST') {
      const value = await body(); this.mutations.push({ path, value });
      const provider = this.providers.find((p) => p.id === value.provider_id);
      const model = { ...value, id: 1000 + this.models.length, provider_name: provider.name, runtime_id: `${provider.name}:${value.model}`, metadata: {}, enabled: true, provider_enabled: true };
      this.models.push(model); return reply({ model }, 201);
    }
    const provider = /^\/api\/providers\/(\d+)$/.exec(path);
    if (provider && request.method === 'PUT') {
      const value = await body(); this.mutations.push({ path, value });
      const entry = this.providers.find((p) => p.id === Number(provider[1])); Object.assign(entry, value);
      return reply({ ok: true, provider: entry });
    }
    const account = /^\/api\/providers\/(\d+)\/accounts\/(.+)$/.exec(path);
    if (account && request.method === 'PUT') {
      const value = await body(); this.mutations.push({ path, value });
      const entry = this.accounts.find((p) => p.provider_id === Number(account[1]));
      Object.assign(entry.accounts.find((a) => a.id === account[2]), value);
      this.providers.find((p) => p.id === Number(account[1])).enabled = value.enabled;
      return reply({ ok: true });
    }
    const model = /^\/api\/models\/(\d+)$/.exec(path);
    if (model && request.method === 'PUT') {
      const value = await body(); this.mutations.push({ path, value });
      const entry = this.models.find((m) => m.id === Number(model[1])); Object.assign(entry, value); return reply({ model: entry });
    }
    return super.handleHttp(request, response);
  }
}
