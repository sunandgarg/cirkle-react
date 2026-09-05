import { useEffect } from "react";
import { PhoneIncoming } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { getCallInvitePath, parseCallInviteNotification } from "@/lib/callInvites";
import type { CirkleNotification } from "@/lib/notifications";
import { appSyncRealtimeEnabled, subscribeAppSync } from "@/lib/appsyncEvents";
import { useDailyCallsEnabled } from "@/hooks/useRuntimeFeatures";

/** A call-only affordance for the Forum header; ordinary notifications stay out. */
const IncomingCallButton = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const callsEnabled = useDailyCallsEnabled();
  const { data: notifications = [] } = useQuery({
    queryKey: ["incoming-call-notifications", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const response = await supabase.from("notifications").select("*").eq("user_id", user.id).eq("type", "call_invite").order("created_at", { ascending: false }).limit(5);
      if (response.error) throw response.error;
      return (response.data ?? []) as CirkleNotification[];
    },
    enabled: callsEnabled && !!user,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!callsEnabled || !user) return;
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["incoming-call-notifications", user.id] });
      void queryClient.invalidateQueries({ queryKey: ["notifications", user.id] });
    };
    const unsubscribeAppSync = appSyncRealtimeEnabled
      ? subscribeAppSync(`/inbox/${user.id}`, refresh)
      : undefined;
    // Socket.IO remains the authorized recovery transport when AppSync is
    // unavailable. This topic is one of the server's self-user channels.
    const channel = supabase.channel(`notifications-realtime-${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` }, () => {
        refresh();
      })
      .subscribe();
    return () => {
      unsubscribeAppSync?.();
      void supabase.removeChannel(channel);
    };
  }, [callsEnabled, queryClient, user]);

  const invite = notifications.map(parseCallInviteNotification).find((value) => value !== null);
  if (!callsEnabled || !invite) return null;

  return (
    <button
      type="button"
      onClick={() => navigate(getCallInvitePath(invite))}
      className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 transition-colors hover:bg-emerald-500/25 dark:text-emerald-300"
      aria-label={`Join incoming ${invite.mode} call`}
      title={`Incoming ${invite.mode} call`}
    >
      <PhoneIncoming className="h-4 w-4 animate-pulse" />
    </button>
  );
};

export default IncomingCallButton;
