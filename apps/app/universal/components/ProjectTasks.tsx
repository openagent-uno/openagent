import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import {
  attachProjectComputer, currentAgentScope, getProjectDiff, getProjectTask, listProjectDesktops, listTaskProjects,
  projectViewerInteraction, recoverProjectTask, submitProjectTask, suspendProjectComputer,
  type ProjectCheckpoint, type ProjectDesktop, type ProjectDesktopTargets,
  type ProjectTaskDetail, type ProjectTaskSummary, type TaskProject,
} from '../services/api';
import { useConnection } from '../stores/connection';
import { colors } from '../theme';
import Button from './Button';
import Input from './Input';
import ComputerView from './ComputerView';
import ProjectTaskSurfaces from './ProjectTaskSurfaces';

export function useProjectSource() {
  const account = useConnection(s => s.activeAccountId);
  const config = useConnection(s => s.config);
  return JSON.stringify([account, config?.network, config?.handle, config?.agentHandle, config?.sidecarPort, currentAgentScope()]);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Project task unavailable';
}

export function ProjectList() {
  const router = useRouter();
  const [projects, setProjects] = useState<TaskProject[]>([]);
  const [tasks, setTasks] = useState<ProjectTaskSummary[]>([]);
  const [project, setProject] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const [revision, setRevision] = useState('');
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const pending = useRef<{ draft: string; key: string } | null>(null);
  const life = useRef<AbortController | null>(null);
  const selected = projects.find(p => p.id === project);
  const loadedMore = useRef(false);
  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    life.current = controller;
    setLoading(true); setTasks([]); setCursor(null); setPaging(false);
    loadedMore.current = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await listTaskProjects(controller.signal, undefined, project);
        if (controller.signal.aborted) return;
        setError(''); setProjects(data.projects);
        setProject(old => data.projects.some(p => p.id === old) ? old : data.projects[0]?.id ?? '');
        if (loadedMore.current) {
          const allowed = new Set(data.projects.flatMap(p => p.revisions.map(r => JSON.stringify([p.id, r.commit]))));
          setTasks(prior => [...new Map([...data.tasks, ...prior]
            .filter(t => allowed.has(JSON.stringify([t.project, t.revision]))).map(t => [t.id, t])).values()]);
        } else {
          setTasks(data.tasks); setCursor(data.next_cursor);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setProjects([]); setTasks([]); setCursor(null); setError(message(e));
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(refresh, 8000); }
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [project]));
  useEffect(() => {
    setRevision(old => selected?.revisions.some(r => r.commit === old) ? old : selected?.revisions[0]?.commit ?? '');
  }, [selected]);

  async function more() {
    const signal = life.current?.signal;
    if (!cursor || paging || !signal || signal.aborted) return;
    setPaging(true);
    try {
      const page = await listTaskProjects(signal, cursor, project);
      if (!signal.aborted) {
        loadedMore.current = true;
        const allowed = new Set(page.projects.flatMap(p => p.revisions.map(r => JSON.stringify([p.id, r.commit]))));
        setProjects(page.projects);
        setTasks(prior => [...new Map([...prior, ...page.tasks].filter(t => allowed.has(JSON.stringify([t.project, t.revision]))).map(t => [t.id, t])).values()]);
        setCursor(page.next_cursor);
      }
    } catch (e) { if (!signal.aborted) setError(message(e)); }
    finally { if (!signal.aborted) setPaging(false); }
  }

  async function start() {
    const signal = life.current?.signal;
    if (submitting.current || !signal || signal.aborted || !instruction.trim() || !revision) return;
    submitting.current = true; setSending(true); setError('');
    try {
      const draft = JSON.stringify([project, revision, instruction]);
      if (pending.current?.draft !== draft) pending.current = {draft, key: randomUUID()};
      const accepted = await submitProjectTask({ request_id: pending.current.key, project, revision, instruction }, signal);
      if (signal.aborted) return;
      pending.current = null; setInstruction('');
      router.push({ pathname: '/projects/[id]', params: { id: accepted.id } });
    } catch (e) {
      if (!signal.aborted) setError(message(e));
    } finally {
      submitting.current = false;
      if (!signal.aborted) setSending(false);
    }
  }

  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    {loading && <Text style={styles.muted}>Loading projects…</Text>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!loading && !error && !projects.length && <Text style={styles.muted}>No projects are available for this account.</Text>}
    {projects.length > 0 && <>
      <Text style={styles.heading}>Project</Text>
      <View style={styles.buttons}>{projects.map(p =>
        <Button key={p.id} label={p.title} variant={p.id === project ? 'primary' : 'secondary'} onPress={() => setProject(p.id)} />)}</View>
      <Text style={styles.heading}>Base revision</Text>
      <View style={styles.buttons}>{selected?.revisions.map(r =>
        <Button key={r.commit} label={r.label + ' · ' + r.commit.slice(0, 8)} variant={r.commit === revision ? 'primary' : 'secondary'} onPress={() => setRevision(r.commit)} />)}</View>
      <Input label="Task" placeholder="What should the agent do in this project?" multiline rows={4}
        value={instruction} onChangeText={setInstruction} editable={!sending} accessibilityLabel="Task instruction" />
      <View style={styles.buttons}><Button label={sending ? 'Submitting…' : 'Start task'} icon="play"
        disabled={sending || !instruction.trim() || !revision} onPress={start} /></View>
      <Text style={styles.heading}>Project tasks</Text>
      {tasks.filter(t => t.project === project).length === 0 && <Text style={styles.muted}>No tasks yet.</Text>}
      {tasks.filter(t => t.project === project).map(t => <View key={t.id} style={styles.row}>
        <Text style={styles.body} numberOfLines={2}>{t.instruction}</Text>
        <Button label={'Open task · ' + t.revision.slice(0, 8)} size="sm" variant="secondary"
          onPress={() => router.push({ pathname: '/projects/[id]', params: { id: t.id } })} />
      </View>)}
      {cursor && <Button label="Load more tasks" variant="secondary" disabled={paging} onPress={more} />}
    </>}
  </ScrollView>;
}

