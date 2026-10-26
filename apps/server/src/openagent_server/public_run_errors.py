"""Render only the runtime's allowlisted AI failure category, never diagnostics."""
from collections.abc import Mapping
from openagent_core.core.public_errors import PUBLIC_MESSAGES, RunTurnError


def public_run_error(record):
    output = record.output if isinstance(record.output, Mapping) else {}
    code = output.get('error_code', 'generic')
    if record.status == 'timed_out':
        code = 'timeout'
    if code not in PUBLIC_MESSAGES:
        code = 'generic'
    return RunTurnError(PUBLIC_MESSAGES[code], code=code)


def public_run_response(record):
    return str(public_run_error(record)) if record.status != 'success' else (record.output or '')
