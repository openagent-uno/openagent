"""CLI entrypoint and account management."""

from __future__ import annotations

import argparse
import sys
import time
from typing import List, Optional

from .auth import DEFAULT_ACCOUNT_PRIORITY, TokenManager, login
from .config import settings


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="claude-sub-proxy")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("serve", help="serve the OpenAI-compatible proxy")
    sub.add_parser("run", help=argparse.SUPPRESS)

    login_parser = sub.add_parser("login", aliases=["add"], help="add or refresh an Anthropic account")
    login_parser.add_argument("name", nargs="?", help="account name (default: append account-N)")
    login_parser.add_argument(
        "--priority",
        type=int,
        default=None,
        help=f"lower numbers are tried first (default: {DEFAULT_ACCOUNT_PRIORITY})",
    )

    sub.add_parser("accounts", aliases=["list"], help="list configured accounts")

    delete_parser = sub.add_parser("delete", aliases=["remove", "logout"], help="delete an account")
    delete_parser.add_argument("identifier", help="account name or id")

    priority_parser = sub.add_parser("priority", help="update an account priority")
    priority_parser.add_argument("identifier", help="account name or id")
    priority_parser.add_argument("priority", type=int, help="lower numbers are tried first")

    token_parser = sub.add_parser("token", help="print a currently-valid access token")
    token_parser.add_argument("identifier", nargs="?", help="optional account name or id")

    return parser


def _format_expiry(expires_at_ms: int) -> str:
    if not expires_at_ms:
        return "static/unknown"
    delta_s = int((expires_at_ms - int(time.time() * 1000)) / 1000)
    if delta_s <= 0:
        return "expired"
    if delta_s < 120:
        return f"{delta_s}s"
    if delta_s < 7200:
        return f"{delta_s // 60}m"
    return f"{delta_s // 3600}h"


def _print_accounts(manager: TokenManager) -> None:
    accounts = manager.account_statuses()
    if not accounts:
        print(f"No managed accounts in {settings.creds_file}")
        print("Run `claude-sub-proxy login --priority 10` to append account-1.")
        return
    print(f"{'priority':>8}  {'id':<20}  {'name':<24}  {'status':<16}  {'expires':<14}  refresh")
    for account in accounts:
        if account["limited"]:
            status = f"limited {account.get('limited_for_s', 0)}s"
        else:
            status = "ready"
        refresh = "yes" if account["has_refresh_token"] else "no"
        print(
            f"{account['priority']:>8}  "
            f"{str(account['id'])[:20]:<20}  "
            f"{str(account['name'])[:24]:<24}  "
            f"{status:<16}  "
            f"{_format_expiry(int(account.get('expires_at_ms') or 0)):<14}  "
            f"{refresh}"
        )


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        args = ["serve"]
    parser = _build_parser()
    ns = parser.parse_args(args)
    cmd = ns.cmd or "serve"
    manager = TokenManager(settings.creds_file)

    if cmd in ("login", "add"):
        account = login(settings.creds_file, account_name=ns.name, priority=ns.priority)
        name = account.get("name") or ns.name or "account"
        priority = account.get("priority", DEFAULT_ACCOUNT_PRIORITY)
        print(f"\nAccount {name!r} saved to {settings.creds_file} (priority {priority})")
        return 0

    if cmd in ("accounts", "list"):
        _print_accounts(manager)
        return 0

    if cmd in ("delete", "remove", "logout"):
        try:
            account = manager.delete_account(ns.identifier)
        except KeyError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        print(f"Deleted account {account.get('name')!r} from {settings.creds_file}")
        return 0

    if cmd == "priority":
        try:
            account = manager.set_priority(ns.identifier, ns.priority)
        except KeyError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        print(f"Account {account.get('name')!r} priority set to {account.get('priority')}")
        return 0

    if cmd == "token":
        # Print a currently-valid access token (refreshing if needed).
        if ns.identifier:
            print(manager.get_account_token(ns.identifier))
        else:
            print(manager.get_token())
        return 0

    if cmd in ("serve", "run"):
        import uvicorn

        print(f"claude-sub-proxy serving on http://{settings.host}:{settings.port}/v1")
        print(f"  creds: {settings.creds_file}")
        print("  accounts: lower priority numbers are tried first")
        uvicorn.run(
            "claude_sub_proxy.server:app",
            host=settings.host,
            port=settings.port,
            log_level="info",
        )
        return 0

    parser.print_usage(sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
