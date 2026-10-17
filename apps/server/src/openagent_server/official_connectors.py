"""Standalone host policy and local encrypted storage for shared connector code."""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
from urllib.parse import urlsplit

import aiosqlite
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from openagent_core.capabilities import ToolDefinition
from openagent_core.contracts import ResourceRef, require_authorized


class OfficialConnectorSource:
    def __init__(self, service, connection_id, *, registered=False):
        self.service, self.connection_id = service, connection_id
        self.registered = registered
        self.privacy = None

    def require_current_registration(self):
        if self.registered and self.service.sources.get(self.connection_id) is not self:
            raise PermissionError("Connector source registration was replaced")

    async def discover(self, context):
        row = await self.service.record(self.connection_id)
        if not self.service.can_use(context, row):
            return ()
        token = (await self.service.current_token(row, context=context)
                 if self.service.keyless_binding(row) else self.service.decrypt(row))
        tools = await self.service.runner.call("tools", self.service.binding(row, token))
        return tuple(ToolDefinition(tool["name"], tool["description"], tool["inputSchema"],
                                    frozenset() if tool["risk"] == "read" else frozenset({"mutating"}))
                     for tool in tools)

    async def call_tool(self, name, arguments, context):
        self.require_current_registration()
        row = await self.service.record(self.connection_id)
        self.require_current_registration()
        if not self.service.can_use(context, row):
            raise PermissionError("Connector binding is unavailable")
        admitted = row
        token = await self.service.current_token(row, context=context)
        # Revalidate after authentication IO: disconnecting a connection can
        # never resurrect its tools or persist credentials into another owner.
        row = await self.service.record(self.connection_id)
        if (not self.service.can_use(context, row)
                or self.service.source_snapshot(admitted) != self.service.source_snapshot(row)):
            raise PermissionError("Connector binding is unavailable")
        if self.privacy is not None:
            await self.privacy.before_io(name,context)
        call_id = uuid.uuid4().hex
        await self.service.audit(row, name, call_id, "admitted")
        try:
            self.require_current_registration()
            result = await self.service.runner.call("invoke", {
                "binding": self.service.binding(row, token), "tool": name,
                "arguments": dict(arguments), "invocation_id": call_id,
                "credential": self.service.credential(row, token),
            })
        except BaseException:
            await self.service.audit(row, name, call_id, "failed")
            raise
        await self.service.audit(row, name, call_id, "completed")
        return result.get("data")


