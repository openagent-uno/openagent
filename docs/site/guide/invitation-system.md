# Invitation System & Networking

OpenAgent uses a **coordinator-based P2P network** over the Iroh QUIC transport. Instead of raw TCP ports and bearer tokens, every client connects through a cryptographically authenticated P2P channel. This page covers how the network is formed, how invitations work, and how clients join.

## Architecture overview

Every OpenAgent instance has a **network role** — one of:

| Role | Description |
|---|---|
| **Standalone** | No network. The agent runs locally, no gateway, no remote access. |
| **Coordinator** | Owns a network. Mints invites, signs device certificates, runs the JSON-RPC coordinator service. |
| **Member** | Joined an existing coordinator's network. Connects via Iroh QUIC, authenticated by a device certificate. |

The role is stored as a singleton row in `network` table of the agent's SQLite database (`openagent.db`).

```
 ┌──────────────────────────────────────────────┐
 │  Coordinator Agent                           │
 │  ┌──────────┐  ┌──────────────────────┐      │
 │  │ Agent    │  │ JSON-RPC Service     │      │
 │  │ Core     │  │ register · login_*   │      │
 │  └──────────┘  │ create_invitation    │      │
 │       │        │ list_agents · revoke │      │
 │  ┌────▼─────────┴──────────┐           │      │
 │  │ Iroh Node (QUIC)         │           │      │
 │  └──────────┬──────────────┘           │      │
 └─────────────┼──────────────────────────┘      │
               │ Iroh P2P QUIC                    │
     ┌─────────┼─────────────┐                   │
     │         │              │                   │
┌────▼───┐ ┌───▼────┐  ┌─────▼─────┐              │
│Desktop │ │  CLI   │  │ Agent     │              │
│ App    │ │ Client │  │ (Member)  │              │
│(cert)  │ │(cert)  │  │ (cert)    │              │
└────────┘ └────────┘  └───────────┘              │
```

## How it starts: auto-bootstrap

When you run `openagent serve ./my-agent` for the first time, the server detects no network row exists and **auto-bootstraps**:

1. Generates an **Iroh identity** (Ed25519 keypair) for the agent
2. Creates a new **network identity** (random UUID as `network_id`, a display name from config or hostname)
3. Writes the singleton `network` row with `role=coordinator`, storing the coordinator's keypair and NodeId
4. Mints a **one-shot user invite ticket** (the `oa1...` string printed on startup)
5. The ticket is printed so you can paste it into the desktop app or CLI immediately

You never need to run a separate `network init` command — `openagent serve` handles it.

## Invite tickets

An invite ticket is a single copy-pasteable string that carries everything a client needs to join. Format:

```
oa1<base32-encoded-CBOR-payload>
```

The decoded CBOR payload contains:

| Field | Description |
|---|---|
| `v` | Ticket version (currently `1`) |
| `code` | Invite code (96 bits of entropy, stored in DB) |
| `node_id` | Coordinator's Iroh NodeId (hex) — who to dial |
| `name` | Network display name |
| `network_id` | Network UUID |
| `role` | `user`, `device`, or `agent` |
| `bind_to` | Pre-bound handle (for device-role invites) or empty |
| `relay_url` | Optional coordinator's Iroh relay URL for NAT traversal |
| `addresses` | Optional list of direct `ip:port` UDP addresses |

Tickets are ~120-180 characters, URL-safe, double-clickable, and work in terminals, QR codes, and chat messages. A single ticket replaces the legacy multi-flag CLI invocation.

### Creating tickets

**On the coordinator**, use the CLI:

```bash
# Create a user-role invite (1 use, 7-day expiry)
openagent network invite --role user

# Create a device invite pre-bound to a user handle
openagent network invite --role device --bind-to alice

# Create an agent-role invite (for joining another agent node)
openagent network invite --role agent

# Custom TTL and uses
openagent network invite --role user --ttl 86400 --uses 3
```

**From the API** (requires admin device cert):

```
POST /api/network/invitations
```

**From within an agent conversation**, the coordinator's agent can call the coordinator RPC `create_invitation` (if it has an admin cert).

### Ticket storage

