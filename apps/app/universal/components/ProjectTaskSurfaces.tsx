import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { projectSurface, type ProjectSurfaceStatus, type ProjectTerminalFrame, type ProjectPreviewFrame } from '../services/api';
import { colors } from '../theme';
import Button from './Button';
import Input from './Input';
import ProjectPreview from './ProjectPreview';

export default function ProjectTaskSurfaces({ id }: { id: string }) {
  const [scope, setScope] = useState<ProjectSurfaceStatus | null>(null);
  const [term, setTerm] = useState('');
  const [output, setOutput] = useState('');
  const [line, setLine] = useState('');
  const [preview, setPreview] = useState<ProjectPreviewFrame | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const cursor = useRef(0);
  const life = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const inputRequest = useRef<{text:string; id:string} | null>(null);
  const epochKey = useRef('');
  useEffect(() => {
    const abort = new AbortController();
    life.current = abort;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const value = await projectSurface<ProjectSurfaceStatus>(id, 'status', {}, abort.signal);
        if (abort.signal.aborted) return;
        const key = [value.epoch, value.generation, value.terminal?.read, value.terminal?.input, value.preview].join('/');
        if (key !== epochKey.current) {
          epochKey.current = key; setTerm(''); setOutput(''); setPreview(null); setLine(''); cursor.current = 0;
          inputRequest.current = null;
        }
        setScope(value);
      } catch {
        if (abort.signal.aborted) return;
        epochKey.current = ''; setScope(null); setTerm(''); setOutput(''); setPreview(null); setLine(''); cursor.current = 0;
      }
      if (!abort.signal.aborted) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [id]);
  const epoch = scope?.epoch, generation = scope?.generation;
  useEffect(() => {
    if (!term || epoch === undefined || generation === undefined) return;
    const abort = new AbortController();
    const stamp = epochKey.current;
    const decoder = typeof TextDecoder === 'undefined' ? null : new TextDecoder();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const value = await projectSurface<ProjectTerminalFrame>(id, 'read',
          { epoch, generation, terminal_id: term, cursor: cursor.current }, abort.signal);
        if (abort.signal.aborted || stamp !== epochKey.current) return;
        if (value.terminal_id !== term || !Number.isSafeInteger(value.next_cursor) || value.next_cursor < cursor.current) {
          throw new Error('Terminal changed');
        }
        if (!Number.isSafeInteger(value.offset) || (!value.truncated && value.offset !== cursor.current)) throw new Error('Terminal cursor changed');
        let chunk = value.output;
        if (decoder && value.output_base64 !== undefined && typeof atob === 'function') {
          if (value.truncated) decoder.decode();
          const bytes = Uint8Array.from(atob(value.output_base64), char => char.charCodeAt(0));
          chunk = decoder.decode(bytes, {stream: value.status === 'running'});
        }
        cursor.current = value.next_cursor;
        setOutput(prior => ((value.truncated ? '[Earlier output expired]\n' : prior) + chunk).slice(-65536));
        if (value.status !== 'running') return;
        timer = setTimeout(read, 900);
      } catch (e) {
        if (abort.signal.aborted) return;
        setTerm(''); setOutput(''); setError(e instanceof Error ? e.message : 'Terminal unavailable');
      }
    }
    void read();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [id, term, epoch, generation]);
  async function act(op: 'open'|'input'|'preview') {
    const signal = life.current?.signal;
    if (!scope || !signal || signal.aborted || busy.current) return;
    const stamp = epochKey.current;
    const versions = {epoch:scope.epoch, generation:scope.generation};
    busy.current = true; setSending(true); setError('');
    const current = () => !signal.aborted && stamp === epochKey.current;
    try {
      if (op === 'open') {
        const value = await projectSurface<ProjectTerminalFrame>(id, op, versions, signal);
        if (current()) { cursor.current = 0; setOutput(''); setTerm(value.terminal_id); }
      } else if (op === 'input') {
        const text = line + '\n';
        if (inputRequest.current?.text !== text) inputRequest.current = {text, id:randomUUID()};
        await projectSurface(id, op, {...versions, terminal_id:term, text, request_id:inputRequest.current.id}, signal);
        if (current()) { setLine(''); inputRequest.current = null; }
      } else {
        const value = await projectSurface<ProjectPreviewFrame>(id, op, versions, signal);
        if (current() && ['image/png','text/html'].includes(value.mime)) setPreview(value);
      }
    } catch (e) {
      if (current()) { setError(e instanceof Error ? e.message : 'Task surface unavailable'); setPreview(null); }
    } finally { busy.current = false; if (!signal.aborted) setSending(false); }
  }
  if (!scope || (!scope.terminal?.read && !scope.preview)) return null;
  return <View style={{gap:10}}>
    <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
      {scope.terminal?.read && <Button label={term ? 'Close terminal' : 'Open terminal'} icon="terminal" variant="secondary" disabled={sending}
        onPress={() => { if (term) { setTerm(''); setOutput(''); } else void act('open'); }} />}
      {scope.preview && <Button label="Open preview" icon="eye" variant="secondary" disabled={sending} onPress={() => act('preview')} />}
    </View>
    {term && <View style={{gap:8}}>
      <Text selectable style={{fontFamily:'monospace',color:colors.text}}>{output || 'Waiting for terminal output…'}</Text>
      {scope.terminal.input && <><Input label="Terminal input" accessibilityLabel="Terminal input" value={line} onChangeText={setLine} />
        <Button label="Send to terminal" variant="secondary" disabled={sending || !line} onPress={() => act('input')} /></>}
    </View>}
    {preview && <ProjectPreview frame={preview} />}
    {error.length > 0 && <Text accessibilityRole="alert" style={{color:colors.error}}>{error}</Text>}
  </View>;
}
