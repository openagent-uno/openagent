/**
 * Skills — the agent's skill library.
 *
 * One folder per skill on disk, a SKILL.md inside it. The framework prompt
 * carries only the index (category → `name: description`); the body is read
 * on demand. This screen is the human half of that: read what the agent has
 * learned, write a skill by hand, retire one that has gone stale.
 *
 * Grouped by category because that is how the prompt index is grouped — the
 * shape the agent sees is the shape the user should see.
 *
 * Two labels are load-bearing, not decoration. **Agent** marks a skill the
 * agent wrote itself, which is the only kind its curator may consolidate.
 * **Archived** marks one retired without deletion: still on disk, gone from
 * the prompt.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { colors, font, radius } from '../../../theme';
import { useHeaderInset } from '../../../components/screenHeader';
import Card from '../../../components/Card';
import Button from '../../../components/Button';
import Input from '../../../components/Input';
import EmptyState from '../../../components/EmptyState';
import ThemedSwitch from '../../../components/ThemedSwitch';
import { Skeleton } from '../../../components/Skeleton';
import Notice from '../../../components/Notice';
import { listSkills, createSkill, isUnsupportedByAgent } from '../../../services/api';
import type { SkillSummary } from '../../../../common/types';

export default function SkillsScreen() {
  const router = useRouter();
  const headerInset = useHeaderInset();
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  // Separates "still loading" from "the fetch failed": without it a
  // failure is indistinguishable from a slow first paint.
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', category: '', body: '' });

  const load = useCallback(async () => {
    try {
      setSkills(await listSkills(includeArchived));
      setError(null);
      setFailed(false);
    } catch (e) {
      // Do NOT fall back to an empty list. An older gateway has no
      // /api/skills and answers 405; setting [] here made the screen show
      // the error AND "No skills yet" at the same time — two claims that
      // contradict each other, and the reassuring one is the lie. Leaving
      // the data null keeps the error the only thing on screen.
      setError(isUnsupportedByAgent(e)
        ? 'This agent runs an older OpenAgent that does not expose skills yet. Update the agent and it will appear here.'
        : e instanceof Error ? e.message : String(e));
      setSkills(null);
      setFailed(true);
    }
  }, [includeArchived]);

  // Reload on focus so an edit made in the detail screen is reflected here.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const save = useCallback(async () => {
    const name = draft.name.trim();
    const body = draft.body.trim();
    if (!name || !body) {
      setError('A skill needs a name and a body.');
      return;
    }
    setSaving(true);
    try {
      const r = await createSkill({
        name,
        description: draft.description.trim() || undefined,
        category: draft.category.trim() || undefined,
        body,
      });
      setCreating(false);
      setDraft({ name: '', description: '', category: '', body: '' });
      setError(null);
      // The write landed on disk; the prompt index is a frozen snapshot.
      // Saying so is the difference between "it didn't work" and "not yet".
      setNotice(r.index_refreshed === false
        ? `"${name}" written. The agent picks it up on its next reload — the skills index in its prompt is a cached snapshot.`
        : `"${name}" written.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const grouped = useMemo(() => {
    if (!skills) return null;
    const q = filter.trim().toLowerCase();
    const matching = q
      ? skills.filter((s) =>
          s.name.toLowerCase().includes(q)
          || s.description.toLowerCase().includes(q)
          || s.category.toLowerCase().includes(q))
      : skills;
    const byCategory = new Map<string, SkillSummary[]>();
    for (const s of matching) {
      const key = s.category || 'general';
      const bucket = byCategory.get(key);
      if (bucket) bucket.push(s);
      else byCategory.set(key, [s]);
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [skills, filter]);

  const total = skills?.length ?? 0;

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingTop: headerInset + 16 }]}
      >
        <View style={styles.toolbar}>
          <View style={styles.searchWrap}>
            <Feather name="search" size={13} color={colors.textMuted} />
            <TextInput
              style={styles.search}
              value={filter}
              onChangeText={setFilter}
              placeholder="Filter by name, description or category"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
            />
          </View>
          {!creating && (
            <Button label="New skill" icon="plus" size="sm" onPress={() => setCreating(true)} />
          )}
        </View>

        <View style={styles.archivedRow}>
          <Text style={styles.archivedLabel}>Show archived</Text>
          <ThemedSwitch value={includeArchived} onValueChange={setIncludeArchived} />
          <View style={{ flex: 1 }} />
          <Text style={styles.count}>{total} {total === 1 ? 'skill' : 'skills'}</Text>
        </View>

        {error && <Notice onDismiss={() => setError(null)}>{error}</Notice>}
        {notice && <Notice tone="info" onDismiss={() => setNotice(null)}>{notice}</Notice>}

        {creating && (
          <Card style={styles.formCard}>
            <Text style={styles.formTitle}>New skill</Text>
            <Input
              label="Name"
              placeholder="Deploy check"
              value={draft.name}
              onChangeText={(v: string) => setDraft({ ...draft, name: v })}
            />
            <Input
              label="Description"
              hint="One line. This is what the agent sees in its prompt index."
              placeholder="Verify a release before shipping it"
              value={draft.description}
              onChangeText={(v: string) => setDraft({ ...draft, description: v })}
            />
            <Input
              label="Category"
              hint="Groups the skill in the index. Defaults to “general”."
              placeholder="ops"
              value={draft.category}
              onChangeText={(v: string) => setDraft({ ...draft, category: v })}
            />
            <Input
              label="Body"
              hint="Markdown instructions. Do not write a --- frontmatter block; it is generated from the fields above."
              placeholder={'1. Run the test suite\n2. Check the changelog\n3. Tag the release'}
              value={draft.body}
              onChangeText={(v: string) => setDraft({ ...draft, body: v })}
              multiline
              rows={8}
              mono
            />
            <View style={styles.formActions}>
              <Button label="Cancel" variant="ghost" size="sm" onPress={() => setCreating(false)} />
              <Button
                label={saving ? 'Writing…' : 'Create'}
                size="sm"
                disabled={saving}
                onPress={() => { void save(); }}
              />
            </View>
          </Card>
        )}

        {failed ? null : skills === null ? (
          <Card><Skeleton height={90} /></Card>
        ) : grouped && grouped.length === 0 ? (
          <EmptyState
            icon="book"
            title={filter ? 'No skill matches that' : 'No skills yet'}
            message={filter
              ? 'Try a shorter filter, or turn on “Show archived”.'
              : 'A skill is a reusable procedure the agent can read on demand. The agent writes its own as it learns; you can also write one by hand.'}
          />
        ) : (
          grouped?.map(([category, rows]) => (
            <View key={category} style={styles.group}>
              <Text style={styles.groupTitle}>{category}</Text>
              <Card padded={false}>
                {rows.map((s, i) => (
                  <Pressable
                    key={s.name}
                    style={[styles.row, i > 0 && styles.rowBorder, s.archived && styles.rowArchived]}
                    onPress={() => router.push({
                      pathname: '/(tabs)/skills/[name]',
                      params: { name: s.name },
                    })}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName}>{s.name}</Text>
                      {s.description ? (
                        <Text style={styles.rowDesc} numberOfLines={2}>{s.description}</Text>
                      ) : null}
                      <View style={styles.badgeRow}>
                        {s.agent_authored && <Badge icon="cpu" label="Agent" />}
                        {s.from_hub && <Badge icon="download-cloud" label="Hub" />}
                        {s.archived && <Badge icon="archive" label="Archived" />}
                      </View>
                    </View>
                    <Feather name="chevron-right" size={15} color={colors.textMuted} />
                  </Pressable>
                ))}
              </Card>
            </View>
          ))
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

function Badge({ icon, label }: { icon: keyof typeof Feather.glyphMap; label: string }) {
  return (
    <View style={styles.badge}>
      <Feather name={icon} size={9} color={colors.textMuted} />
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 12 },

  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: colors.inputBg,
    borderWidth: 1, borderColor: colors.border,
  },
  search: {
    flex: 1, fontSize: 12, color: colors.text,
    // @ts-ignore — web-only: the border is ours, kill the focus ring
    ...(typeof window !== 'undefined' ? { outlineStyle: 'none' as any } : {}),
  },
  archivedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  archivedLabel: { fontSize: 11, color: colors.textSecondary },
  count: { fontSize: 11, color: colors.textMuted },

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

  formCard: { gap: 4 },
  formTitle: {
    fontSize: 13, fontWeight: '600', color: colors.text,
    fontFamily: font.display, marginBottom: 4,
  },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },

  group: { gap: 6 },
  groupTitle: {
    fontSize: 10, color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 11,
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  rowArchived: { opacity: 0.55 },
  rowName: { fontSize: 13, fontWeight: '600', color: colors.text },
  rowDesc: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },

  badgeRow: { flexDirection: 'row', gap: 5, marginTop: 6 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.mutedSoft,
  },
  badgeText: { fontSize: 9, color: colors.textMuted },
});