Invitations live in the `network_invitations` SQLite table:

| Column | Description |
|---|---|
| `code` | Base32 invite code (primary key) |
| `role` | `user` \| `device` \| `agent` |
| `created_by` | Handle of the admin who minted it |
| `bind_to_handle` | Pre-bound handle (for device invites) |
| `uses_left` | Remaining redemptions |
| `expires_at` | Unix timestamp when the invite expires |
| `created_at` | Mint timestamp |
| `used_at` | First redemption timestamp |

## Ticket redemption flow (client side)

When a user pastes an invite ticket (`oa1...`) into the desktop app or CLI:

### Step 1: Decode the ticket

The client decodes the CBOR payload to extract:
- `invite_code` — the secret code to redeem
- `coordinator_node_id` — the Iroh NodeId to dial
- `network_name` / `network_id` — for display and verification
- `role` — what kind of account this invite authorizes
- `relay_url` / `addresses` — optional hints to skip Iroh discovery

### Step 2: Create device identity

The client generates a fresh **Ed25519 keypair** (the device identity). This keypair is stored in `~/.openagent/user/` and represents "this specific installation on this specific machine."

### Step 3: Start an Iroh node

The client initializes its own Iroh endpoint (QUIC transport). Using the coordinator's NodeId from the ticket, it opens a bi-directional QUIC stream to the coordinator.

### Step 4: First-time registration (new user)

For a `role=user` ticket where the handle doesn't exist yet:

1. **Register** — Client calls `register(invite, handle, pake_record)` on the coordinator. This runs an **SRP-6a** Password-Authenticated Key Exchange (PAKE) registration: the server stores a salted verifier (never the plaintext password). The invite code is consumed (uses_left decremented).

2. **Login** — Client immediately calls `login_init` + `login_finish` to prove password knowledge, receiving a **coordinator-signed device certificate**. The cert binds `(handle, device_pubkey, network_id)` with a 30-day TTL.

### Step 5: Returning user login

For an existing handle (already registered):

1. Client calls `login_init(handle, ke1)` — coordinator returns salt and server public ephemeral
2. Client calls `login_finish(state_id, ke3, device_pubkey)` — completes SRP-6a proof
3. Coordinator verifies the user exists (checks PAKE verifier), then mints a fresh device certificate

No invite is needed for returning users — the PAKE verifier is already stored.

### Step 6: Save network config

The client persists the network metadata to `~/.openagent/user/networks.toml`:

```toml
[networks.default]
network_id = "a1b2c3d4-..."
name = "homelab"
coordinator_node_id = "c843dfbb25e9..."
cert_path = "~/.openagent/user/certs/default.cert"
```

### Step 7: Open loopback proxy

The client opens a **loopback proxy** that bridges localhost to the agent's gateway over Iroh QUIC. The device cert is presented on every stream to authenticate the connection.

## Authentication: device certificates

Every inbound gateway request carries a **device certificate** — a CBOR-encoded, Ed25519-signed credential. No bearer tokens or shared secrets.

### Certificate structure

```python
DeviceCert:
    handle: str            # User handle (e.g. "alice")
    device_pubkey: bytes   # Ed25519 public key (32 bytes)
    network_id: str        # UUID of the network
    issued_at: float       # Unix timestamp
    expires_at: float      # issued_at + 30 days
    capabilities: [str]    # e.g. ["coordinator_admin"]
```

### Wire format

```
4-byte payload length (big-endian) || CBOR(payload) || 64-byte Ed25519 signature
```

### Verification (server side)

On every gateway connection:

1. Extract the cert wire bytes from the Iroh stream (set by `IrohSite` via contextvar)
2. Verify the Ed25519 signature against the pinned coordinator pubkey
3. Check expiry (30-day TTL)
4. Check the cert's `network_id` matches the local network
5. Check the device is not revoked (`network_devices.status = 'active'` in local DB)
6. Annotate the request with `device_cert`, `client_id` (device pubkey hex), and `user_handle`

Failed verification → `401 unauthorized`. Successful → the request proceeds with the authenticated identity.

### Certificate refresh

