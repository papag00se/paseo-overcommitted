import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import { dismissWarningsRpc, statusRpc } from "../shared/contracts";

export function Warnings({ theme, layout, onDismissed }: PluginSurfaceProps & { onDismissed: () => void }) {
  const getStatus = useRpc(statusRpc), dismiss = useRpc(dismissWarningsRpc);
  const queries = useQueryClient();
  const status = useQuery({ queryKey: ["overcommitted-status"], queryFn: () => getStatus({}), refetchInterval: 15_000 });
  const action = useMutation({
    mutationFn: (warnings: { directory: string; at: string }[]) => dismiss({ warnings }),
    onSuccess: async () => { onDismissed(); await queries.invalidateQueries({ queryKey: ["overcommitted-status"] }); },
  });
  const text = { color: theme.colors.foreground }, muted = { color: theme.colors.foregroundMuted };
  const failures = status.data?.failures ?? [];
  const button = { padding: 12, borderRadius: 8, backgroundColor: theme.colors.accent };
  const buttonText = { color: theme.colors.accentForeground, fontWeight: "600" as const };
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16, backgroundColor: theme.colors.surface0 }}>
    <Text style={{ ...text, fontSize: 22, fontWeight: "bold" }}>Work not pushed</Text>
    <Text style={muted}>Dismiss hides this occurrence only. It does not cancel retries or mark work as pushed. A subsequent failed attempt will appear again. Configuration lives in Settings → Plugins → Overcommitted.</Text>
    {status.isPending && <Text style={muted}>Loading warnings…</Text>}
    {!!(status.error || action.error) && <Text accessibilityRole="alert" style={text}>{(action.error || status.error)?.message}</Text>}
    {status.data && !failures.length && <Text style={text}>No warnings. The sidebar item is hidden.</Text>}
    {!!failures.length && <Pressable accessibilityRole="button" disabled={action.isPending} style={button} onPress={() => action.mutate(failures.map(({ directory, at }) => ({ directory, at })))}>
      <Text style={buttonText}>Dismiss all shown warnings</Text>
    </Pressable>}
    {failures.map(failure => <View key={`${failure.directory}-${failure.at}`} style={{ padding: 16, gap: 10, borderWidth: 1, borderColor: theme.colors.accent, borderRadius: 8 }}>
      <Text style={{ ...text, fontWeight: "bold" }}>{failure.directory}</Text>
      <Text style={text}>{failure.message}</Text>
      <Text style={muted}>{new Date(failure.at).toLocaleString()}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Dismiss warning for ${failure.directory}`} disabled={action.isPending} style={button} onPress={() => action.mutate([{ directory: failure.directory, at: failure.at }])}>
        <Text style={buttonText}>Dismiss</Text>
      </Pressable>
    </View>)}
  </ScrollView>;
}