class OfficialConnectors:
    # New keyless adapters reuse this lifecycle after their pinned catalog and
    # provider/capability contract have been reviewed; credentials are never
    # inferred from an empty token or a user-editable MCP declaration.
    _keyless_bindings = frozenset({("exa", "exa", "files"), ("firecrawl", "firecrawl", "files")})
    _binding_fields = ("id", "tenant_id", "owner_key", "catalog_id", "provider", "capability",
                       "display_name", "config", "enabled", "allow_write", "status", "app_id", "group_id",
                       "credential", "nonce", "token_version", "transaction_id")

    def __init__(self, runtime, *, runner=None, privacy_processor=None):
        self.runtime, self.agent = runtime, runtime.agent
        self.privacy_processor = privacy_processor
        self.db_path = Path(self.agent.memory_db.db_path)
        config = self.agent.config.get("connectors") or {}
        environment = dict(getattr(self.agent, "product_environment", os.environ))
        if "official_providers" in config:
            enabled = config["official_providers"]
        elif "OPENAGENT_CONNECTOR_AUTH_PROVIDERS" in environment:
            value = environment["OPENAGENT_CONNECTOR_AUTH_PROVIDERS"]
            enabled = value.split(",") if isinstance(value, str) else []
        else:
            enabled = ["clickup", "github", "notion"]
        self.official_providers = {value.strip() for value in enabled if value.strip()} if isinstance(enabled, list) and all(isinstance(value, str) for value in enabled) else set()
        self.own_providers = set()
        if config.get("oauth_providers_file"):
            try:
                path = Path(config["oauth_providers_file"])
                if path.stat().st_size <= 512 * 1024:
                    providers = json.loads(path.read_text())
                    if isinstance(providers, list):
                        self.own_providers = {entry["id"] for entry in providers if isinstance(entry, dict) and isinstance(entry.get("id"), str)}
            except (OSError, ValueError, TypeError):
                pass
        bundled = Path(getattr(sys,"_MEIPASS",Path(__file__).parent)) / ("openagent-connector-runner.exe" if sys.platform == "win32" else "openagent-connector-runner")
        installed = Path(sys.executable).parent / ("openagent-connector-runner.exe" if sys.platform == "win32" else "openagent-connector-runner")
        executable = config.get("runner_path") or environment.get("OPENAGENT_CONNECTOR_RUNNER") or (str(bundled) if getattr(sys,"frozen",False) and bundled.is_file() else None) or (str(installed) if installed.is_file() else None) or shutil.which("openagent-connector-runner")
        self.runner = runner
        if self.runner is None and executable:
            from openagent_connectors import ConnectorRunner
            self.runner = ConnectorRunner(executable, identity_file=self.db_path.parent / "connectors-identity.json",
                                          product="openagent", name=f"{self.agent.name} server",
                                          broker=config.get("auth_url", "https://auth.openagent.uno"),
                                          oauth_providers=config.get("oauth_providers_file"))
        self.key = None
        self.lock = asyncio.Lock()
        self.sources = {}
        self.task = None

    @property
    def available(self):
        return self.runner is not None

    def privacy_enabled(self):
        """Explicit tracker opt-in; configuration cannot attest sink coverage."""
        value = (self.agent.config.get('connectors') or {}).get('privacy')
        if value is None:
            return False
        if not isinstance(value, dict) or set(value) != {'enabled'} or type(value['enabled']) is not bool:
            raise ValueError('Connector privacy accepts only an explicit enabled boolean')
        return value['enabled']

    async def start(self):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""CREATE TABLE IF NOT EXISTS official_connector_connections (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_key TEXT NOT NULL,
                catalog_id TEXT NOT NULL, provider TEXT NOT NULL, capability TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                allow_write INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
                credential BLOB, nonce BLOB, app_id TEXT, group_id TEXT, token_version INTEGER NOT NULL DEFAULT 0,
                transaction_id TEXT, expires_at TEXT, created_at TEXT NOT NULL)""")
            await db.execute("""CREATE TABLE IF NOT EXISTS official_connector_audit (
                id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, owner_key TEXT NOT NULL,
                tool TEXT NOT NULL, invocation_id TEXT NOT NULL, phase TEXT NOT NULL, occurred_at TEXT NOT NULL)""")
            await db.execute("""CREATE TABLE IF NOT EXISTS official_connector_events (
                id TEXT PRIMARY KEY, group_id TEXT NOT NULL, topic TEXT NOT NULL,
                ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, received_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending')""")
            event_columns = {row[1] for row in await (await db.execute(
                "PRAGMA table_info(official_connector_events)")).fetchall()}
            if "receipt_format" not in event_columns:
                # Historical receipts contain only payload, without the broker
                # timestamp needed to fence a late uninstall/redaction.
                await db.execute("ALTER TABLE official_connector_events ADD COLUMN receipt_format INTEGER NOT NULL DEFAULT 1")
            encrypted_state = await (await db.execute("""SELECT
                EXISTS(SELECT 1 FROM official_connector_connections WHERE credential IS NOT NULL)
                OR EXISTS(SELECT 1 FROM official_connector_events)""")).fetchone()
            await db.commit()
        key_path = self.db_path.parent / "connector-credential-key"
        if key_path.is_symlink():
            raise RuntimeError("Connector credential key must be host-owned")
        if not key_path.exists() and encrypted_state[0]:
            raise RuntimeError("Restore the matching connector credential key before starting this server")
        try:
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, "wb") as file:
                file.write(AESGCM.generate_key(bit_length=256))
                file.flush()
                os.fsync(file.fileno())
        self.key = key_path.read_bytes()
        if len(self.key) != 32:
            raise RuntimeError("Connector credential key is invalid")
        if self.runner:
            self.task = asyncio.create_task(self._synchronize())

    async def close(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        if self.runner:
            await self.runner.close()

    async def check(self, context, write=False):
        await require_authorized(self.runtime.authorizer, context,
                                 "catalog.update" if write else "catalog.read",
                                 ResourceRef("capability", context.tenant_id, "official-connectors"))

    @staticmethod
    def source_id(connection_id):
        return f"official-connectors/{connection_id}"

    @staticmethod
    def can_use(context, row):
        return bool(row and row["enabled"] and row["status"] == "connected"
                    and row["tenant_id"] == context.tenant_id
                    and row["owner_key"] == context.initiator.key
                    and context.audience == (context.initiator,))

    async def authorize_source(self, context, resource):
        source = resource.resource_id
        if resource.kind == "tool":
            source = source.rsplit("/", 1)[0]
        if not source.startswith("official-connectors/"):
            return None
        connection_id = source.removeprefix("official-connectors/")
        return self.can_use(context, await self.record(connection_id))

    async def record(self, connection_id):
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            row = await (await db.execute("SELECT * FROM official_connector_connections WHERE id=?", (connection_id,))).fetchone()
            return dict(row) if row else None

    @staticmethod
    def public(row):
        return {key: row[key] for key in ("id", "catalog_id", "display_name", "enabled", "allow_write", "status", "app_id", "created_at")}

    async def list(self, context):
        await self.check(context)
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            rows = await (await db.execute("SELECT * FROM official_connector_connections WHERE tenant_id=? AND owner_key=? ORDER BY created_at",
                                          (context.tenant_id, context.initiator.key))).fetchall()
        return {"available": self.available, "connections": [self.public(row) for row in rows]}

    async def catalog(self, context):
        await self.check(context)
        if not self.runner:
            from openagent_connectors.catalog import bundled_catalog
            items = bundled_catalog()
            for item in items:
                if item["available"]:
                    item["available"] = False
                    item["unavailableReason"] = "The connector runner is not installed on this server."
            return {"available": False, "connectors": items}
        items = []
        for original in await self.runner.call("catalog"):
            if original.get("nativeKind"):
                continue
            item = dict(original)
            if item["available"] and item["auth"] == "oauth" and not self.authorization_available(item["provider"]):
                item["available"] = False
                item["unavailableReason"] = "Authorization is not enabled on this server."
            items.append(item)
        return {"available": True, "connectors": items}

    def authorization_available(self, provider):
        # The standalone currently has durable receipt, but no processor for
        # privacy export/redaction of derived agent content. Do not enroll a
        # Shopify recipient until that host implementation is complete.
        if provider == "shopify":
            return False
        return provider in self.official_providers or provider in self.own_providers

    async def owned(self, context, connection_id):
        await self.check(context, write=True)
        row = await self.record(connection_id)
        if not row or row["tenant_id"] != context.tenant_id or row["owner_key"] != context.initiator.key:
            raise PermissionError("Connector belongs to another principal")
        return row

    async def create(self, context, payload):
        await self.check(context, write=True)
        if not self.runner:
            raise RuntimeError("Shared connector runner is not installed")
        if not isinstance(payload, dict) or set(payload) - {"catalog_id", "display_name", "allow_write", "token", "config", "credentials"}:
            raise ValueError("Invalid connector setup")
        catalog = {item["id"]: item for item in await self.runner.call("catalog")}
        item = catalog.get(payload.get("catalog_id"))
        if not item or not item["available"] or item.get("nativeKind"):
            raise ValueError("Connector is unavailable")
        if item["auth"] not in {"oauth", "token", "credentials", "none"}:
            raise ValueError("Unsupported connector authentication")
        keyless = item["auth"] == "none"
        if keyless and (not self.keyless_binding(item) or "token" in payload or "credentials" in payload):
            raise ValueError("Keyless connectors do not accept credentials")
        if keyless and (not isinstance(payload.get("config", {}), dict) or payload.get("config", {})):
            raise ValueError("Keyless connector configuration must be empty")
        if item["auth"] == "oauth" and not self.authorization_available(item["provider"]):
            raise PermissionError("Connector authorization is not enabled")
        connection_id = uuid.uuid4().hex
        name = payload.get("display_name") or item["name"]
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("Invalid connector name")
        config = payload.get("config") or {}
        if not isinstance(config, dict) or len(json.dumps(config)) > 16384 or any("token" in key.lower() or "password" in key.lower() or "secret" in key.lower() for key in config):
            raise ValueError("Connector configuration cannot contain credentials")
        token = payload.get("token")
        if item["auth"] == "credentials":
            credentials = payload.get("credentials")
            if not isinstance(credentials, dict) or set(credentials) != {"imap_password", "smtp_password"} or any(not isinstance(v, str) or not v or len(v)>16384 or any(c in v for c in "\r\n\x00") for v in credentials.values()):
                raise ValueError("Invalid mail credentials")
            token = "gp_imap_v1." + base64.urlsafe_b64encode(json.dumps(credentials).encode()).decode().rstrip("=")

        if item["auth"] in {"token", "credentials"} and (not isinstance(token, str) or not token or len(token) > 65536 or any(ord(c) < 33 or ord(c) > 126 for c in token)):
            raise ValueError("Invalid connector token")
        if item["provider"] == "replio" and not re.fullmatch(r"rpl_[A-Za-z0-9_-]{32,128}", token):
            raise ValueError("Invalid Replio token")
        if item["provider"] == "billingbear" and (not re.fullmatch(r"sk_[A-Za-z0-9_-]{16,256}", token) or token.lower().startswith("sk_admin_")):
            raise ValueError("Invalid BillingBear token")
        self.validate_config(item, config)
        if item["auth"] == "oauth" and (payload.get("token") is not None or payload.get("credentials") is not None):
            raise ValueError("OAuth credentials must come from verified consent")
        await self.check(context, write=True)
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("INSERT INTO official_connector_connections(id,tenant_id,owner_key,catalog_id,provider,capability,display_name,allow_write,status,config,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                             (connection_id, context.tenant_id, context.initiator.key, item["id"], item["provider"], item["capability"], name,
                              int(payload.get("allow_write") is True), "pending", json.dumps(config), datetime.now(timezone.utc).isoformat()))
            await db.commit()
        row = await self.record(connection_id)
        if item["auth"] == "oauth":
            return await self.connect(context, connection_id)
        await self.owned(context, connection_id)
        if keyless:
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute(
                    "UPDATE official_connector_connections SET status='connected' WHERE "
                    + " AND ".join(key + " IS ?" for key in self._binding_fields)
                    + " AND status='pending' AND credential IS NULL AND nonce IS NULL",
                    tuple(row[key] for key in self._binding_fields))
                if cursor.rowcount != 1:
                    raise PermissionError("Connector binding changed during setup")
                await db.commit()
            await self.register_source(connection_id)
            return {"connection": self.public(await self.record(connection_id))}
        await self.save(row, {"access_token": token, "scopes": [], "app_id": "personal-token"})
        return {"connection": self.public(await self.record(connection_id))}

    @staticmethod
    def validate_config(item, config):
        # Host setup accepts only reviewed public connection fields. Unknown or
        # nested metadata must never become an accidental plaintext secret store.
        provider = item["provider"]
        if item["auth"] == "none":
            valid = OfficialConnectors.keyless_binding(item) and not config
        elif provider == "shopify":
            valid = set(config) == {"shop"} and OfficialConnectors.valid_shop(config["shop"])
        elif item["auth"] == "oauth":
            valid = not config
        elif provider == "replio":
            valid = set(config) == {"organization_id"} and isinstance(config["organization_id"], str) and bool(re.fullmatch(r"[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}", config["organization_id"]))
        elif provider == "billingbear":
            valid = set(config) == {"project_id"} and isinstance(config["project_id"], str) and bool(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", config["project_id"]))
        elif provider == "pipeboard":
            valid = set(config) == {"ads_provider"} and isinstance(config["ads_provider"], str) and config["ads_provider"] in {"meta_ads", "google_ads"}
        elif provider == "imap_smtp":
            required = {"imap_host", "imap_port", "username", "mailbox", "tls_mode", "smtp_host", "smtp_port", "smtp_tls_mode", "smtp_from"}
            valid = set(config) == required and all(isinstance(config[key], str) for key in required - {"imap_port", "smtp_port"})
            if valid:
                for key in ("imap_host", "smtp_host"):
                    host = config[key]
                    valid = valid and len(host) <= 253 and bool(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", host)) and not host.endswith((".local", ".internal", ".localhost", ".svc", ".svc.cluster.local"))
                    try:
                        import ipaddress
                        ipaddress.ip_address(host)
                    except ValueError:
                        pass
                    else:
                        valid = False
                valid = valid and type(config["imap_port"]) is int and (config["imap_port"], config["tls_mode"]) in {(993, "implicit_tls"), (143, "starttls")}
                valid = valid and type(config["smtp_port"]) is int and (config["smtp_port"], config["smtp_tls_mode"]) in {(465, "implicit_tls"), (587, "starttls")}
                valid = valid and 0 < len(config["username"]) <= 320 and 0 < len(config["mailbox"]) <= 512 and all(config[key] == config[key].strip() and not any(char in config[key] for char in "\r\n\x00") for key in ("username", "mailbox"))
                valid = valid and len(config["smtp_from"]) <= 254 and bool(re.fullmatch(r"[^<>\s@]+@[^<>\s@]+", config["smtp_from"]))
        else:
            valid = False
        if not valid:
            raise ValueError("Invalid public connector configuration")

    @staticmethod
    def valid_shop(shop):
        return isinstance(shop, str) and bool(re.fullmatch(
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com", shop))

    async def connect(self, context, connection_id):
        row = await self.owned(context, connection_id)
        item = next(item for item in await self.runner.call("catalog") if item["id"] == row["catalog_id"])
        if item["auth"] != "oauth":
            raise ValueError("Connector does not use OAuth")
        if not self.authorization_available(item["provider"]):
            raise PermissionError("Connector authorization is not enabled")
        start = {"provider": item["provider"]}
        if item["provider"] == "shopify":
            config = json.loads(row["config"])
            # Historical connections can reuse only their locally verified
            # shop binding; reconnect never asks for an arbitrary new shop.
            previous = self.decrypt(row) if not config and row.get("credential") else {}
            shop = config.get("shop") if config else previous.get("external_id")
            if not self.valid_shop(shop):
                raise ValueError("A valid Shopify store is required")
            start["shop"] = shop
        await self.runner.call("auth.register")
        transaction = await self.runner.call("auth.start", start)
        await self.check(context, write=True)
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("UPDATE official_connector_connections SET transaction_id=?,expires_at=? WHERE id=? AND owner_key=? AND status!='disconnected'",
                             (transaction["id"], transaction["expires_at"], connection_id, context.initiator.key))
            await db.commit()
        return {"connection": self.public(row), "authorization_url": transaction["authorization_url"], "expires_at": transaction["expires_at"], "authorization_mode": transaction.get("mode", "broker"),
                "authorization_origin": (self.agent.config.get("connectors") or {}).get("auth_url", "https://auth.openagent.uno")}

    async def poll(self, context, connection_id):
        async with self.lock:
            row = await self.owned(context, connection_id)
            if not self.authorization_available(row["provider"]):
                raise PermissionError("Connector authorization is not enabled")
            if not row["transaction_id"]:
                return {"status": row["status"]}
            transaction = await self.runner.call("auth.poll", {"id": row["transaction_id"]})
            if transaction["status"] != "ready":
                return {"status": transaction["status"]}
            rotation = await self.runner.call("auth.redeem", {"id": row["transaction_id"]})
            await self.owned(context, connection_id)
            token = rotation["token"]
            token["group"] = rotation.get("group", "")
            token["recipients"] = rotation.get("recipients", [])
            await self.save(row, token, authorization_transaction=row["transaction_id"])
            if token["group"]:
                await self.runner.call("auth.publish", rotation)
            return {"status": "connected", "connection": self.public(await self.record(connection_id))}

    @classmethod
    def keyless_binding(cls, row):
        return (row.get("catalog_id", row.get("id")), row.get("provider"), row.get("capability")) in cls._keyless_bindings

    async def require_keyless_catalog(self, row):
        # Only the installed, pinned official runner supplies this catalog.
        # Neither a request payload nor mutable custom MCP metadata can opt in.
        items = [item for item in await self.runner.call("catalog")
                 if item.get("id") == row["catalog_id"]]
        if (len(items) != 1 or items[0].get("auth") != "none"
                or not items[0].get("available") or items[0].get("nativeKind")
                or not self.keyless_binding(items[0])):
            raise PermissionError("Keyless connector is not admitted by the official catalog")

    def decrypt(self, row):
        if self.keyless_binding(row):
            if (row["status"] != "connected" or json.loads(row["config"]) != {}
                    or any(row.get(key) is not None for key in
                           ("credential", "nonce", "app_id", "group_id", "transaction_id"))
                    or row["token_version"] != 0):
                raise PermissionError("Invalid keyless connector state")
            return {}
        if not row["credential"]:
            raise RuntimeError("Connector needs authorization")
        aad = f'{row["tenant_id"]}/{row["owner_key"]}/{row["id"]}/{row["catalog_id"]}'.encode()
        return json.loads(AESGCM(self.key).decrypt(row["nonce"], row["credential"], aad))

    def source_snapshot(self, row):
        token = self.decrypt(row)
        authorized_at = token.get("authorized_at")
        if authorized_at is not None:
            authorized_at = datetime.fromisoformat(authorized_at.replace("Z", "+00:00"))
        return tuple(row[key] for key in (
            "id", "tenant_id", "owner_key", "catalog_id", "provider", "capability",
            "display_name", "config", "enabled", "allow_write", "status", "app_id", "group_id")) + (
                authorized_at, token.get("external_id"), tuple(token.get("scopes", ())))

    def same_consent(self, row, token):
        previous = self.decrypt(row)
        if any(previous.get(key) != token.get(key) for key in ("app_id", "external_id", "scopes")):
            return False
        if previous.get("group", "") != token.get("group", ""):
            return False
        old, new = previous.get("authorized_at"), token.get("authorized_at")
        # Older product-owned apps lack a consent timestamp. Only a renewal
        # of their exact held credential may preserve this legacy registration.
        if old is None or new is None:
            return old is None and new is None and not token.get("group")
        try:
            old = datetime.fromisoformat(old.replace("Z", "+00:00"))
            new = datetime.fromisoformat(new.replace("Z", "+00:00"))
        except (AttributeError, ValueError):
            return False
        return old.tzinfo is not None and new.tzinfo is not None and old == new

    async def save(self, row, token, *, authorization_transaction=None, renewal=False):
        if self.keyless_binding(row):
            raise ValueError("Keyless connections do not accept credentials")
        if row["provider"] == "shopify":
            shop = json.loads(row["config"]).get("shop")
            if shop is not None and token.get("external_id") != shop:
                raise PermissionError("Shopify consent belongs to another store")
        if renewal and (authorization_transaction is not None or not self.same_consent(row, token)):
            raise PermissionError("Renewal changed the connector consent or permissions")
        aad = f'{row["tenant_id"]}/{row["owner_key"]}/{row["id"]}/{row["catalog_id"]}'.encode()
        nonce = os.urandom(12)
        ciphertext = AESGCM(self.key).encrypt(nonce, json.dumps(token).encode(), aad)
        async with aiosqlite.connect(self.db_path) as db:
            if renewal:
                # Compare the credential and complete local binding atomically.
                # Neither a new grant nor an ACL edit during authentication IO
                # can be overwritten by this response.
                keys = self._binding_fields
                cursor = await db.execute(
                    "UPDATE official_connector_connections SET credential=?,nonce=?,token_version=? WHERE "
                    + " AND ".join(key + " IS ?" for key in keys)
                    + " AND status='connected' AND enabled=1 AND token_version<=?",
                    (ciphertext, nonce, token.get("version", 0), *(row[key] for key in keys), token.get("version", 0)))
            else:
                cursor = await db.execute("UPDATE official_connector_connections SET credential=?,nonce=?,app_id=?,group_id=?,token_version=?,status='connected',transaction_id=NULL WHERE id=? AND owner_key=? AND status!='disconnected' AND ((? IS NOT NULL AND transaction_id=?) OR (? IS NULL AND (app_id IS NULL OR app_id=?) AND token_version<=?))",
                                     (ciphertext, nonce, token["app_id"], token.get("group", ""), token.get("version", 0),
                                      row["id"], row["owner_key"], authorization_transaction, authorization_transaction, authorization_transaction, token["app_id"], token.get("version", 0)))
            if cursor.rowcount != 1:
                raise PermissionError("Connector was disconnected or credential generation changed")
            await db.commit()
        if not renewal:
            await self.register_source(row["id"])

    async def register_source(self, connection_id):
        catalog = getattr(getattr(self.runtime, "runtime", None), "capabilities", None)
        if catalog and self.runner:
            row = await self.record(connection_id)
            if self.keyless_binding(row):
                await self.require_keyless_catalog(row)
                self.decrypt(row)
            catalog.revoke(self.source_id(connection_id))
            self.sources.pop(connection_id, None)
            source = OfficialConnectorSource(self, connection_id, registered=True)
            options = {}
            publisher = getattr(self.privacy_processor,'publisher',None)
            if publisher is not None:
                from .connector_provenance import OfficialConnectorProvenance, independent_result
                row=await self.record(connection_id)
                definitions=await self.runner.call('tools',self.binding(row,self.decrypt(row)))
                # These declarations come from the verified local official
                # runner, never custom MCP metadata or model annotations.
                options['privacy_fenced']={tool['name']:tool['risk']=='read' for tool in definitions}
                options['result_provenance']=independent_result
                if row['provider']=='shopify' and row.get('group_id'):
                    source.privacy=OfficialConnectorProvenance(self,connection_id,publisher)
                    options.update(invocation_provenance=source.privacy.invocation,result_provenance=source.privacy.result)
                    options['privacy_fenced']['commerce.shopify.customers.update']=True
            self.sources[connection_id] = source
            catalog.register(self.source_id(connection_id), source, source, target_label="OpenAgent official connector", **options)

    async def attach_sources(self):
        async with aiosqlite.connect(self.db_path) as db:
            rows = await (await db.execute("SELECT id FROM official_connector_connections WHERE enabled=1 AND status='connected'")).fetchall()
        for row in rows:
            await self.register_source(row[0])

    async def update(self, context, connection_id, payload):
        row = await self.owned(context, connection_id)
        if set(payload) - {"enabled", "allow_write"} or any(type(v) is not bool for v in payload.values()):
            raise ValueError("Invalid connector permissions")
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("UPDATE official_connector_connections SET enabled=?,allow_write=? WHERE id=?",
                             (int(payload.get("enabled", bool(row["enabled"]))), int(payload.get("allow_write", bool(row["allow_write"]))), connection_id))
            await db.commit()
        catalog = getattr(getattr(self.runtime, "runtime", None), "capabilities", None)
        if catalog:
            catalog.revoke(self.source_id(connection_id))
        self.sources.pop(connection_id, None)
        if (await self.record(connection_id))["enabled"]:
            await self.register_source(connection_id)
        return self.public(await self.record(connection_id))

    async def disconnect(self, context, connection_id):
        async with self.lock:
            row = await self.owned(context, connection_id)
            group = row["group_id"]
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute("UPDATE official_connector_connections SET status='disconnected',enabled=0,credential=NULL,nonce=NULL,transaction_id=NULL WHERE id=?", (connection_id,))
                await db.commit()
            catalog = getattr(getattr(self.runtime, "runtime", None), "capabilities", None)
            if catalog:
                catalog.revoke(self.source_id(connection_id))
            self.sources.pop(connection_id, None)
            if group and self.runner:
                try:
                    await self.runner.call("sync.disconnect", {"group": group})
                except RuntimeError:
                    pass

    def binding(self, row, token):
        provider, capability = row["provider"], row["capability"]
        tenant = hashlib.sha256(row["tenant_id"].encode()).hexdigest()
        return {"catalog_id": row["catalog_id"], "allow_write": bool(row["allow_write"]),
                "principal": {"workspace_id": tenant, "actor_id": row["owner_key"], "role": "owner"},
                "connection": {"id": row["id"], "workspace_id": tenant, "provider": provider,
                               "capability": capability, "display_name": row["display_name"],
                               "external_id": token.get("external_id", ""), "scopes": token.get("scopes", []),
                               "config": json.loads(row["config"]), "enabled": bool(row["enabled"])}}

    @staticmethod
    def credential(row, token):
        if OfficialConnectors.keyless_binding(row):
            if token:
                raise ValueError("Keyless connections do not accept credentials")
            return {"kind": "none"}
        personal = token["app_id"] == "personal-token"
        return {"kind": "api_token" if personal else "oauth2_bearer", "secret": token["access_token"],
                "header": "X-Shopify-Access-Token" if row["catalog_id"] == "shopify" else "Authorization",
                "scheme": "" if row["catalog_id"] in {"shopify", "imap_smtp", "postiz"} else "Bearer",
                "version": str(token.get("version", 0)), "expires_at": token.get("expires_at")}

    @staticmethod
    def require_refresh_credential(token):
        if token.get("app_id") == "personal-token":
            raise PermissionError("Only an OAuth connection can be renewed")
        refresh = token.get("refresh_token")
        if not isinstance(refresh, str) or not refresh:
            raise ValueError("This connection has no refresh credential")

    async def refresh(self, context, connection_id):
        row = await self.owned(context, connection_id)
        if not self.can_use(context, row):
            raise PermissionError("Connector binding is unavailable")
        self.require_refresh_credential(self.decrypt(row))
        if not self.runner:
            raise RuntimeError("Shared connector runner is not installed")
        item = next((item for item in await self.runner.call("catalog")
                     if item["id"] == row["catalog_id"]), None)
        if not item or item["auth"] != "oauth" or item["provider"] != row["provider"]:
            raise PermissionError("Only an OAuth connection can be renewed")
        await self.current_token(row, context=context, force_refresh=True)
        current = await self.owned(context, connection_id)
        if not self.can_use(context, current) or self.source_snapshot(row) != self.source_snapshot(current):
            raise PermissionError("Connector binding is unavailable")
        return {"status": current["status"], "connection": self.public(current)}

    @staticmethod
    def valid_cloud_id(value):
        return (isinstance(value, str) and value != "00000000-0000-0000-0000-000000000000"
                and bool(re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value)))

    async def _atlassian_sites(self, context, connection_id):
        row = await self.owned(context, connection_id)
        if row["provider"] != "atlassian" or not self.can_use(context, row):
            raise PermissionError("An active Atlassian connection is required")
        source = self.sources.get(connection_id)
        if source is None:
            raise RuntimeError("Connector source is unavailable")
        # The same registered source owns credential renewal, binding and audit.
        # No site or URL is accepted as an argument to accessible-resources.
        result = await source.call_tool("files.atlassian.resources.list", {}, context)
        current = await self.owned(context, connection_id)
        source.require_current_registration()
        if not self.can_use(context, current) or self.source_snapshot(row) != self.source_snapshot(current):
            raise PermissionError("Connector binding is unavailable")
        if not isinstance(result, list) or len(result) > 1000:
            raise RuntimeError("Provider returned invalid accessible resources")
        required = {"read:jira-work"}
        if current["allow_write"]:
            required.add("write:jira-work")
        if not required.issubset(self.decrypt(current).get("scopes", [])):
            raise PermissionError("The connection has no required Jira scope")
        sites, seen = [], set()
        for resource in result:
            if not isinstance(resource, dict):
                raise RuntimeError("Provider returned invalid accessible resources")
            scopes = resource.get("scopes")
            if (not isinstance(scopes, list) or len(scopes) > 100
                    or any(not isinstance(scope, str) or len(scope) > 200 for scope in scopes)):
                raise RuntimeError("Provider returned invalid resource scopes")
            if not required.issubset(scopes):
                continue
            cloud_id = resource.get("id")
            if not self.valid_cloud_id(cloud_id) or cloud_id in seen:
                raise RuntimeError("Provider returned ambiguous resource identity")
            name, url = resource.get("name", ""), resource.get("url", "")
            if any(not isinstance(value, str) or len(value) > 2048
                   or any(ord(char) < 32 or ord(char) == 127 for char in value) for value in (name, url)):
                raise RuntimeError("Provider returned invalid resource metadata")
            if url:
                try:
                    parsed = urlsplit(url)
                    valid_url = parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password
                except ValueError:
                    valid_url = False
                if not valid_url:
                    raise RuntimeError("Provider returned invalid resource metadata")
            seen.add(cloud_id)
            sites.append({"id": cloud_id, "name": name, "url": url, "scopes": sorted(set(scopes))})
        return current, sites

    async def sites(self, context, connection_id):
        row, sites = await self._atlassian_sites(context, connection_id)
        return {"sites": sites, "selected_cloud_id": json.loads(row["config"]).get("cloud_id")}

    async def select_site(self, context, connection_id, payload):
        if not isinstance(payload, dict) or set(payload) != {"cloud_id"} or not self.valid_cloud_id(payload["cloud_id"]):
            raise ValueError("Select a canonical Atlassian site ID")
        row, sites = await self._atlassian_sites(context, connection_id)
        if payload["cloud_id"] not in {site["id"] for site in sites}:
            raise PermissionError("This Jira site was not granted to the connection")
        async with self.lock:
            current = await self.owned(context, connection_id)
            if not self.can_use(context, current) or self.source_snapshot(row) != self.source_snapshot(current):
                raise PermissionError("Connector binding is unavailable")
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute(
                    "UPDATE official_connector_connections SET config=? WHERE "
                    + " AND ".join(key + " IS ?" for key in self._binding_fields)
                    + " AND status='connected' AND enabled=1",
                    (json.dumps({"cloud_id": payload["cloud_id"]}), *(row[key] for key in self._binding_fields)))
                if cursor.rowcount != 1:
                    raise PermissionError("Connector binding changed during site selection")
                # Revoke old references before the new target becomes visible.
                # A failed commit leaves access fenced, never on another site.
                catalog = getattr(getattr(self.runtime, "runtime", None), "capabilities", None)
                if catalog:
                    catalog.revoke(self.source_id(connection_id))
                self.sources.pop(connection_id, None)
                await db.commit()
            await self.register_source(connection_id)
        return {"ok": True, "cloud_id": payload["cloud_id"]}

    async def current_token(self, row, *, context=None, force_refresh=False):
        async with self.lock:
            admitted = row
            row = await self.record(row["id"])
            if context is not None and not self.can_use(context, row):
                raise PermissionError("Connector binding is unavailable")
            if context is not None and self.source_snapshot(admitted) != self.source_snapshot(row):
                raise PermissionError("Connector consent or permissions changed before authentication")
            if self.keyless_binding(row):
                await self.require_keyless_catalog(row)
                current = await self.record(row["id"])
                if (any(row[key] != current[key] for key in self._binding_fields)
                        or context is not None and not self.can_use(context, current)):
                    raise PermissionError("Connector binding changed before invocation")
            token = self.decrypt(row)
            if force_refresh:
                if context is None:
                    raise PermissionError("Renewal requires the authenticated owner")
                current = await self.owned(context, row["id"])
                if not self.can_use(context, current) or self.source_snapshot(row) != self.source_snapshot(current):
                    raise PermissionError("Connector binding is unavailable")
                self.require_refresh_credential(token)
            expiry = token.get("expires_at")
            if force_refresh or (expiry and datetime.fromisoformat(expiry.replace("Z", "+00:00")).timestamp() < datetime.now(timezone.utc).timestamp() + 120):
                provider = self.binding(row, token)["connection"]["provider"]
                try:
                    rotation = await self.runner.call("auth.refresh", {"provider": provider, "token": {k: v for k, v in token.items() if k not in {"group", "recipients"}}})
                except RuntimeError:
                    if not force_refresh and datetime.fromisoformat(expiry.replace("Z", "+00:00")) > datetime.now(timezone.utc):
                        return token
                    raise
                if force_refresh:
                    # Authorization can be revoked while the broker is doing
                    # IO; the storage CAS below also fences binding/grant edits.
                    current = await self.owned(context, row["id"])
                    if not self.can_use(context, current) or self.source_snapshot(row) != self.source_snapshot(current):
                        raise PermissionError("Connector binding is unavailable")
                token = rotation["token"]
                token["group"] = rotation.get("group", "")
                token["recipients"] = rotation.get("recipients", [])
                await self.save(row, token, renewal=True)
                if token["group"]:
                    await self.runner.call("auth.publish", rotation)
            return token

    async def audit(self, row, tool, invocation_id, phase):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("INSERT INTO official_connector_audit VALUES(?,?,?,?,?,?,?)",
                             (uuid.uuid4().hex, row["id"], row["owner_key"], tool, invocation_id, phase, datetime.now(timezone.utc).isoformat()))
            await db.commit()

    async def _has_broker_registration(self):
        async with aiosqlite.connect(self.db_path) as db:
            consent = await (await db.execute("""SELECT EXISTS(
                SELECT 1 FROM official_connector_connections WHERE transaction_id IS NOT NULL
                OR (app_id IS NOT NULL AND app_id!='personal-token')
                OR (group_id IS NOT NULL AND group_id!=''))""")).fetchone()
        return bool(consent[0])

    async def synchronize(self):
        mail = await self.runner.call("sync.mail")
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            rows = [dict(row) for row in await (await db.execute("SELECT * FROM official_connector_connections WHERE enabled=1 AND status='connected' AND group_id!=''")).fetchall()]
        for envelope in mail.get("envelopes", []):
            sender = mail["installations"].get(envelope["sender"])
            if not sender:
                continue
            group = mail.get("groups", {}).get(envelope["group"])
            if not group:
                continue
            token = await self.runner.call("sync.open", {"envelope": envelope, "sender": sender, "group": group})
            for row in rows:
                if row["group_id"] == envelope["group"] and row["app_id"] == token["app_id"] and token.get("version") == envelope["version"] and token["version"] > row["token_version"] and token.get("external_id") == self.decrypt(row).get("external_id"):
                    token["group"] = row["group_id"]
                    await self.save(row, token, renewal=True)
                    await self.runner.call("sync.commit", {"group": row["group_id"], "version": token["version"]})
        for request in mail.get("recoveries", []):
            for row in rows:
                if row["group_id"] == request["group"] and row["token_version"] == request["version"]:
                    token = self.decrypt(row)
                    await self.runner.call("sync.send", {"group": row["group_id"], "recipient": request["recipient"],
                                                          "token": {k: v for k, v in token.items() if k not in {"group", "recipients"}}})
        for row in rows:
            token = self.decrypt(row)
            try:
                await self.runner.call("auth.publish", {"group": row["group_id"], "token": {k: v for k, v in token.items() if k not in {"group", "recipients"}}, "recipients": token.get("recipients", [])})
            except RuntimeError:
                await self.runner.call("sync.recover", {"group": row["group_id"]})
        for event in await self.runner.call("events"):
            await self.receive_event(event)
            await self.runner.call("events.ack", {"id": event["id"]})
        await self.process_privacy_events()

    async def process_privacy_events(self):
        """Resume local work independently of broker delivery acknowledgements.

        No configured processor means receipt remains pending. Old payload-only
        rows remain blocked until authenticated redelivery restores occurrence
        metadata. The Shopify admission gate remains separately closed.
        """
        if self.privacy_processor is None:
            return
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            events = [dict(row) for row in await (await db.execute(
                "SELECT * FROM official_connector_events WHERE status IN ('pending','blocked') ORDER BY received_at LIMIT 32")).fetchall()]
            connections = [dict(row) for row in await (await db.execute(
                "SELECT tenant_id,provider,app_id,group_id FROM official_connector_connections")).fetchall()]
        for event in events:
            status = 'blocked'
            if event['receipt_format'] == 2:
                try:
                    receipt = json.loads(AESGCM(self.key).decrypt(event['nonce'],event['ciphertext'],event['id'].encode()))
                    status = await self.privacy_processor.process(receipt,connections)
                    if status not in {'complete','blocked','credential_revoked'}:
                        status = 'blocked'
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Retries preserve origin metadata; no payload or exception
                    # message enters receipts/logs after a sink failure.
                    status = 'blocked'
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute("UPDATE official_connector_events SET status=? WHERE id=? AND status IN ('pending','blocked')", (status,event['id']))
                await db.commit()

    async def privacy_export(self, context, request_id):
        await self.check(context)
        exports = getattr(self.privacy_processor, 'exports', None)
        if exports is None:
            raise RuntimeError('Local privacy export service is unavailable')
        bundle = await exports.download(request_id, context)
        return {'request_id': request_id, 'bundle': json.loads(bundle.payload),
                'delivery_token': bundle.delivery_token}

    async def privacy_export_ack(self, context, request_id, payload):
        await self.check(context, write=True)
        if not isinstance(payload, dict) or set(payload) != {'delivery_token'}:
            raise ValueError('An exact export delivery receipt is required')
        exports = getattr(self.privacy_processor, 'exports', None)
        if exports is None:
            raise RuntimeError('Local privacy export service is unavailable')
        await exports.acknowledge(request_id, context, payload['delivery_token'])
        await self.process_privacy_events()
        return {'ok': True}

    async def receive_event(self, event):
        """Commit the complete verified broker receipt before delivery ACK.

        Receipt is not a privacy-completion claim. Preserve immutable origin
        and occurrence metadata so a future processor can apply the same
        generation fence after restart; never manufacture it for old rows.
        """
        if (not isinstance(event, dict) or not all(isinstance(event.get(key), str) and event[key]
                                                 for key in ("id", "group", "topic", "created_at"))
                or event["topic"] not in {"app/uninstalled", "shop/redact", "customers/redact", "customers/data_request"}
                or not isinstance(event.get("payload"), dict)):
            raise ValueError("Invalid connector privacy receipt")
        occurred = event.get("occurred_at") or event["created_at"]
        occurrence = datetime.fromisoformat(occurred.replace("Z", "+00:00"))
        created = datetime.fromisoformat(event["created_at"].replace("Z", "+00:00"))
        if occurrence.tzinfo is None or created.tzinfo is None:
            raise ValueError("Connector privacy receipt requires timezone-aware timestamps")
        receipt = {key: event[key] for key in ("id", "group", "topic", "payload", "created_at")}
        receipt["occurred_at"] = occurred
        encoded = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
        if len(encoded) > 2 * 1024 * 1024:
            raise ValueError("Connector privacy receipt exceeds the supported size")
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            # Serialize duplicate receipt comparison, upgrade and revocation.
            await db.execute("BEGIN IMMEDIATE")
            old = await (await db.execute("SELECT * FROM official_connector_events WHERE id=?", (event["id"],))).fetchone()
            if old:
                previous = json.loads(AESGCM(self.key).decrypt(old["nonce"], old["ciphertext"], event["id"].encode()))
                if (old["group_id"] != event["group"] or old["topic"] != event["topic"]
                        or previous != (receipt if old["receipt_format"] == 2 else event["payload"])):
                    raise ValueError("Connector privacy receipt conflicts with durable delivery")
            if not old or old["receipt_format"] == 1:
                nonce = os.urandom(12)
                ciphertext = AESGCM(self.key).encrypt(nonce, encoded, event["id"].encode())
                if old:
                    # Only a matching authenticated broker redelivery can
                    # enrich an old payload-only receipt. Retain job status.
                    await db.execute("UPDATE official_connector_events SET ciphertext=?,nonce=?,receipt_format=2 WHERE id=?",
                                     (ciphertext, nonce, event["id"]))
                else:
                    await db.execute("INSERT INTO official_connector_events(id,group_id,topic,ciphertext,nonce,received_at,receipt_format) VALUES(?,?,?,?,?,?,2)",
                                     (event["id"], event["group"], event["topic"], ciphertext, nonce, datetime.now(timezone.utc).isoformat()))
            if event["topic"] in {"app/uninstalled", "shop/redact"}:
                targets = await (await db.execute("SELECT * FROM official_connector_connections WHERE group_id=? AND credential IS NOT NULL", (event["group"],))).fetchall()
                for target in targets:
                    token = self.decrypt(dict(target))
                    authorized = token.get("authorized_at")
                    if authorized is None or datetime.fromisoformat(authorized.replace("Z", "+00:00")) <= occurrence:
                        await db.execute("UPDATE official_connector_connections SET enabled=0,status='disconnected',credential=NULL,nonce=NULL WHERE id=?", (target["id"],))
            await db.commit()

    async def _synchronize(self):
        while True:
            await asyncio.sleep(15)
            try:
                async with self.lock:
                    # Catalog availability is not enrollment. Fresh/keyless/
                    # personal-token servers do not poll the central broker.
                    if await self._has_broker_registration():
                        await self.synchronize()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Errors never contain credentials; the next authenticated cycle
                # resumes delivery, and current tokens remain usable.
                pass
            try:
                # Local privacy work must progress during broker outages too.
                await self.process_privacy_events()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
