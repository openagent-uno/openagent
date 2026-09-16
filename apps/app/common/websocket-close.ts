/** Stable private close contract shared by OpenAgent's gateway clients.
 *
 * The server uses this only when a new WebSocket presents the same device
 * identity as an existing one.  The old socket must stay closed; reconnecting
 * it would replace the new socket and make the pair alternate forever.
 *
 * Keep these values in sync with ``src/gateway/protocol.py`` in
 * openagent-server.  Either field is sufficient because intermediary
 * transports can occasionally preserve only one of them.
 */
export const WS_CLOSE_CONNECTION_REPLACED_CODE = 4009;
export const WS_CLOSE_CONNECTION_REPLACED_REASON = 'connection_replaced';

export function isConnectionReplacedClose(code: number, reason?: string): boolean {
  return code === WS_CLOSE_CONNECTION_REPLACED_CODE
    || reason === WS_CLOSE_CONNECTION_REPLACED_REASON;
}
