/** Main-process decision validation. Renderer supplies only an opaque pending id. */
export function browserPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('browser_inventory_unavailable');
  const wire = value as Record<string, unknown>;
  if (wire.isError === true || wire.is_error === true) throw new Error('browser_inventory_unavailable');
  if (wire.structuredContent && typeof wire.structuredContent === 'object') return wire.structuredContent as Record<string, unknown>;
  if (Array.isArray(wire.content)) {
    for (const item of wire.content) if (item?.type === 'text' && typeof item.text === 'string') {
      try { const result = JSON.parse(item.text); if (result && typeof result === 'object' && !Array.isArray(result)) return result; } catch {}
    }
  }
  return wire;
}
export function resolveBrowserDecision(value: unknown, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_browser_decision');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['requestId','action'].includes(key)) ||
      typeof raw.requestId !== 'string' || !raw.requestId || raw.requestId.length > 200 ||
      typeof raw.action !== 'string' || !['resume','grant','revoke'].includes(raw.action)) throw new Error('invalid_browser_decision');
  const inventory = browserPayload(value);
  const requests = inventory.pending_decisions;
  if (!Array.isArray(requests)) throw new Error('browser_inventory_unavailable');
  const matches = requests.filter(item => item && item.request_id === raw.requestId);
  if (matches.length !== 1) throw new Error('browser_decision_expired');
  const request = matches[0];
  if (typeof request.browser_id !== 'string' || !request.browser_id || !Number.isSafeInteger(request.tab_id) || request.tab_id < 1 ||
      !Number.isSafeInteger(request.expires_at_ms) || request.expires_at_ms <= Date.now() ||
      (raw.action === 'resume' ? request.action !== 'resume' : request.action !== 'permission')) throw new Error('browser_decision_expired');
  if (request.action === 'permission' && (typeof request.origin !== 'string' || !Array.isArray(request.permissions) ||
      !request.permissions.length || request.permissions.some((item:unknown) => typeof item !== 'string'))) throw new Error('browser_inventory_unavailable');
  const args: Record<string, unknown> = { action: raw.action, browser_id: request.browser_id, tabId: request.tab_id, request_id: request.request_id };
  if (request.action === 'permission') { args.origin = request.origin; args.permissions = [...request.permissions]; }
  return { tool: (raw.action === 'resume' ? 'browser_control' : 'browser_permissions') as 'browser_control' | 'browser_permissions', args,
    detail: `Browser: ${request.browser_id}\nTab: ${request.tab_id}\n` + (raw.action === 'resume' ? 'Return browser control to the agent after your manual step.' : `Origin: ${request.origin}\nPermissions: ${request.permissions.join(', ')}\nDecision: ${raw.action}`) };
}

export async function performBrowserDecision(
  inventory:()=>Promise<unknown>, dispatch:(decision:ReturnType<typeof resolveBrowserDecision>)=>Promise<unknown>,
  input:unknown, confirm:(detail:string)=>Promise<boolean>,
):Promise<unknown> {
  const before = resolveBrowserDecision(await inventory(), input);
  if (!await confirm(before.detail)) return { cancelled:true };
  const after = resolveBrowserDecision(await inventory(), input);
  if (JSON.stringify(before.args) !== JSON.stringify(after.args)) throw new Error('browser_decision_changed');
  const result=await dispatch(after);
  if(result && typeof result==='object' && ((result as Record<string,unknown>).isError===true || (result as Record<string,unknown>).is_error===true)) throw new Error('browser_decision_failed');
  return result;
}
