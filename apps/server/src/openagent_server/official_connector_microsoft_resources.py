"""Owner-authorized resource selection through the shared Microsoft adapters.

Only discovery results may seed connection bindings. This module has no Graph
client, credentials API, URL argument or model-facing configuration surface.
"""
from __future__ import annotations

import json
import re

import aiosqlite


_HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sharepoint\.com")
_GUID = re.compile(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")
_ID = re.compile(r"[A-Za-z0-9_+=!./-]+")
_PAGE = re.compile(r"[A-Za-z0-9_-]+")


def _text(value, maximum):
    if not isinstance(value, str) or not 0 < len(value) <= maximum:
        return False
    try:
        if len(value.encode("utf-8")) > maximum:
            return False
    except UnicodeError:
        return False
    return all(ord(char) >= 32 and ord(char) != 127 for char in value)


def _site_host(value):
    if not isinstance(value, str):
        return None
    parts = value.split(",")
    if (len(parts) != 3 or not _HOST.fullmatch(parts[0])
            or not _GUID.fullmatch(parts[1]) or not _GUID.fullmatch(parts[2])):
        return None
    return parts[0]


def _drive_id(value):
    return (_text(value, 1024) and bool(_ID.fullmatch(value))
            and value not in {".", ".."})


def _payload(payload, *, kind, selection=False):
    if not isinstance(payload, dict):
        raise ValueError("Invalid Microsoft resource selection")
    allowed = {"page_token"}
    required = set()
    if not selection:
        allowed.add("kind")
        required.add("kind")
    if kind == "sites":
        allowed.add("query")
        required.add("query")
        query = payload.get("query")
        if not _text(query, 120) or not query.strip() or "*" in query:
            raise ValueError("Enter a bounded non-wildcard site query")
    if selection:
        key = "site_id" if kind == "sites" else "drive_id"
        allowed.add(key)
        required.add(key)
        valid = bool(_site_host(payload.get(key))) if kind == "sites" else _drive_id(payload.get(key))
        if not valid:
            raise ValueError("Select a canonical Microsoft resource ID")
    if set(payload) - allowed or not required.issubset(payload):
        raise ValueError("Invalid Microsoft resource selection")
    page = payload.get("page_token")
    if "page_token" in payload and (not _text(page, 16384) or not _PAGE.fullmatch(page)):
        raise ValueError("Invalid Microsoft resource page")
    return page


def _generation(service, row):
    # Includes local credential generation, permissions and consent state. These
    # values are compared in RAM, never returned as management metadata.
    return tuple(row[key] for key in service._binding_fields)


def _eligible(service, context, row):
    if (not service.can_use(context, row) or row["provider"] not in {"onedrive", "sharepoint"}
            or row["catalog_id"] != row["provider"] or row["capability"] != "files"
            or not row.get("app_id") or row["app_id"] == "personal-token"):
        raise PermissionError("An active Microsoft OAuth connection is required")


def _items(data, kind):
    if (not isinstance(data, dict) or set(data) - {"value", "next_page_token"}
            or not isinstance(data.get("value"), list) or len(data["value"]) > 100):
        raise RuntimeError("Provider returned invalid Microsoft resources")
    page = data.get("next_page_token")
    if page is not None and (not _text(page, 16384) or not _PAGE.fullmatch(page)):
        raise RuntimeError("Provider returned an invalid resource page")
    items, seen = [], set()
    for raw in data["value"]:
        if not isinstance(raw, dict):
            raise RuntimeError("Provider returned invalid resource metadata")
        resource_id = raw.get("id")
        host = _site_host(resource_id) if kind == "sites" else None
        if ((kind == "sites" and not host) or (kind == "drives" and not _drive_id(resource_id))
                or resource_id in seen):
            raise RuntimeError("Provider returned an ambiguous resource identity")
        name = raw.get("displayName") or raw.get("name") or resource_id
        if not _text(name, 1024):
            raise RuntimeError("Provider returned invalid resource metadata")
        selected_host = raw.get("sharepoint_host")
        if selected_host is not None and (not isinstance(selected_host, str)
                or not _HOST.fullmatch(selected_host) or host and host != selected_host):
            raise RuntimeError("Provider returned invalid resource host metadata")
        item = {"id": resource_id, "name": name}
        if selected_host is not None:
            # This is a hostname from the fixed SDK response, not a URL or a
            # caller-selected origin. It is used only when persisting a binding.
            item["sharepoint_host"] = selected_host
        if kind == "drives" and "driveType" in raw:
            if not _text(raw["driveType"], 64):
                raise RuntimeError("Provider returned invalid drive metadata")
            item["drive_type"] = raw["driveType"]
        seen.add(resource_id)
        items.append(item)
    return items, page


async def _read(service, context, connection_id, kind, payload):
    row = await service.owned(context, connection_id)
    _eligible(service, context, row)
    if kind == "sites" and row["provider"] != "sharepoint":
        raise ValueError("Site search requires SharePoint")
    if kind == "drives" and row["provider"] == "sharepoint" and not json.loads(row["config"]).get("site_id"):
        raise ValueError("Select a SharePoint site before its document library")
    source = service.sources.get(connection_id)
    if source is None:
        raise RuntimeError("Connector source is unavailable")
    source.require_current_registration()
    consent = service.source_snapshot(row)
    # Complete any ordinary renewal before taking the generation used for the
    # provider read/CAS. A second concurrent renewal invalidates this selection.
    await service.current_token(row, context=context)
    row = await service.owned(context, connection_id)
    _eligible(service, context, row)
    source.require_current_registration()
    if service.source_snapshot(row) != consent:
        raise PermissionError("Connector consent changed before resource discovery")
    generation = _generation(service, row)
    arguments = {"top": 100}
    if kind == "sites":
        arguments["query"] = payload["query"]
    if payload.get("page_token"):
        arguments["page_token"] = payload["page_token"]
    suffix = "sites.search" if kind == "sites" else "drives.list"
    data = await source.call_tool(f"files.{row['provider']}.{suffix}", arguments, context)
    current = await service.owned(context, connection_id)
    _eligible(service, context, current)
    source.require_current_registration()
    if _generation(service, current) != generation:
        raise PermissionError("Connector binding changed during resource discovery")
    items, page = _items(data, kind)
    return current, source, items, page


def _response(row, items, page):
    config = json.loads(row["config"])
    response = {"items": [{key: value for key, value in item.items() if key != "sharepoint_host"}
                          for item in items],
                "selected_site_id": config.get("site_id"),
                "selected_drive_id": config.get("drive_id")}
    if page is not None:
        response["next_page_token"] = page
    return response


async def resources(service, context, connection_id, payload):
    if not isinstance(payload, dict) or payload.get("kind") not in {"sites", "drives"}:
        raise ValueError("Select sites or drives")
    kind = payload["kind"]
    _payload(payload, kind=kind)
    row, _, items, page = await _read(service, context, connection_id, kind, payload)
    return _response(row, items, page)


async def _store(service, context, row, source, config):
    async with service.lock:
        current = await service.owned(context, row["id"])
        _eligible(service, context, current)
        source.require_current_registration()
        if _generation(service, current) != _generation(service, row):
            raise PermissionError("Connector binding changed before resource selection")
        async with aiosqlite.connect(service.db_path) as db:
            await service.check(context, write=True)
            cursor = await db.execute(
                "UPDATE official_connector_connections SET config=? WHERE "
                + " AND ".join(key + " IS ?" for key in service._binding_fields)
                + " AND status='connected' AND enabled=1",
                (json.dumps(config), *(current[key] for key in service._binding_fields)))
            if cursor.rowcount != 1:
                raise PermissionError("Connector binding changed during resource selection")
            # Old references are fenced before the new target commits. A failed
            # commit remains unavailable rather than using the previous target.
            catalog = getattr(getattr(service.runtime, "runtime", None), "capabilities", None)
            if catalog:
                catalog.revoke(service.source_id(row["id"]))
            service.sources.pop(row["id"], None)
            await db.commit()
        await service.register_source(row["id"])
    return {"ok": True, "selected_site_id": config.get("site_id"),
            "selected_drive_id": config.get("drive_id")}


async def select_site(service, context, connection_id, payload):
    _payload(payload, kind="sites", selection=True)
    row, source, items, _ = await _read(service, context, connection_id, "sites", payload)
    if payload["site_id"] not in {item["id"] for item in items}:
        raise PermissionError("This site was not granted in the selected provider page")
    # Switching sites deliberately clears the old drive and download host.
    return await _store(service, context, row, source, {"site_id": payload["site_id"]})


async def select_drive(service, context, connection_id, payload):
    _payload(payload, kind="drives", selection=True)
    row, source, items, _ = await _read(service, context, connection_id, "drives", payload)
    chosen = next((item for item in items if item["id"] == payload["drive_id"]), None)
    if chosen is None:
        raise PermissionError("This drive was not granted in the selected provider page")
    config = {"drive_id": chosen["id"]}
    if row["provider"] == "sharepoint":
        site = json.loads(row["config"])["site_id"]
        host = _site_host(site)
        if not host or chosen.get("sharepoint_host", host) != host:
            raise RuntimeError("Provider drive does not match the selected site")
        config["site_id"] = site
    elif chosen.get("sharepoint_host"):
        config["download_host"] = chosen["sharepoint_host"]
    return await _store(service, context, row, source, config)
