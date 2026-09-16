# Models

OpenAgent is model agnostic by design. It supports API-based providers (OpenAI, Anthropic API, Google, Groq, xAI, DeepSeek, Mistral, Cerebras, Z.ai, OpenRouter, Moonshot/Kimi, Qwen) and self-hosted OpenAI-compatible servers (Ollama, vLLM, LM Studio, llama.cpp — via the `local` provider) — every model gets the same MCP tools, memory behaviour, channels, and client surfaces.

## One entry model, then a team

Every turn goes through `ModelDispatcher`. It:

1. Reads the enabled models from the `models` SQLite table.
2. Resolves an **entry model** for the session — **without calling an LLM to do it**. The order is: a **per-session pin** (`pinned_sessions` table) → the model flagged `is_classifier` in the catalog → the **first enabled** model in catalog order.
3. Dispatches through `TeamRouterProvider`, which builds one `Team(mode=coordinate)` per session: the entry model leads, and every *other* enabled LLM joins as a member with a `role` blurb drawn from its `tier_hint`. The leader answers directly or fires one or more `delegate_task_to_member` calls, which run **concurrently** within a turn. With only one LLM enabled the team is skipped and the lone leader runs through a bare `NativeProvider`.
4. Runs the chosen model through its `framework` — today every shipped model runs on the `api-based` framework (direct provider API calls via the native runtime), but the dispatch seam stays generic so future frameworks can be wired in alongside it.

Conversation state lives in one canonical sessions store shared across frameworks, so history never splits no matter which member answers a given turn.

::: warning `is_classifier` does not name a classifier
Despite the column name, no cheap classifier model reads your message and picks a route. `is_classifier` is a **stored preference** — the persistent "default team leader" hint you set in the model-manager UI. The per-turn intelligence lives in the team leader's own `delegate_task_to_member` decisions, not in a routing pre-pass.
:::

## Pinning a session to one model

A session is **not** bound to the first model that served it. It stays on a `runtime_id` only when something explicitly pins it:

- **Ask the agent** — "always use claude opus for this chat". It calls `model_manager_pin_session` on its own session id.
- **REST / UI** — the model picker in the desktop app.

Pins live in the `pinned_sessions` table (which replaced the pre-v0.14 `session_bindings` table) and survive restarts. `unpin_session` returns the session to normal entry-model resolution. If a pin points at a model you later disable, the dispatcher heals it automatically — it drops the pin and falls through to the flag / first-enabled order rather than failing the turn.

## Providers and models live in the DB

Provider credentials (`api_key`, `base_url`) live in the `providers` SQLite table. Manage them via:

- **From the agent** — the `model-manager` built-in MCP exposes `list_providers`, `add_provider`, `list_models`, `list_available_models` (dynamic discovery via the provider's `/v1/models` or OpenRouter fallback), `add_model`, `update_model`, `enable_model`, `disable_model`, `remove_model`, `test_model`.
- **REST** — `GET/POST/PUT/DELETE /api/providers` and `/api/models`, plus `/enable` and `/disable`. `GET /api/models/available?provider=openai` returns the live catalog for a given provider.
- **UI** — the Models / Providers screens in the desktop app.

The per-provider **model list** (which ids are available to route to) lives in the `models` table. Each row carries `kind` (`llm` / `tts` / `stt`) so the router never crosses capabilities.

## Local / self-hosted models

The `local` provider targets any OpenAI-compatible server you run yourself — Ollama, vLLM, LM Studio, llama.cpp. Because the endpoint is yours, **`base_url` is mandatory**: set it to the server's `/v1` root, e.g. `http://localhost:11434/v1` (Ollama), `http://localhost:8000/v1` (vLLM), or `http://localhost:1234/v1` (LM Studio). If you leave it unset the model build fails fast with a clear error rather than silently falling back to OpenAI's endpoint.

```text
> use model-manager to add a provider named local with base_url http://localhost:11434/v1
> then list_available_models for it and add llama3.1
```

`api_key` is optional — keyless servers get a harmless placeholder so the OpenAI SDK client initialises; if your server enforces a key (e.g. vLLM `--api-key`), set it on the provider and it takes precedence. Model discovery hits your server's `/v1/models`, so `list_available_models` shows whatever you've pulled (`ollama pull …`); you can also `add_model` ids by hand.

## No models enabled = reject

With zero enabled models in the DB, the gateway replies with a clear error (`"No models are enabled. Add one via /models…"`) instead of silently falling through. Use this as a forcing function: no config, no service.

## Cost tracking

Every dispatch gets logged to `usage_log` with input / output tokens and computed cost. Prices come from the user's per-model metadata first, then OpenRouter's live catalog. There is no bundled offline pricing table — if OpenRouter is unreachable at the moment cost is computed, the entry is logged as `missing` with zero cost (a free-tier model likewise resolves to zero). `GET /api/usage` returns the running totals; `GET /api/usage/pricing` returns the price-per-million table used for cost computation.

## Hot reload

Edit a model via the manager MCP, the REST endpoints, or the UI — the gateway sees the bumped `updated_at` on the next message, rebuilds the routing table, and the new model is live. Each `TeamRouterProvider` drops its cached per-session team, so the next turn rebuilds with the new membership. Pinned sessions keep their pin; enabling a second model promotes a single-agent deployment to a team on the very next turn.
