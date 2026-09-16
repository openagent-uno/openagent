# claude-sub-proxy

A standalone, OpenAI-compatible HTTP proxy that bills inference against a **Claude
Pro/Max subscription** instead of a metered API key. It accepts OpenAI
`/v1/chat/completions` requests and re-originates each one as a **Claude-Code-faithful**
Anthropic `/v1/messages` call (OAuth token + TLS/header impersonation).

It carries **no Agent import**. Agent talks to it purely as a `local`
model via `base_url` — no ad-hoc framework, no patch to the core.

```
Agent ──OpenAI /v1/chat/completions──▶  claude-sub-proxy  ──Anthropic /v1/messages──▶  api.anthropic.com
            (local provider, base_url)       OAuth + CC fingerprint                          (subscription quota)
```

---

## Install

```bash
cd claude-sub-proxy
uv venv && uv pip install -e .       # or: pip install -e .
```

`curl_cffi` is required for the L3 (TLS/JA3) transport — without it the proxy
falls back to plain `httpx`, which only defeats header gating and will usually be
rejected by the subscription endpoint.

## Authenticate

Pick one. The managed (refresh-capable) path is preferred — a static token expires
in ~8h and the gateway dies when it does.

```bash
# A) Interactive OAuth login (PKCE). Opens the browser, paste the code#state.
claude-sub-proxy login --priority 10
claude-sub-proxy login --priority 20
#    -> writes ~/.claude-sub-proxy/credentials.json (accounts + refresh + expiry).
#    Unnamed logins append account-1, account-2, ... to the accounts array.
#    The proxy tries lower priority numbers first, skips limited accounts,
#    and switches back when a higher-priority account becomes available again.

# B) Reuse an existing token (no refresh): env var or the macOS Keychain entry
#    Claude Code already wrote ("Claude Code-credentials").
export CLAUDE_CODE_OAUTH_TOKEN="..."
```

Manage accounts:

```bash
claude-sub-proxy accounts             # list accounts, sorted by priority
claude-sub-proxy priority account-2 5 # move account-2 earlier in the array order
claude-sub-proxy delete account-2     # remove by name or id
claude-sub-proxy token account-1      # print/refresh one account token
claude-sub-proxy token                # print the next available token
```

Existing single-account `credentials.json` files are migrated automatically the
next time the proxy writes credentials.

## Run

```bash
claude-sub-proxy serve          # http://127.0.0.1:8787/v1
curl -s localhost:8787/health   # {"status":"ok","transport":"curl_cffi",...}
```

## Wire into any Agent