When a cert crosses 50% of its TTL (15 days), the client transparently replays the login flow to get a fresh cert. The coordinator re-issues with a new 30-day window.

## Coordinator JSON-RPC service

The coordinator runs an embedded JSON-RPC service over the Iroh transport (ALPN `openagent/coordinator/1`). One bi-stream per RPC call with CBOR-encoded length-prefixed frames.

### Methods

| Method | Auth | Purpose |
|---|---|---|
| `register(invite, handle, pake_record)` | Invite | Create user + store PAKE verifier |
| `login_init(handle, ke1)` | None | SRP-6a step 1: return salt + server ephemeral |
| `login_finish(state_id, ke3, device_pubkey, invite?)` | Login state | SRP-6a step 2: verify proof, issue cert |
| `list_agents()` | None | Return registered agent directory |
| `add_agent(invite \| cert, handle, node_id)` | Admin cert or agent invite | Register a new agent node |
| `remove_agent(handle)` | Admin cert | Deregister an agent |
| `revoke_device(device_pubkey)` | Admin cert | Revoke a device (immediate, no TTL wait) |
| `create_invitation(role, ttl, uses, bind_to)` | Admin cert | Mint a new invite |
| `network_info()` | None | Return network id, name, PAKE algorithm |

### PAKE: SRP-6a

Password authentication uses SRP-6a (Secure Remote Password) — the coordinator stores a salted verifier, never the plaintext password. The protocol proves the client knows the password without either side revealing it. This is the same class of protocol used by iCloud Keychain and 1Password.

## Multi-agent networking

You can run multiple agents that talk to each other:

```
Coordinator Agent    Agent 2 (Member)    Agent 3 (Member)
     │                     │                    │
     └─────────────────────┼────────────────────┘
                           │
                    Same Iroh network
```

1. On the coordinator, mint an **agent-role invite**:
   ```bash
   openagent network invite --role agent
   ```

2. On the second machine, run:
   ```bash
   openagent network join --invite oa1...
   ```

3. The second agent registers with the coordinator via `add_agent`, gets its own device cert, and connects back.

All agents share the same network and can discover each other via `list_agents`. Each still runs its own independent gateway, scheduler, and MCP pool.

## Revocation

To revoke a device (stolen laptop, lost phone, employee departure):

1. Get the device's pubkey from the list of active devices
2. On the coordinator:
   ```bash
   openagent network revoke-device <device_pubkey_hex>
   ```
3. The coordinator calls `revoke_device` on itself, setting `status='revoked'` in `network_devices`
4. The gateway middleware reloads the revoked pubkeys set
5. The revoked cert is rejected on the next request — no TTL grace period

Revocation is immediate and server-side only. The cert doesn't need to be updated; it simply stops being accepted.

## Database tables

All network state lives in the agent's `openagent.db`:

| Table | Purpose |
|---|---|
| `network` | Singleton row: role, network_id, name, coordinator keys |
| `network_users` | PAKE records: handle, verifier, algorithm, status |
| `network_devices` | Device registrations: pubkey, user_handle, status, timestamps |
| `network_agents` | Agent directory: handle, node_id, owner, timestamps |
| `network_invitations` | Pending/expired invite codes |

## Standalone mode

If you don't need remote access or multi-agent networking, run in standalone mode:

```bash
openagent serve ./my-agent --no-auto-init
```

With `--no-auto-init`, the server doesn't create a network or coordinator. The agent runs locally — no gateway, no Iroh endpoint, no external connectivity. Use this for local-only development or when you interact with the agent purely through the filesystem or shell MCP.

## CLI reference

```bash
# Network management
openagent network init                     # Initialize network (normally auto-bootstrapped)
openagent network info                     # Show current network configuration
openagent network invite --role user       # Create a user invite
openagent network invite --role device     # Create a device invite
openagent network invite --role agent      # Create an agent invite
openagent network invites                  # List all active invites
openagent network revoke-device <pubkey>   # Revoke a device
openagent network list-agents              # List registered agent nodes

# Client join (from the CLI client or another machine)
openagent-cli connect oa1...               # Join with an invite ticket (first time)
openagent-cli connect handle@network       # Rejoin with saved credentials
```
