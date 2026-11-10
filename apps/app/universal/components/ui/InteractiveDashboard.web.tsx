import { useEffect, useMemo, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { ActivityIndicator, Text } from 'react-native';
import { currentAgentScope, getUIViewBundleAsset } from '../../services/api';
import { colors } from '../../theme';
import type { InteractiveDashboardProps } from './InteractiveDashboard';

const PROTOCOL = 'openagent-dashboard/1';
const CSP = [
  "default-src 'none'", "script-src 'unsafe-inline' blob:", "style-src 'unsafe-inline' blob:",
  "img-src data: blob:", "font-src data: blob:", "media-src data: blob:", "connect-src 'none'",
  "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

function dashboardDocument(source: string, channel: string) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;min-height:100%;color-scheme:light dark}*{box-sizing:border-box}</style>
<script>
(() => {
  const protocol = ${JSON.stringify(PROTOCOL)}, channel = ${JSON.stringify(channel)};
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    Object.defineProperty(window, name, { value: undefined, configurable: false });
  }
  let data = {}, active = false, id = 0;
  const listeners = new Set(), visibilityListeners = new Set(), pending = new Map();
  const request = (command, value) => new Promise((resolve, reject) => {
    if (pending.size >= 8) { reject(Error('Too many dashboard requests')); return; }
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId); reject(Error('Dashboard request timed out'));
    }, 120000);
    pending.set(requestId, { resolve, reject, timer });
    parent.postMessage({ protocol, channel, requestId, command, value }, '*');
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== parent || message?.protocol !== protocol || message.channel !== channel) return;
    if (message.type === 'data') {
      data = message.data;
      for (const listener of listeners) listener(data);
    } else if (message.type === 'visibility') {
      active = message.active === true;
      for (const listener of visibilityListeners) listener(active);
    } else if (message.type === 'reply') {
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId); clearTimeout(request.timer);
      if (message.ok) request.resolve(message.value);
      else request.reject(Error('Dashboard request was denied or failed'));
    }
  });
  Object.defineProperty(window, 'OpenAgent', { value: Object.freeze({
    get data() { return data; },
    get active() { return active; },
    onData(listener) {
      listeners.add(listener); listener(data);
      return () => listeners.delete(listener);
    },
    onVisibility(listener) {
      visibilityListeners.add(listener); listener(active);
      return () => visibilityListeners.delete(listener);
    },
    run(action, input) { return request('run', { action, input }); },
    assetBytes(ref) { return request('asset', { ref }); },
    async asset(ref) {
      const { bytes, mediaType } = await request('asset', { ref });
      return URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    },
    async import(ref) {
      const { bytes } = await request('asset', { ref });
      const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
      try { return await import(url); }
      finally { URL.revokeObjectURL(url); }
    },
  })});
  parent.postMessage({ protocol, channel, type: 'ready' }, '*');
})();
</script>
${source}`;
}

function hasSandbox() {
  return typeof window !== 'undefined'
    && (window as Window & { desktop?: { supportsDashboardSandbox?: boolean } }).desktop?.supportsDashboardSandbox === true;
}

export default function InteractiveDashboard(props: InteractiveDashboardProps) {
  const enabled = hasSandbox();
  const focused = useIsFocused();
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ ...props, focused });
  latest.current = { ...props, focused };
  const scope = currentAgentScope();
  const channel = useMemo(() => enabled ? crypto.randomUUID() : '', [enabled, scope, props.viewId, props.revision, props.source]);
  const [loaded, setLoaded] = useState<{ channel: string; document?: string }>({ channel: '' });
  const ready = useRef('');
  const installed = useRef('');

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void getUIViewBundleAsset(props.viewId, props.revision, props.source, controller.signal)
      .then(({ bytes }) => {
        if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('Dashboard document is too large');
        if (!controller.signal.aborted && currentAgentScope() === scope) {
          setLoaded({ channel, document: dashboardDocument(new TextDecoder().decode(bytes), channel) });
        }
      }).catch(() => { if (!controller.signal.aborted) setLoaded({ channel }); });
    return () => controller.abort();
  }, [channel, enabled, scope, props.viewId, props.revision, props.source]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pending = 0;
    const receive = async (event: MessageEvent) => {
      const source = frame.current?.contentWindow;
      const message = event.data;
      if (!source || event.source !== source || event.origin !== 'null'
          || message?.protocol !== PROTOCOL || message.channel !== channel || currentAgentScope() !== scope) return;
      if (message.type === 'ready') {
        ready.current = channel;
        source.postMessage({ protocol: PROTOCOL, channel, type: 'data', data: latest.current.data }, '*');
        source.postMessage({ protocol: PROTOCOL, channel, type: 'visibility', active: latest.current.focused }, '*');
        return;
      }
      if (!Number.isSafeInteger(message.requestId) || pending >= 8) return;
      const requestId = message.requestId;
      const reply = (ok: boolean, value?: unknown, transfer: Transferable[] = []) => {
        if (!controller.signal.aborted && currentAgentScope() === scope && frame.current?.contentWindow === source) {
          source.postMessage({ protocol: PROTOCOL, channel, type: 'reply', requestId, ok, value }, '*', transfer);
        }
      };
      pending++;
      try {
        const current = latest.current;
        if (message.command === 'asset' && current.assets.includes(message.value?.ref)) {
          const asset = await getUIViewBundleAsset(current.viewId, current.revision, message.value.ref, controller.signal);
          reply(true, asset, [asset.bytes]);
        } else if (message.command === 'run' && current.focused && current.canRun && typeof message.value?.action === 'string'
            && JSON.stringify(message.value).length <= 65_536) {
          const result = await current.run(message.value.action, message.value.input);
          reply(result !== false);
        } else {
          reply(false);
        }
      } catch { reply(false); }
      finally { pending--; }
    };
    window.addEventListener('message', receive);
    return () => { controller.abort(); window.removeEventListener('message', receive); };
  }, [channel, enabled, scope]);

  const sendData = () => {
    if (ready.current !== channel || currentAgentScope() !== scope) return;
    frame.current?.contentWindow?.postMessage({ protocol: PROTOCOL, channel, type: 'data', data: latest.current.data }, '*');
  };
  useEffect(sendData, [channel, props.data, scope]);
  useEffect(() => {
    if (ready.current === channel && currentAgentScope() === scope) {
      frame.current?.contentWindow?.postMessage({ protocol: PROTOCOL, channel, type: 'visibility', active: focused }, '*');
    }
  }, [channel, focused, scope]);

  if (!enabled) return <Text style={{ color: colors.textMuted }}>Open this interactive dashboard in the desktop app.</Text>;
  if (loaded.channel !== channel) return <ActivityIndicator color={colors.accent} />;
  if (!loaded.document) return <Text accessibilityRole="alert" style={{ color: colors.error }}>Dashboard content is unavailable.</Text>;
  const height = Math.max(200, Math.min(1200, Number.isFinite(props.height) ? props.height! : 480));
  return <iframe
    key={channel}
    ref={frame}
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
    src={`/dashboard-frame.html#${channel}`}
    onLoad={() => {
      if (installed.current === channel || currentAgentScope() !== scope) return;
      installed.current = channel;
      frame.current?.contentWindow?.postMessage({ protocol: PROTOCOL, channel, type: 'document', document: loaded.document }, '*');
    }}
    title={props.title}
    style={{ width: '100%', height, border: 0, display: 'block' }}
  />;
}
