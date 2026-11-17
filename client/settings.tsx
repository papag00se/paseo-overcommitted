import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { checkRpc, preferences, statusRpc, type Preferences } from "../shared/contracts";

export function Settings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const getStatus = useRpc(statusRpc), check = useRpc(checkRpc);
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["overcommitted-status"], queryFn: () => getStatus({}), refetchInterval: 15_000 });
  const action = useMutation({ mutationFn: (preview: boolean) => check({ preview }), onSettled: () => queryClient.invalidateQueries({ queryKey: ["overcommitted-status"] }) });
  const [draft, setDraft] = useState<{ values: Preferences; revision: string } | null>(null);
  const [minutes, setMinutes] = useState("60");
  const [saved, setSaved] = useState(false);
  const [validation, setValidation] = useState("");
  useEffect(() => {
    if (settings.status === "ready" && (!draft || (saved && settings.revision !== draft.revision))) {
      setDraft({ values: settings.values, revision: settings.revision });
      setMinutes(String(settings.values.intervalMinutes));
      setSaved(false);
    }
  }, [settings, draft, saved]);
  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status !== "ready" || !draft) return <Text style={text}>{settings.status === "loading" ? "Loading settings…" : settings.status === "ready" ? "Loading editor…" : settings.error}</Text>;
  const values = draft.values;
  const rulesBox = (value: string, onChangeText: (text: string) => void, placeholder: string, editable = true) =>
    <TextInput multiline value={value} onChangeText={onChangeText} editable={editable} placeholder={placeholder} placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false}
      style={{ minHeight: 88, minWidth: layout.compact ? undefined : 320, textAlignVertical: "top", color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6, padding: 8, fontFamily: "monospace", opacity: editable ? 1 : 0.5 }} />;
  const change = (patch: Partial<Preferences>) => { setDraft({ ...draft, values: { ...values, ...patch } }); setSaved(false); };
  async function save() {
    if (!draft) return;
    const parsed = preferences.schema.safeParse({ ...draft.values, intervalMinutes: Number(minutes) });
    if (!parsed.success) { setValidation(parsed.error.issues.map(i => i.message).join("; ")); return; }
    setValidation("");
    if (await settings.save(parsed.data, draft.revision)) setSaved(true);
  }
  return <View style={{ gap: 16, padding: layout.compact ? 12 : 20, backgroundColor: theme.colors.surface0 }}>
    <SettingsSection title="Overcommitted" trailing={<Pressable accessibilityRole="button" onPress={() => void save()} disabled={settings.saving}
      style={{ flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: theme.colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, opacity: settings.saving ? 0.6 : 1 }}>
      <Icon name="Save" size={15} color={theme.colors.accentForeground} />
      <Text style={{ color: theme.colors.accentForeground, fontWeight: "700" }}>{settings.saving ? "Saving…" : saved ? "Saved" : "Save settings"}</Text>
    </Pressable>}>
      <Text style={muted}>Stage, commit and push non-ignored changes and existing unpushed commits in Paseo worktrees. Closed agents and empty terminal prompts do not block. Active agents, jobs and scripts still do. Only activity that is actually seen blocks; unreadable activity is shown as a warning. Never force-pushes, stashes, resets or skips hooks.</Text>
      {validation || settings.saveError ? <Text accessibilityRole="alert" style={text}>{validation || settings.saveError}</Text> : null}
      <SettingsCard>
        <SettingsSwitch label="Enable automatic commits and pushes" value={values.enabled} onValueChange={enabled => change({ enabled })} />
        <SettingsInput label="Check interval (minutes)" initialValue={minutes} onChangeText={setMinutes} hint="Default: 60. From 1 minute to 7 days. Saving restarts the timer." />
        <SettingsSwitch label="Don't push to protected branches automatically:" value={values.protectBranches} onValueChange={protectBranches => change({ protectBranches })} />
        <SettingsRow label="Protected branches (one rule per line)" hint={"Each line is a folder pattern followed by branch patterns: /path/to/repo main release/*. The first line whose folder matches a repository decides for it, so put specific repositories above general ones. No branch patterns means every branch. Patterns: * (within one name), ** (across /), ?, [abc]; ! excludes (!main = every branch except main); * alone as the folder means every repository. ~ is your home folder; quote folders with spaces. Lines starting with # are notes.\nExamples:\n* main master\n~/Work/app !dev\nA plain list such as main, master still works and means * main master."}>
          {rulesBox(values.protectedBranches, protectedBranches => change({ protectedBranches }), "* main master\n~/Work/hotfix-repo", values.protectBranches)}
        </SettingsRow>
      </SettingsCard>
      <SettingsCard>
        <SettingsSwitch label="Create and push to an interim branch with prefix:" value={values.useInterimBranch} onValueChange={useInterimBranch => change({ useInterimBranch })} hint="The interim branch stays checked out. When this is off, protected branches stay untouched and unpushed work raises a persistent warning. Always used for: protected branches above, including a waiting push whose branch became protected; branches the remote refuses as protected (for example GitHub branch protection; refusals over secrets are never routed around); and changes on a detached HEAD, saved to a new branch such as overcommitted/detached-1a2b3c4. A clean detached checkout already on the remote is left alone." />
        <SettingsInput label="Interim branch prefix" initialValue={values.interimPrefix} disabled={!values.useInterimBranch} onChangeText={interimPrefix => change({ interimPrefix })} hint="<current branch name> is a placeholder for the branch being preserved: overcommitted/<current branch name> on main pushes to overcommitted/main. A prefix without the placeholder gets the branch name appended. If that branch has diverged or is in use, -2, -3, … is added." />
      </SettingsCard>
      <SettingsCard>
        <SettingsRow label="Check for child git repositories in these folders:" hint={"One folder pattern per line (no branch patterns). A pattern selects among the folders Paseo already knows as a project or workspace; each match is scanned up to 4 levels deep (not hidden folders or node_modules) and its repositories are checked like any other. A folder that is not known to Paseo is reported and skipped. Patterns: * (within one name), ** (across /), ?; ~ is your home folder; quote folders with spaces.\nExamples:\n/home/me/Work\n~/src/*"}>
          {rulesBox(values.childRepoFolders, childRepoFolders => change({ childRepoFolders }), "/home/me/Work\n~/src/*")}
        </SettingsRow>
      </SettingsCard>
      <SettingsCard>
        <SettingsRow label="Never check these repositories:" hint={"One rule per line: a folder pattern, then optional branch patterns. A matching repository (including symlinked aliases and everything below the folder) is skipped while its checked-out branch matches, and nothing is ever pushed to a matching branch, including interim branches. No branch patterns means every branch. The first line whose folder matches decides, so a specific repository above a * line overrides it. Patterns: * (within one name), ** (across /), ?, [abc]; ! excludes (!main = every branch except main). ~ is your home folder; quote folders with spaces. Lines starting with # are notes.\nExamples:\n~/Work/private-repo\n~/Work/app main release/*\n~/Work/lib !wip/*"}>
          {rulesBox(values.excludedRepos, excludedRepos => change({ excludedRepos }), "~/Work/private-repo\n~/Work/app main release/*")}
        </SettingsRow>
      </SettingsCard>
      <SettingsSection title="Automatic fixes">
        <Text style={muted}>Each fix runs only when it cannot lose work. Otherwise the problem is reported under Work not pushed.</Text>
        <SettingsCard>
          <SettingsSwitch label="Merge new remote commits when they don't conflict" value={values.mergeRemoteAhead} onValueChange={mergeRemoteAhead => change({ mergeRemoteAhead })} hint="If the remote branch moved ahead, merge it in only when Git proves there are no conflicts and no ignored local files would be replaced." />
          <SettingsSwitch label="Remove a lock left by a crashed check" value={values.removeStaleLock} onValueChange={removeStaleLock => change({ removeStaleLock })} hint="Only when the process that took the lock is gone." />
          <SettingsSwitch label="Finish a waiting push after a branch switch" value={values.pushSwitchedBranch} onValueChange={pushSwitchedBranch => change({ pushSwitchedBranch })} hint="Pushes the branch whose push failed earlier, without switching back to it." />
        </SettingsCard>
        <SettingsCard>
          <SettingsSwitch label="Use an agent to resolve conflicts or pre-checks" value={values.agentResolve} onValueChange={agentResolve => change({ agentResolve })} hint={"Conflict: you and the remote both edited the install steps in README.md. The agent merges, keeps both edits and commits.\nPre-check: a lint hook blocks the commit over a missing semicolon in app.js. The agent fixes app.js and commits normally.\nIt works in the repository, never pushes, forces or skips checks, and gets one try per situation."} />
          <SettingsInput label="Agent provider/model" initialValue={values.agentModel} disabled={!values.agentResolve} onChangeText={agentModel => change({ agentModel })} hint="For example claude/claude-sonnet-5 or codex/gpt-6.1-sol." />
        </SettingsCard>
      </SettingsSection>
    </SettingsSection>
    <SettingsSection title="Checks">
      <Text style={text}>{status.data?.running ? "Checking…" : status.data?.nextCheck ? `Next check: ${new Date(status.data.nextCheck).toLocaleString()}` : "No check scheduled"}</Text>
      <SettingsCard>
        <SettingsAction label="Preview eligibility (no staging, commits or checkout)" actionLabel="Preview" disabled={action.isPending || status.data?.running} onPress={() => action.mutate(true)} />
        <SettingsAction label="Stage, commit and push eligible worktrees now" actionLabel="Check now" disabled={!settings.values.enabled || action.isPending || status.data?.running} onPress={() => action.mutate(false)} />
      </SettingsCard>
      {action.error || status.error ? <Text style={text}>{(action.error || status.error)?.message}</Text> : null}
      {(status.data?.reports ?? []).map((report, index) => <View key={`${report.directory}-${index}`} style={{ gap: 4 }}>
        <Text style={text}>{report.outcome.toUpperCase()} · {report.directory}</Text>
        <Text style={muted}>{report.message}</Text>
        {report.warnings?.map((warning, i) => <Text key={i} style={muted}>Activity warning (not a blocker): {warning}</Text>)}
        <Text style={muted}>{new Date(report.at).toLocaleString()}</Text>
      </View>)}
    </SettingsSection>
  </View>;
}