export function ProjectDetail({ id }: { id: string }) {
  const [record, setRecord] = useState<ProjectTaskDetail | null>(null);
  const [checkpoint, setCheckpoint] = useState<ProjectCheckpoint | null>(null);
  const [desktops, setDesktops] = useState<ProjectDesktopTargets | null>(null);
  const [display, setDisplay] = useState<ProjectDesktop | null>(null);
  const currentLease = useRef('');
  const [error, setError] = useState('');
  const life = useRef<AbortController | null>(null);
  useFocusEffect(useCallback(() => {
    const abort = new AbortController();
    const signal = abort.signal; life.current = abort;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await getProjectTask(id, signal);
        if (signal.aborted) return;
        setRecord(next); setError('');
        const stamp = next.lease ? next.lease.epoch + '/' + next.lease.generation : '';
        if (!stamp || stamp !== currentLease.current) { setDisplay(null); setDesktops(null); }
        currentLease.current = stamp;
      } catch (e) {
        if (signal.aborted) return;
        setRecord(null); setCheckpoint(null); setDisplay(null); setDesktops(null); setError(message(e));
      }
      if (!signal.aborted) timer = setTimeout(load, 3000);
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [id]));
  async function readDiff() {
    const signal = life.current?.signal;
    if (!signal || signal.aborted) return;
    try { const next = await getProjectDiff(id, signal); if (!signal.aborted) setCheckpoint(next); }
    catch (e) { if (!signal.aborted) { setCheckpoint(null); setError(message(e)); } }
  }
  async function recover(op: 'retry' | 'checkpoint') {
    const signal = life.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      await recoverProjectTask(id, op, signal);
      const next = await getProjectTask(id, signal);
      if (!signal.aborted) setRecord(next);
    } catch (e) { if (!signal.aborted) setError(message(e)); }
  }
  async function suspendComputer() {
    const signal = life.current?.signal;
    if (!record?.suspend || !signal || signal.aborted) return;
    try {
      await suspendProjectComputer(id, record.suspend, signal);
      const next = await getProjectTask(id, signal);
      if (!signal.aborted) { setDisplay(null); setDesktops(null); setRecord(next); }
    } catch (e) { if (!signal.aborted) setError(message(e)); }
  }

  async function openComputer() {
    const signal = life.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      if (!record?.computer) await attachProjectComputer(id, signal);
      const next = await listProjectDesktops(id, signal);
      if (signal.aborted) return;
      currentLease.current = next.epoch + '/' + next.generation;
      setDesktops(next); setDisplay(next.targets.length === 1 ? next.targets[0] : null);
    } catch (e) { if (!signal.aborted) { setDisplay(null); setDesktops(null); setError(message(e)); } }
  }
  const interact = useMemo(() => desktops ? projectViewerInteraction(id, desktops.epoch, desktops.generation) : undefined, [id, desktops]);
  return <ScrollView contentContainerStyle={styles.page}>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!record && !error && <Text style={styles.muted}>Loading task…</Text>}
    {record && <>
      <Text selectable style={styles.heading}>{record.instruction}</Text>
      <Text selectable style={styles.muted}>{record.project + ' · ' + record.revision}</Text>
      <Text accessibilityLiveRegion="polite" style={styles.body}>{'Status · ' + record.status}</Text>
      {record.result && <View style={styles.row}><Text style={styles.heading}>Result</Text><Text selectable style={styles.body}>{record.result}</Text></View>}
      <View style={styles.buttons}>
        {record.can_retry && <Button label="Resume preparation" onPress={() => recover('retry')} />}
        {record.can_checkpoint && <Button label="Save changes for review" onPress={() => recover('checkpoint')} />}
        {record.suspend && <Button label="Suspend computer" variant="secondary" onPress={suspendComputer} />}
        {record.review && <Button label="Review changes" icon="git-pull-request" variant="secondary" onPress={readDiff} />}
        {!['accepted','preparing'].includes(record.status) && <Button label={record.computer ? 'Open computer' : 'Reconnect computer'} icon="monitor" variant="secondary" onPress={openComputer} />}
      </View>
      {record.computer && <ProjectTaskSurfaces id={id} />}
      {desktops?.targets.length === 0 && <Text style={styles.muted}>This computer has no desktop available.</Text>}
      {desktops && desktops.targets.length > 1 && <View style={styles.buttons}>{desktops.targets.map(t =>
        <Button key={t.target_id} label={t.label} onPress={() => setDisplay(t)} />)}</View>}
      {checkpoint && <View style={styles.row}>
        <Text style={styles.heading}>Changes</Text>
        <Text selectable style={styles.muted}>{checkpoint.receipt.base_commit.slice(0, 12) + ' → ' + checkpoint.receipt.tree.slice(0, 12)}</Text>
        <Text selectable style={styles.diff}>{checkpoint.diff || 'No changes in the working tree.'}</Text>
        {checkpoint.truncated && <Text style={styles.muted}>Showing the first 128 KiB.</Text>}
      </View>}
    </>}
    {display && interact && <ComputerView key={id + display.target_id + desktops?.epoch} sessionId={'project-task-' + id}
      interact={interact} target={{tool_ref: display.target_id, label: display.label}} onClose={() => setDisplay(null)} />}
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { maxWidth: 850, width: '100%', alignSelf: 'center', padding: 24, gap: 15 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  heading: { fontSize: 18, fontWeight: '600', color: colors.text },
  body: { fontSize: 15, lineHeight: 22, color: colors.text },
  muted: { fontSize: 13, lineHeight: 19, color: colors.textMuted },
  error: { fontSize: 14, color: colors.error },
  row: { gap: 12, alignItems: 'flex-start', paddingVertical: 12 },
  diff: { fontFamily: 'monospace', fontSize: 12, color: colors.text },
});
