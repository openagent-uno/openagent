function browserPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser_inventory_unavailable");
  const wire = value;
  if (wire.isError === true || wire.is_error === true) throw new Error("browser_inventory_unavailable");
  if (wire.structuredContent && typeof wire.structuredContent === "object") return wire.structuredContent;
  if (Array.isArray(wire.content)) {
    for (const item of wire.content) if (item?.type === "text" && typeof item.text === "string") {
      try {
        const result = JSON.parse(item.text);
        if (result && typeof result === "object" && !Array.isArray(result)) return result;
      } catch {
      }
    }
  }
  return wire;
}
function resolveBrowserDecision(value, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_browser_decision");
  const raw = input;
  if (Object.keys(raw).some((key) => !["requestId", "action"].includes(key)) || typeof raw.requestId !== "string" || !raw.requestId || raw.requestId.length > 200 || typeof raw.action !== "string" || !["resume", "grant", "revoke"].includes(raw.action)) throw new Error("invalid_browser_decision");
  const inventory = browserPayload(value);
  const requests = inventory.pending_decisions;
  if (!Array.isArray(requests)) throw new Error("browser_inventory_unavailable");
  const matches = requests.filter((item) => item && item.request_id === raw.requestId);
  if (matches.length !== 1) throw new Error("browser_decision_expired");
  const request = matches[0];
  if (typeof request.browser_id !== "string" || !request.browser_id || !Number.isSafeInteger(request.tab_id) || request.tab_id < 1 || !Number.isSafeInteger(request.expires_at_ms) || request.expires_at_ms <= Date.now() || (raw.action === "resume" ? request.action !== "resume" : request.action !== "permission")) throw new Error("browser_decision_expired");
  if (request.action === "permission" && (typeof request.origin !== "string" || !Array.isArray(request.permissions) || !request.permissions.length || request.permissions.some((item) => typeof item !== "string"))) throw new Error("browser_inventory_unavailable");
  const args = { action: raw.action, browser_id: request.browser_id, tabId: request.tab_id, request_id: request.request_id };
  if (request.action === "permission") {
    args.origin = request.origin;
    args.permissions = [...request.permissions];
  }
  return {
    tool: raw.action === "resume" ? "browser_control" : "browser_permissions",
    args,
    detail: `Browser: ${request.browser_id}
Tab: ${request.tab_id}
` + (raw.action === "resume" ? "Return browser control to the agent after your manual step." : `Origin: ${request.origin}
Permissions: ${request.permissions.join(", ")}
Decision: ${raw.action}`)
  };
}
async function performBrowserDecision(inventory, dispatch, input, confirm) {
  const before = resolveBrowserDecision(await inventory(), input);
  if (!await confirm(before.detail)) return { cancelled: true };
  const after = resolveBrowserDecision(await inventory(), input);
  if (JSON.stringify(before.args) !== JSON.stringify(after.args)) throw new Error("browser_decision_changed");
  const result = await dispatch(after);
  if (result && typeof result === "object" && (result.isError === true || result.is_error === true)) throw new Error("browser_decision_failed");
  return result;
}
export {
  browserPayload,
  performBrowserDecision,
  resolveBrowserDecision
};
