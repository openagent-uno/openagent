/**
 * One skill — read it, edit it, retire it.
 *
 * The body shown here is SKILL.md with the frontmatter stripped: exactly
 * what the agent loads when it reaches for the skill. The frontmatter is
 * generated from the description/category fields, so it is never edited by
 * hand and never shown as raw YAML.
 *
 * Retiring offers **archive** first and delete second, in that order and
 * with that emphasis, because archive is reversible: the file stays on disk
 * and only drops out of the prompt index. Delete removes the folder.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { colors, font, radius } from '../../../theme';
import Card from '../../../components/Card';
import Button from '../../../components/Button';
import Input from '../../../components/Input';
import { Skeleton } from '../../../components/Skeleton';
import Notice from '../../../components/Notice';
import { useConfirm } from '../../../components/ConfirmDialog';
import { useHeaderInset } from '../../../components/screenHeader';
import Markdown from '../../../components/Markdown';
import { getSkill, updateSkill, archiveSkill, deleteSkill } from '../../../services/api';
import type { SkillDetail } from '../../../../common/types';

export default function SkillScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const confirm = useConfirm();
  // The stack header is translucent, so content must start below it or
  // the first row renders underneath and reads as clipped.
  const headerInset = useHeaderInset();

  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ description: '', category: '', body: '' });

  const load = useCallback(async () => {
    if (!name) return;
    try {
      const s = await getSkill(name);
      setSkill(s);
      setDraft({ description: s.description, category: s.category, body: s.body });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [name]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (skill) navigation.setOptions({ title: skill.name });
  }, [navigation, skill]);

  const save = useCallback(async () => {
    if (!name) return;
    setSaving(true);
    try {
      const r = await updateSkill(name, {
        description: draft.description.trim(),
        category: draft.category.trim() || undefined,
        body: draft.body,
      });
      setEditing(false);
      setNotice(r.index_refreshed === false
        ? 'Saved to disk. The agent reads the new version on its next reload — the skills index in its prompt is a cached snapshot.'
        : 'Saved.');
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [name, draft, load]);

  const archive = useCallback(async () => {
    if (!name) return;
    const ok = await confirm({
      title: 'Archive this skill',
      message: 'The file stays on disk and the change is reversible — the skill just stops appearing in the agent’s prompt index.',
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    try {
      await archiveSkill(name);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [name, confirm, router]);

  const remove = useCallback(async () => {
    if (!name) return;
    const ok = await confirm({
      title: 'Delete this skill',
      message: `Remove the folder for "${name}" from disk. This cannot be undone — archiving retires it reversibly instead.`,
      confirmLabel: 'Delete',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    try {
      await deleteSkill(name);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [name, confirm, router]);

  if (!skill) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: headerInset + 16 }]}>
        {error ? <Notice>{error}</Notice> : <Card><Skeleton height={120} /></Card>}
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: headerInset + 16 }]}>
      {error && <Notice>{error}</Notice>}
      {notice && <Notice tone="info">{notice}</Notice>}

      {editing ? (
        <Card style={styles.card}>
          <Input
            label="Description"
            hint="One line. This is what the agent sees in its prompt index."
            value={draft.description}
            onChangeText={(v: string) => setDraft({ ...draft, description: v })}
          />
          <Input
            label="Category"
            value={draft.category}
            onChangeText={(v: string) => setDraft({ ...draft, category: v })}
          />
          <Input
            label="Body"
            hint="Markdown. The frontmatter is generated — do not write a --- block."
            value={draft.body}
            onChangeText={(v: string) => setDraft({ ...draft, body: v })}
            multiline
            rows={16}
            mono
          />
          <View style={styles.actions}>
            <Button
              label="Cancel"
              variant="ghost"
              size="sm"
              onPress={() => {
                setDraft({ description: skill.description, category: skill.category, body: skill.body });
                setEditing(false);
              }}
            />
            <Button
              label={saving ? 'Saving…' : 'Save'}
              size="sm"
              disabled={saving}
              onPress={() => { void save(); }}
            />
          </View>
        </Card>
      ) : (
        <>
          <Card style={styles.card}>
            <Text style={styles.description}>{skill.description || 'No description.'}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.meta}>{skill.category || 'general'}</Text>
              <Text style={styles.metaPath} numberOfLines={1}>{skill.path}</Text>
            </View>
            <View style={styles.actions}>
              <Button label="Edit" icon="edit-2" size="sm" variant="secondary" onPress={() => setEditing(true)} />
              <Button label="Archive" icon="archive" size="sm" variant="ghost" onPress={() => { void archive(); }} />
              <Button label="Delete" icon="trash-2" size="sm" variant="danger" onPress={() => { void remove(); }} />
            </View>
          </Card>

          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>Instructions</Text>
            <Markdown text={skill.body} />
          </Card>

          {skill.bundled_files.length > 0 && (
            <Card style={styles.card}>
              <Text style={styles.sectionTitle}>Bundled files</Text>
              <Text style={styles.body}>
                Files that live alongside SKILL.md. The agent reads them when
                the skill tells it to.
              </Text>
              {skill.bundled_files.map((f) => (
                <View key={f} style={styles.fileRow}>
                  <Feather name="file" size={12} color={colors.textMuted} />
                  <Text style={styles.fileName}>{f}</Text>
                </View>
              ))}
            </Card>
          )}
        </>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },

  errorBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.errorSoft,
    borderWidth: 1, borderColor: colors.errorBorder,
  },
  errorText: { flex: 1, fontSize: 12, color: colors.error },
  noticeBar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  noticeText: { flex: 1, fontSize: 11, color: colors.textSecondary, lineHeight: 16 },

  card: { gap: 10 },
  description: { fontSize: 13, color: colors.text, lineHeight: 19 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  meta: {
    fontSize: 10, color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  metaPath: { flex: 1, fontSize: 10, color: colors.textMuted, fontFamily: font.mono },
  sectionTitle: {
    fontSize: 11, color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  body: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  fileName: { fontSize: 12, color: colors.textSecondary, fontFamily: font.mono },
});
