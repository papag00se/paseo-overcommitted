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
      <Text style={muted}>Stage, commit and push non-ignored changes and existing unpushed commits in Paseo worktrees. Closed agents and empty terminal prompts do not block. Active agents, jobs and scripts still do.</Text>
      {validation || settings.saveError ? <Text accessibilityRole="alert" style={text}>{validation || settings.saveError}</Text> : null}
      <SettingsCard>
        <SettingsSwitch label="Enable automatic commits and pushes" value={values.enabled} onValueChange={enabled => change({ enabled })} />
        <SettingsInput label="Check interval (minutes)" initialValue={minutes} onChangeText={setMinutes} hint="Default: 60. From 1 minute to 7 days. Saving restarts the timer." />
        <SettingsSwitch label="Don't push to these branch names automatically:" value={values.protectBranches} onValueChange={protectBranches => change({ protectBranches })} />
        <SettingsInput label="Branch names (comma separated)" initialValue={values.protectedBranches} disabled={!values.protectBranches} onChangeText={protectedBranches => change({ protectedBranches })} hint="Exact, case-sensitive branch names, for example: main, master, production" />
      </SettingsCard>
      <SettingsCard>
        <SettingsSwitch label="Create and push to an interim branch with prefix:" value={values.useInterimBranch} onValueChange={useInterimBranch => change({ useInterimBranch })} hint="Used for protected branch names above, branches the remote refuses as protected, and work on a detached HEAD." />
        <SettingsInput label="Interim branch prefix" initialValue={values.interimPrefix} disabled={!values.useInterimBranch} onChangeText={interimPrefix => change({ interimPrefix })} hint="<current branch name> is a placeholder for the branch being preserved: overcommitted/<current branch name> on main pushes to overcommitted/main. A prefix without the placeholder gets the branch name appended. If that branch has diverged or is in use, -2, -3, … is added." />
      </SettingsCard>
      <SettingsCard>
        <SettingsRow label="Check for child git repositories in these folders:" hint="Full paths, one per line. Each must be a known Paseo project or workspace folder. Repositories up to 4 levels below it (not hidden folders or node_modules) are checked like any other repository.">
          <TextInput multiline value={values.childRepoFolders} onChangeText={childRepoFolders => change({ childRepoFolders })} placeholder={"/home/me/Work\n/home/me/src"} placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false}
            style={{ minHeight: 88, minWidth: layout.compact ? undefined : 320, textAlignVertical: "top", color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6, padding: 8, fontFamily: "monospace" }} />
        </SettingsRow>
      </SettingsCard>
      <SettingsSection title="Automatic fixes">
        <Text style={muted}>Each fix runs only when it cannot lose work. Otherwise the problem is reported under Work not pushed.</Text>
        <SettingsCard>
          <SettingsSwitch label="Merge new remote commits when they don't conflict" value={values.mergeRemoteAhead} onValueChange={mergeRemoteAhead => change({ mergeRemoteAhead })} hint="If the remote branch moved ahead, merge it in only when Git proves there are no conflicts and no ignored local files would be replaced." />
          <SettingsSwitch label="Remove a lock left by a crashed check" value={values.removeStaleLock} onValueChange={removeStaleLock => change({ removeStaleLock })} hint="Only when the process that took the lock is gone." />
          <SettingsSwitch label="Finish a waiting push after a branch switch" value={values.pushSwitchedBranch} onValueChange={pushSwitchedBranch => change({ pushSwitchedBranch })} hint="Pushes the branch whose push failed earlier, without switching back to it." />
          <SettingsSwitch label="Send a waiting push to the interim branch when its branch becomes protected" value={values.rerouteNewlyProtected} disabled={!values.useInterimBranch} onValueChange={rerouteNewlyProtected => change({ rerouteNewlyProtected })} />
          <SettingsSwitch label="Use the interim branch when the remote refuses a protected branch" value={values.rerouteServerProtected} disabled={!values.useInterimBranch} onValueChange={rerouteServerProtected => change({ rerouteServerProtected })} hint="For example GitHub branch protection or rulesets. Secret-scanning refusals are never routed around." />
          <SettingsSwitch label="Save work from a detached HEAD to a new interim branch" value={values.saveDetachedHead} disabled={!values.useInterimBranch} onValueChange={saveDetachedHead => change({ saveDetachedHead })} hint="A clean detached checkout that is already on the remote is left alone." />
        </SettingsCard>
        <SettingsCard>
          <SettingsSwitch label="Use an agent to resolve conflicts or pre-checks" value={values.agentResolve} onValueChange={agentResolve => change({ agentResolve })} hint={"Conflict: you and the remote both edited the install steps in README.md. The agent merges, keeps both edits and commits.\nPre-check: a lint hook blocks the commit over a missing semicolon in app.js. The agent fixes app.js and commits normally.\nIt works in the repository, never pushes, forces or skips checks, and gets one try per situation."} />
          <SettingsInput label="Agent provider/model" initialValue={values.agentModel} disabled={!values.agentResolve} onChangeText={agentModel => change({ agentModel })} hint="For example claude/claude-sonnet-5 or codex/gpt-6.1-sol." />
        </SettingsCard>
      </SettingsSection>
      <Text style={muted}>Interim branches stay checked out. Disabling the interim option leaves protected branches untouched and raises a persistent warning when work cannot be pushed. No force pushes, stashing, resets or hook bypasses. Unknown or unreadable activity does not block commits or pushes. Only positively observed activity blocks; incomplete checks are shown as warnings.</Text>
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