The proxy is just a `local` (OpenAI-compatible) provider. Register it once via the
`model-manager` MCP (or the Providers UI, or by asking your agent). The catalog
lives in SQLite — this is the only integration surface; **no code changes in
Agent.**

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_SUB_PROXY_HOST` | `127.0.0.1` | Bind host. Keep it loopback. |
| `CLAUDE_SUB_PROXY_PORT` | `8787` | Bind port. |
| `CLAUDE_SUB_PROXY_CREDS` | `~/.claude-sub-proxy/credentials.json` | OAuth credential file. |
| `CLAUDE_SUB_PROXY_TRANSPORT` | auto | `curl_cffi` (L3) or `httpx` (L2). Auto picks curl_cffi when importable. |
| `CLAUDE_SUB_PROXY_IMPERSONATE` | `chrome` | curl_cffi impersonation target. |
| `CLAUDE_SUB_PROXY_MAX_TOKENS` | `16384` | Default `max_tokens` when the caller omits it (Anthropic requires it). |
| `CLAUDE_SUB_PROXY_MAX_TOOLS` | `19` | Tool-list cap. The subscription path 400s at ≥ 20 tools. |
| `CLAUDE_SUB_PROXY_MODELS` | `claude-opus-4-8,claude-sonnet-4-6,claude-haiku-4-5` | Advertised on `/v1/models`. |
| `CLAUDE_SUB_PROXY_MODEL_MAP` | `{}` | JSON map of advertised id → real Anthropic id, if they diverge. |
| `CLAUDE_SUB_PROXY_API_KEY` | unset | If set, require `Authorization: Bearer <it>` from callers. |
| `CLAUDE_SUB_PROXY_TIMEOUT` | `1800` | Upstream request timeout (s). |
| `CLAUDE_SUB_PROXY_ACCOUNT_RATE_LIMIT_COOLDOWN` | `3600` | Seconds to skip one account after an upstream rate/usage-limit response before trying it again. |

## How it works (the non-obvious part)

The subscription endpoint rejects anything that doesn't look like genuine Claude
Code traffic. Three shaping rules (in `translate.py`) are required or it 400s:

1. **`system` carries only the billing header block.** A custom system prompt is
   rejected.
2. **The Claude Code identity line + your agent's system/persona prompt are moved
   into a leading user message.** The same text as a user turn is accepted — this
   is why a large Agent framework prompt works.
3. **Tool names lose the `mcp_` prefix and the list is capped at 19.** (Agent's
   defer-all / tool-search setup usually sends far fewer, so the cap rarely bites.)

The complete Claude Code fingerprint (11 betas, JS/Bun stainless headers, billing
header, `claude-cli` user-agent) lives in `cc_anthropic.py`. A *partial* fingerprint
is billed as paid extra-usage and 400s once that's exhausted; the *complete* one
lands on the included quota.

## Keeping it working

- **Version drift.** The spoofed version is **pinned** to `CC_VERSION` in
  `cc_anthropic.py`, kept consistent with `BILLING_HEADER_TEXT`'s `cc_version`
  (a faithful client never mismatches the two). Anthropic rejects a too-stale
  version — bump both together when the real CLI updates.
- **Emulation profile.** Headers/betas mirror the verified-working Hermes native
  path: `user-agent claude-cli/<ver> (external, sdk-cli)`, `x-claude-code-session-id`,
  `anthropic-dangerous-direct-browser-access`, and the 4-beta set (claude-code,
  oauth, interleaved-thinking, fine-grained-tool-streaming).
- **1M context.** Use **`claude-opus-4-8`** — Opus gets the 1M window natively on
  Max: a >200K request bills to the subscription at `standard` tier (no extra
  credit) with **no beta**. Do **not** send `context-1m` (it breaks the path), and
  do not route long context to `claude-sonnet-4-6` (it's usage-credit-gated on
  >200K — a known Sonnet-side Claude Code issue).
- **Token refresh.** Handled inline on near-expiry. For refresh even while the proxy
  is stopped, run `claude-sub-proxy token` on a cron/launchd timer (it refreshes and
  rewrites the creds file).
- **Account rotation.** Managed credentials are stored as an accounts array and
  tried by ascending priority. On an upstream 429/rate-limit response, only that
  account is cooled down and the same request immediately retries with the next
  available account. Every new request rechecks the priority order, so when a
  higher-priority account's cooldown expires it is used again automatically. If
  every account is cooling down, the proxy returns a 429 with a
  `no_available_account` error.

## Scope of this scaffold

Implemented: the text + tool-calling path, streaming and non-streaming, both
directions. **TODO** (marked in `translate.py`): image/audio content parts, and
mapping OpenAI `reasoning_effort` → Anthropic extended-thinking budget.

## Layout

```
claude_sub_proxy/
  cc_anthropic.py  # Claude-Code-faithful client + transports + fingerprint (lifted)
  auth.py          # OAuth login (PKCE) + refresh + priority-sorted account pool
  translate.py     # OpenAI <-> Anthropic + the 3 subscription shaping rules
  server.py        # FastAPI: /v1/chat/completions, /v1/models, /health
  config.py        # env-driven settings
  __main__.py      # CLI: serve | login | token
tests/test_translate.py
```
