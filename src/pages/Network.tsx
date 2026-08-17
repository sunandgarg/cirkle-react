import { useState, useMemo, useCallback } from "react";
import EmptyState from "@/components/EmptyState";
import { Users, Search, BadgeCheck, MessageSquare, UserPlus, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

const getInitials = (name?: string | null): string => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
};

type TabType = "explore" | "discover" | "pending" | "connected";

const Network = () => {
  const { user, profile, isVerified } = useAuth();
  const [search, setSearch] = useState("");
  const [invitee, setInvitee] = useState<any>(null);
  const [inviteNote, setInviteNote] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as TabType) || "explore";
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const setActiveTab = (tab: TabType) => {
    setSearchParams({ tab });
  };

  const userIit = profile?.iit_name || "";
  const userStudentStatus = profile?.student_status || "";
  const userYear = userStudentStatus.match(/\d{4}/)?.[0] || "";

  const { data: members } = useQuery({
    queryKey: ["members"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*").neq("user_id", user?.id || "").limit(200);
      return data ?? [];
    },
    enabled: !!user && isVerified,
    staleTime: Infinity,
  });

  const { data: connections } = useQuery({
    queryKey: ["connections"],
    queryFn: async () => {
      if (!user) return [];
      const { data } = await supabase.from("connections").select("*").or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`);
      return data ?? [];
    },
    enabled: !!user && isVerified,
    staleTime: Infinity,
  });

  const getConnectionStatus = useCallback((memberId: string) => {
    const conn = connections?.find((c: any) =>
      (c.requester_id === user?.id && c.receiver_id === memberId) ||
      (c.receiver_id === user?.id && c.requester_id === memberId)
    );
    if (!conn) return "none";
    if ((conn as any).status === "accepted") return "connected";
    if ((conn as any).status !== "pending") return "none";
    if ((conn as any).requester_id === user?.id) return "pending_sent";
    return "pending_received";
  }, [connections, user?.id]);

  const getConnection = (memberId: string) => connections?.find((c: any) =>
    (c.requester_id === user?.id && c.receiver_id === memberId) ||
    (c.receiver_id === user?.id && c.requester_id === memberId)
  );

  const sendRequest = useMutation({
    mutationFn: async ({ receiverId, note }: { receiverId: string; note: string }) => {
      const { error } = await (supabase as any).rpc("send_connection_request", {
        p_receiver_id: receiverId, p_note: note.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connections"] }); setInvitee(null); setInviteNote(""); toast.success("Invitation sent"); },
    onError: (error: any) => toast.error(error.message || "Could not send invitation"),
  });

  const respondRequest = useMutation({
    mutationFn: async ({ memberId, status }: { memberId: string; status: string }) => {
      const connection = getConnection(memberId) as any;
      if (!connection?.id) throw new Error("Invitation not found");
      const { error } = await (supabase as any).rpc("respond_connection_request", { p_request_id: connection.id, p_accept: status === "accepted" });
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connections"] }); toast.success("Invitation updated"); },
    onError: (error: any) => toast.error(error.message || "Could not update invitation"),
  });

  const withdrawRequest = useMutation({
    mutationFn: async (memberId: string) => {
      const connection = getConnection(memberId) as any;
      if (!connection?.id) throw new Error("Invitation not found");
      const { error } = await (supabase as any).rpc("withdraw_connection_request", { p_request_id: connection.id });
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connections"] }); toast.success("Invitation withdrawn"); },
    onError: (error: any) => toast.error(error.message || "Could not withdraw invitation"),
  });

  const openInvite = (member: any) => { setInvitee(member); setInviteNote(""); };

  const shuffled = (arr: any[]) => {
    const seed = new Date().toDateString();
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
    const shuffledArr = [...arr];
    for (let i = shuffledArr.length - 1; i > 0; i--) {
      hash = (hash * 16807) % 2147483647;
      const j = Math.abs(hash) % (i + 1);
      [shuffledArr[i], shuffledArr[j]] = [shuffledArr[j], shuffledArr[i]];
    }
    return shuffledArr;
  };

  const cohortMembers = useMemo(() => {
    if (!members || !userIit || !userYear) return [];
    return shuffled(members.filter((m: any) =>
      m.iit_name === userIit && m.student_status?.includes(userYear) && getConnectionStatus(m.user_id) === "none"
    ));
  }, [members, userIit, userYear, getConnectionStatus]);

  const campusMembers = useMemo(() => {
    if (!members || !userIit) return [];
    return shuffled(members.filter((m: any) =>
      m.iit_name === userIit && getConnectionStatus(m.user_id) === "none"
    ));
  }, [members, userIit, getConnectionStatus]);

  const globalMembers = useMemo(() => {
    if (!members) return [];
    return shuffled(members.filter((m: any) => getConnectionStatus(m.user_id) === "none"));
  }, [members, getConnectionStatus]);

  const discoverMembers = useMemo(() => {
    if (!members) return [];
    return shuffled(members.filter((m: any) => getConnectionStatus(m.user_id) === "none"));
  }, [members, getConnectionStatus]);

  const pendingMembers = useMemo(() => {
    if (!members || !connections) return [];
    return members.filter((m: any) => {
      const status = getConnectionStatus(m.user_id);
      return status === "pending_sent" || status === "pending_received";
    });
  }, [members, connections, getConnectionStatus]);

  const connectedMembers = useMemo(() => {
    if (!members || !connections) return [];
    return members.filter((m: any) => getConnectionStatus(m.user_id) === "connected");
  }, [members, connections, getConnectionStatus]);

  const filteredMembers = useMemo(() => {
    if (!search || !members) return null;
    const q = search.toLowerCase();
    return members.filter((m: any) =>
      m.name?.toLowerCase().includes(q) || m.headline?.toLowerCase().includes(q) || m.iit_name?.toLowerCase().includes(q)
    );
  }, [members, search]);

  // Gate behind auth/verification AFTER all hooks
  if (!user) return <EmptyState icon={Users} title="Sign in to network" description="Connect with community members." />;

  if (!isVerified) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
        <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
          <ShieldCheck className="w-10 h-10 text-primary" />
        </div>
        <h2 className="text-xl font-bold text-foreground">Verify Your Account</h2>
        <p className="text-sm text-muted-foreground mt-2 max-w-xs">
          Complete verification to access the network and connect with professionals.
        </p>
        <Button className="mt-6 rounded-xl" onClick={() => navigate("/iit-verify")}>
          <ShieldCheck className="w-4 h-4 mr-2" /> Verify Now
        </Button>
      </div>
    );
  }

  const tabs: { key: TabType; label: string }[] = [
    { key: "explore", label: "Explore" },
    { key: "discover", label: "Discover" },
    { key: "pending", label: "Pending" },
    { key: "connected", label: "Connected" },
  ];

  return (
    <div className="bg-background w-full">
      <div className="max-w-lg mx-auto px-4 pt-4 space-y-4 pb-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">My Network</h1>
          <p className="text-xs text-muted-foreground">Discover and connect with professionals</p>
        </div>

        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search by name, skill, or location..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="pl-10 h-11 rounded-full bg-card border-border text-foreground placeholder:text-muted-foreground" />
        </div>

        <div className="flex gap-2">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`text-xs font-semibold px-4 py-2 rounded-full transition-all ${activeTab === t.key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground bg-secondary hover:bg-accent"}`}>
              {t.label}
              {t.key === "pending" && pendingMembers.length > 0 && (
                <span className="ml-1 bg-destructive text-destructive-foreground rounded-full px-1.5 text-[10px]">{pendingMembers.length}</span>
              )}
            </button>
          ))}
        </div>

        {filteredMembers ? (
          <div className="space-y-2">
            {filteredMembers.length ? filteredMembers.map((m: any) => (
              <PersonRow key={m.user_id} m={m} status={getConnectionStatus(m.user_id)} connection={getConnection(m.user_id)} onConnect={() => openInvite(m)} onRespond={respondRequest.mutate} onWithdraw={withdrawRequest.mutate} navigate={navigate} />
            )) : <EmptyState icon={Users} title="No members found" />}
          </div>
        ) : (
          <>
            {activeTab === "explore" && (
              <div className="space-y-6">
                <div>
                  <h3 className="font-bold text-sm text-foreground mb-2">🔥 Trending</h3>
                  <div className="flex gap-2 flex-wrap mb-4">
                    {["Tech Leaders", "Startup Founders", "AI/ML", "Product Managers", "Finance"].map((tag) => (
                      <button key={tag} onClick={() => setSearch(tag)} className="text-[10px] font-semibold px-3 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors">{tag}</button>
                    ))}
                  </div>
                </div>
                {userIit && userYear && (
                  <PeopleSection title={`Same Cohort ${userYear}`} subtitle={`${userIit} · ${userStudentStatus}`} members={cohortMembers}
                    onViewAll={() => { setActiveTab("discover"); setSearch(`${userIit} ${userYear}`); }} onConnect={openInvite} navigate={navigate} getConnectionStatus={getConnectionStatus} />
                )}
                {userIit && (
                  <PeopleSection title={userIit} subtitle="All students & alumni" members={campusMembers}
                    onViewAll={() => { setActiveTab("discover"); setSearch(userIit); }} onConnect={openInvite} navigate={navigate} getConnectionStatus={getConnectionStatus} />
                )}
                <PeopleSection title="Global" subtitle="All community members" members={globalMembers}
                  onViewAll={() => setActiveTab("discover")} onConnect={openInvite} navigate={navigate} getConnectionStatus={getConnectionStatus} />
              </div>
            )}
            {activeTab === "discover" && (
              <div className="space-y-2">
                {discoverMembers.length ? discoverMembers.map((m: any) => (
                  <PersonRow key={m.user_id} m={m} status="none" onConnect={() => openInvite(m)} onRespond={respondRequest.mutate} onWithdraw={withdrawRequest.mutate} navigate={navigate} />
                )) : <p className="text-sm text-muted-foreground text-center py-8">No new people to discover</p>}
              </div>
            )}
            {activeTab === "pending" && (
              <div className="space-y-2">
                {pendingMembers.length ? pendingMembers.map((m: any) => (
                  <PersonRow key={m.user_id} m={m} status={getConnectionStatus(m.user_id)} connection={getConnection(m.user_id)} onConnect={() => openInvite(m)} onRespond={respondRequest.mutate} onWithdraw={withdrawRequest.mutate} navigate={navigate} />
                )) : <p className="text-sm text-muted-foreground text-center py-8">No pending requests</p>}
              </div>
            )}
            {activeTab === "connected" && (
              <div className="space-y-2">
                {connectedMembers.length ? connectedMembers.map((m: any) => (
                  <PersonRow key={m.user_id} m={m} status="connected" onConnect={() => {}} onRespond={respondRequest.mutate} onWithdraw={withdrawRequest.mutate} navigate={navigate} />
                )) : <p className="text-sm text-muted-foreground text-center py-8">No connections yet</p>}
              </div>
            )}
          </>
        )}
      </div>
      <Dialog open={!!invitee} onOpenChange={(open) => { if (!open) { setInvitee(null); setInviteNote(""); } }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Connect with {invitee?.name || "member"}</DialogTitle>
            <DialogDescription>Add brief context so the invitation feels relevant and trustworthy.</DialogDescription>
          </DialogHeader>
          <Textarea value={inviteNote} onChange={(event) => setInviteNote(event.target.value.slice(0, 200))}
            placeholder="We studied at the same campus…" rows={4} className="resize-none" />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>Optional note</span><span>{inviteNote.length}/200</span></div>
          <Button className="w-full rounded-xl" disabled={sendRequest.isPending || !invitee}
            onClick={() => sendRequest.mutate({ receiverId: invitee.user_id, note: inviteNote })}>
            {sendRequest.isPending ? "Sending…" : "Send invitation"}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const PeopleSection = ({ title, subtitle, members, onViewAll, onConnect, navigate, getConnectionStatus }: any) => {
  if (!members || members.length === 0) return null;
  const display = members.slice(0, 4);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="font-bold text-sm text-foreground">{title}</h3>
          {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        {members.length > 4 && <button onClick={onViewAll} className="text-xs font-semibold text-primary hover:underline">View all</button>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {display.map((m: any) => <PersonCard key={m.user_id} m={m} onConnect={() => onConnect(m)} navigate={navigate} />)}
      </div>
    </div>
  );
};

const PersonCard = ({ m, onConnect, navigate }: any) => (
  <div className="bg-card border border-border rounded-xl p-3 flex flex-col items-center text-center cursor-pointer hover:shadow-sm transition-shadow" onClick={() => navigate(m.slug ? `/u/${m.slug}` : `/profile/${m.user_id}`)}>
    {m.avatar_url ? <img src={m.avatar_url} alt={m.name || ""} className="w-14 h-14 rounded-full object-cover mb-2" loading="lazy" />
      : <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center mb-2"><span className="text-lg font-bold text-primary">{getInitials(m.name)}</span></div>}
    <div className="flex items-center gap-1 mb-0.5">
      <p className="font-semibold text-xs text-foreground truncate max-w-[100px]">{m.name || "Member"}</p>
      {m.is_verified && <BadgeCheck className="w-3 h-3 text-primary flex-shrink-0" />}
    </div>
    <p className="text-[10px] text-muted-foreground truncate max-w-full">{m.headline || m.iit_name || ""}</p>
    <Button size="sm" variant="outline" className="rounded-full text-[10px] h-7 px-3 mt-2 gap-1 border-primary text-primary hover:bg-primary hover:text-primary-foreground"
      onClick={(e) => { e.stopPropagation(); onConnect(); }}>
      <UserPlus className="w-3 h-3" /> Connect
    </Button>
  </div>
);

const PersonRow = ({ m, status, connection, onConnect, onRespond, onWithdraw, navigate }: any) => (
  <div className="bg-card border border-border rounded-xl p-3.5 flex items-center gap-3 cursor-pointer active:scale-[0.98] transition-transform" onClick={() => navigate(m.slug ? `/u/${m.slug}` : `/profile/${m.user_id}`)}>
    {m.avatar_url ? <img src={m.avatar_url} alt={m.name || ""} className="w-12 h-12 rounded-full object-cover flex-shrink-0" loading="lazy" />
      : <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center flex-shrink-0"><span className="text-sm font-bold text-primary">{getInitials(m.name)}</span></div>}
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1">
        <p className="font-semibold text-sm text-foreground truncate">{m.name || "Member"}</p>
        {m.is_verified && <BadgeCheck className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
      </div>
      {m.headline && <p className="text-xs text-muted-foreground truncate">{m.headline}</p>}
      {m.location && <p className="text-[10px] text-muted-foreground">{m.location}</p>}
    </div>
    <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
      {status === "none" && (
        <Button size="sm" variant="outline" className="rounded-full text-xs h-8 px-4 gap-1 border-primary text-primary" onClick={onConnect}>
          <UserPlus className="w-3.5 h-3.5" /> Connect
        </Button>
      )}
      {status === "pending_sent" && <Button size="sm" variant="ghost" className="rounded-full text-xs h-8 px-3" onClick={() => onWithdraw(m.user_id)}>Withdraw</Button>}
      {status === "connected" && (
        <Button size="sm" variant="outline" className="rounded-full text-xs h-8 gap-1" onClick={() => navigate(`/chats?peer=${m.user_id}`)}>
          <MessageSquare className="w-3 h-3" /> Chat
        </Button>
      )}
      {status === "pending_received" && (
        <div className="flex flex-col items-end gap-1">
          {connection?.note && <p className="max-w-40 truncate text-[10px] text-muted-foreground" title={connection.note}>{connection.note}</p>}
          <div className="flex gap-1">
          <Button size="sm" className="text-xs h-7 rounded-full px-3" onClick={() => onRespond({ memberId: m.user_id, status: "accepted" })}>Accept</Button>
          <Button size="sm" variant="outline" className="text-xs h-7 rounded-full px-2" onClick={() => onRespond({ memberId: m.user_id, status: "declined" })}>Ignore</Button>
          </div>
        </div>
      )}
    </div>
  </div>
);

export default Network;
