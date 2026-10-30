import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { mcpAppsTransport, validatedMcpAppView, type McpAppSurfaceProps, type McpAppView } from '../services/mcp-apps';

/** Embeds only a trusted host page. The source's HTML stays inside that host's isolated sandbox. */
export default function McpAppSurface({ request, scopeKey = '', title = 'Interactive tool' }: McpAppSurfaceProps) {
  const key = JSON.stringify([request.sessionId, request.toolRef, request.toolCallId, request.agentId, request.workspaceId, request.accountId, scopeKey]);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const [state, setState] = useState<{ key: string; phase: 'loading' | 'ready' | 'error'; view?: McpAppView; close?: () => void; error?: string } | null>(null);
  useEffect(() => {
    if (openedKey !== key) return;
    const selected = mcpAppsTransport();
    if (!selected) { setState({ key, phase: 'error', error: 'Interactive views are unavailable on this connection.' }); return; }
    let current = true, timedOut = false, view: McpAppView | undefined;
    setState({ key, phase: 'loading' });
    const close = (id: string) => { void Promise.resolve().then(() => selected.transport.close(id)).catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; if (current) setState({ key, phase: 'error', error: 'The interactive view did not open. Try again.' }); }, 30_000);
    void Promise.resolve().then(() => selected.transport.open(request)).then(value => {
      let validated: McpAppView;
      try { validated = validatedMcpAppView(value, selected.trustedOrigin); }
      catch (cause) { if (value && typeof value.viewId === 'string') close(value.viewId); throw cause; }
      if (!current || timedOut) { close(validated.viewId); return; }
      clearTimeout(timer); view = validated; setState({ key, phase: 'ready', view, close: () => close(validated.viewId) });
    }).catch(() => { clearTimeout(timer); if (current) setState({ key, phase: 'error', error: 'This interactive view is unavailable. Check the connection and access.' }); });
    return () => { current = false; clearTimeout(timer); if (view) close(view.viewId); };
    // Request members are part of key; retaining the captured request prevents a
    // late IPC response from attaching to another session/account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, openedKey]);
  useEffect(() => {
    if (state?.key !== key || !state.view) return;
    const view = state.view;
    const receive = (event: MessageEvent) => {
      const frame = document.getElementById(`mcp-app-${view.viewId}`) as HTMLIFrameElement | null;
      if (event.source !== frame?.contentWindow || event.origin !== new URL(view.url).origin || event.data?.type !== 'openagent-mcp-app-status' || event.data.viewId !== view.viewId || !['revoked', 'closed', 'error'].includes(event.data.status)) return;
      state.close?.();
      setState({ key, phase: 'error', error: 'This interactive view has closed or access has changed.' });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [key, state]);
  const visible = openedKey === key && state?.key === key;
  return <View style={{ marginTop: 8, gap: 8 }} testID="mcp-app-surface">
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={openedKey === key ? 'Close interactive view' : 'Open interactive view'} onPress={(event) => { event.stopPropagation(); setOpenedKey(openedKey === key ? null : key); }} style={{ paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: '#8b9d9a', borderRadius: 8 }}><Text>{openedKey === key ? 'Close interactive view' : 'Open interactive view'}</Text></Pressable>
      {visible && state.phase === 'loading' ? <ActivityIndicator accessibilityLabel="Opening interactive view" /> : null}
    </View>
    {visible && state.phase === 'error' ? <Text accessibilityRole="alert">{state.error}</Text> : null}
    {visible && state.phase === 'ready' && state.view ? <iframe id={`mcp-app-${state.view.viewId}`} title={title} src={state.view.url} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" style={{ width: '100%', height: 400, border: 0, borderRadius: 8, background: 'transparent' }} /> : null}
  </View>;
}
