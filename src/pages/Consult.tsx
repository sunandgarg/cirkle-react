import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, MessageCircle, Phone, Video, Search, Lock, X, Calendar, Clock, CheckCircle2, Users, Sparkles, AlertCircle, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

const CATEGORIES = ["All", "Tech", "Finance", "Career", "Startups", "Research", "Design", "Legal"];
const TIME_SLOTS = ["09:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "02:00 PM", "03:00 PM", "04:00 PM", "05:00 PM", "06:00 PM", "07:00 PM"];
const DURATION_OPTIONS = [15, 30, 45, 60];

const toScheduledIso = (date: string, time: string) => {
  const match = time.match(/^(\d{1,2}):(\d{2})\s(AM|PM)$/);
  if (!match) throw new Error("Choose a valid time");
  let hour = Number(match[1]);
  if (match[3] === "PM" && hour !== 12) hour += 12;
  if (match[3] === "AM" && hour === 12) hour = 0;
  const local = new Date(`${date}T${String(hour).padStart(2, "0")}:${match[2]}:00`);
  if (Number.isNaN(local.getTime())) throw new Error("Choose a valid booking date");
  return local.toISOString();
};

const getInitials = (name?: string | null): string => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
};

// Topmate-style service card
const ServiceButton = ({ icon: Icon, label, price, color, active, onClick }: any) => (
  <button onClick={onClick} disabled={price === undefined || price === null}
    className={`flex-1 py-3 rounded-2xl text-xs font-semibold flex flex-col items-center justify-center gap-1.5 transition-all border-2 hover-scale ${
      active ? `${color} shadow-sm` : "bg-card border-border text-muted-foreground hover:border-primary/30"
    } disabled:cursor-not-allowed disabled:opacity-40`}>
    <Icon className="w-4 h-4" />
    <span>{label}</span>
    {price !== undefined && price !== null && <span className="text-[10px] opacity-75">₹{price}</span>}
  </button>
);

const Consult = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, profile } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [bookingExpert, setBookingExpert] = useState<any>(null);
  const [bookingType, setBookingType] = useState<"chat" | "audio" | "video">("chat");
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [selectedDuration, setSelectedDuration] = useState(30);
  const [bookingNotes, setBookingNotes] = useState("");
  const [activeTab, setActiveTab] = useState<"mentors" | "bookings">("mentors");

  const isVerified = !!user && !!profile?.is_verified && !!profile?.onboarding_completed;

  // Only fetch mentors who opted in
  const { data: experts, isLoading: expertsLoading, error: expertsError, refetch: refetchExperts } = useQuery({
    queryKey: ["mentors", search, activeCategory],
    queryFn: async () => {
      const normalizedSearch = search.trim().replace(/[^a-zA-Z0-9 .&+#-]/g, " ").slice(0, 80);
      let query: any = supabase.from("profiles").select("user_id,name,avatar_url,headline,bio,iit_name,is_verified,onboarding_completed,is_mentor,mentor_category,mentor_price_chat,mentor_price_audio,mentor_price_video,skills,slug").eq("is_mentor", true).eq("is_verified", true).eq("onboarding_completed", true);
      if (normalizedSearch) query = query.or(`name.ilike.%${normalizedSearch}%,headline.ilike.%${normalizedSearch}%`);
      if (activeCategory !== "All") query = query.eq("mentor_category", activeCategory);
      query = query.order("is_verified", { ascending: false });
      const { data, error } = await query.limit(50);
      if (error) throw error;
      return (data ?? []) as any[];
    },
    staleTime: 5 * 60_000,
  });

  // My bookings - topmate-style
  const { data: myBookings, isLoading: bookingsLoading, error: bookingsError, refetch: refetchBookings } = useQuery({
    queryKey: ["my-consultations", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await (supabase as any).from("consultations").select("id,client_id,consultant_id,consultation_type,status,amount,duration_minutes,scheduled_at,notes,created_at,chat_room_id").or(`client_id.eq.${user.id},consultant_id.eq.${user.id}`)
        .order("created_at", { ascending: false });
      if (error) throw error;
      if (!data?.length) return [];
      const rows = data as any[];
      const userIds = [...new Set<string>(rows.map((b) => b.consultant_id === user.id ? b.client_id : b.consultant_id))];
      const { data: profiles } = await supabase.from("profiles").select("user_id, name, avatar_url").in("user_id", userIds);
      const pMap = new Map(profiles?.map(p => [p.user_id, p]) ?? []);
      return rows.map((b) => ({
        ...b,
        otherProfile: pMap.get(b.consultant_id === user.id ? b.client_id : b.consultant_id),
        isConsultant: b.consultant_id === user.id,
      }));
    },
    enabled: !!user,
  });

  const bookMutation = useMutation({
    mutationFn: async () => {
      if (!user || !bookingExpert || !selectedDate || !selectedTime) throw new Error("Choose a date and time");
      const { data: consultation, error } = await (supabase as any).rpc("request_consultation", {
        p_consultant_id: bookingExpert.user_id,
        p_consultation_type: bookingType,
        p_scheduled_at: toScheduledIso(selectedDate, selectedTime),
        p_duration_minutes: selectedDuration,
        p_notes: bookingNotes.trim() || null,
      });
      if (error) {
        throw new Error(error.message || "Booking failed. Please try again.");
      }
      return consultation;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-consultations"] });
      setBookingExpert(null); setBookingNotes(""); setSelectedDate(""); setSelectedTime(""); setSelectedDuration(30);
      toast.success("Request sent. You’ll be notified when the mentor accepts.");
    },
    onError: (err: any) => toast.error(err.message || "Something went wrong"),
  });

  const updateBookingStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { data, error } = await (supabase as any).rpc("change_consultation_status", {
        p_consultation_id: id,
        p_status: status,
      });
      if (error) throw error;
      if (status === "confirmed") {
        const { error: chatError } = await supabase.functions.invoke("create-consult-chat", { body: { consultation_id: id } });
        if (chatError) toast.warning("Booking accepted. The conversation will be created when either participant retries.");
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-consultations"] });
      toast.success("Booking updated");
    },
    onError: (error: any) => toast.error(error.message || "Could not update this booking"),
  });

  const displayExperts = !user ? experts?.slice(0, 3) : isVerified ? experts : experts?.slice(0, 3);
  const nextDates = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i + 1);
    return d.toISOString().split("T")[0];
  });

  const bookingPrice = useMemo(() => {
    if (!bookingExpert) return null;
    return bookingType === "chat" ? bookingExpert.mentor_price_chat : bookingType === "audio" ? bookingExpert.mentor_price_audio : bookingExpert.mentor_price_video;
  }, [bookingExpert, bookingType]);

  useEffect(() => {
    if (!isVerified || !experts?.length || bookingExpert) return;
    const mentorId = searchParams.get("mentor");
    const requestedService = searchParams.get("service");
    if (!mentorId) return;
    const mentor = experts.find((item) => item.user_id === mentorId);
    if (!mentor) return;
    const available = (["chat", "audio", "video"] as const).filter((service) => mentor[`mentor_price_${service}`] != null);
    if (!available.length) return;
    const service = available.includes(requestedService as any) ? requestedService as "chat" | "audio" | "video" : available[0];
    setBookingType(service);
    setBookingExpert(mentor);
    setSearchParams({}, { replace: true });
  }, [bookingExpert, experts, isVerified, searchParams, setSearchParams]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Booking Modal - topmate.io style */}
      {bookingExpert && (
        <div className="fixed inset-0 z-[60] bg-background/80 backdrop-blur-sm flex items-end sm:items-center justify-center">
          <div className="bg-card w-full max-w-md rounded-t-3xl sm:rounded-3xl border border-border p-6 animate-fade-in max-h-[90vh] overflow-y-auto shadow-2xl">
            {/* Expert mini card */}
            <div className="flex items-center gap-3 mb-5">
              {bookingExpert.avatar_url ? (
                <img src={bookingExpert.avatar_url} alt="" className="w-14 h-14 rounded-full object-cover ring-2 ring-primary/20" />
              ) : (
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-xl font-bold text-primary">{getInitials(bookingExpert.name)}</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-foreground text-sm flex items-center gap-1">
                  {bookingExpert.name}
                  {bookingExpert.is_verified && <BadgeCheck className="w-4 h-4 text-primary" />}
                </h3>
                <p className="text-xs text-muted-foreground truncate">{bookingExpert.headline || "Mentor"}</p>
              </div>
              <button onClick={() => setBookingExpert(null)} className="p-1.5 rounded-full hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"><X className="w-5 h-5" /></button>
            </div>

            {/* Service type - topmate style */}
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">Choose service</Label>
            <div className="flex gap-2 mb-5">
              <ServiceButton icon={MessageCircle} label="Chat" price={bookingExpert.mentor_price_chat} color="bg-primary/10 border-primary text-primary" active={bookingType === "chat"} onClick={() => setBookingType("chat")} />
              <ServiceButton icon={Phone} label="Audio" price={bookingExpert.mentor_price_audio} color="bg-[hsl(var(--success))]/10 border-[hsl(var(--success))] text-[hsl(var(--success))]" active={bookingType === "audio"} onClick={() => setBookingType("audio")} />
              <ServiceButton icon={Video} label="Video" price={bookingExpert.mentor_price_video} color="bg-destructive/10 border-destructive text-destructive" active={bookingType === "video"} onClick={() => setBookingType("video")} />
            </div>

            {/* Duration */}
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block"><Clock className="w-3.5 h-3.5 inline mr-1" />Duration</Label>
            <div className="flex gap-2 mb-5">
              {DURATION_OPTIONS.map((d) => (
                <button key={d} onClick={() => setSelectedDuration(d)}
                  className={`flex-1 py-2.5 rounded-2xl text-xs font-semibold transition-all border-2 ${
                    selectedDuration === d ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:border-primary/30"
                  }`}>{d} min</button>
              ))}
            </div>

            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block"><Calendar className="w-3.5 h-3.5 inline mr-1" />Pick a Date</Label>
            <div className="flex gap-2 overflow-x-auto scrollbar-hide mb-5 pb-1">
              {nextDates.map((d) => {
                const date = new Date(d);
                return (
                  <button key={d} onClick={() => setSelectedDate(d)}
                    className={`flex-shrink-0 w-16 py-2.5 rounded-2xl text-center transition-all border-2 ${
                      selectedDate === d ? "bg-primary text-primary-foreground border-primary shadow-sm" : "bg-card text-foreground border-border hover:border-primary/30"
                    }`}>
                    <p className="text-[10px] font-medium">{date.toLocaleDateString("en", { weekday: "short" })}</p>
                    <p className="text-lg font-bold">{date.getDate()}</p>
                  </button>
                );
              })}
            </div>

            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block"><Clock className="w-3.5 h-3.5 inline mr-1" />Pick a Time</Label>
            <div className="grid grid-cols-4 gap-2 mb-5">
              {TIME_SLOTS.map((t) => (
                <button key={t} onClick={() => setSelectedTime(t)}
                  className={`py-2 rounded-xl text-[11px] font-semibold transition-all border ${
                    selectedTime === t ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:border-primary/30"
                  }`}>{t}</button>
              ))}
            </div>

            <div className="mb-5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">What would you like to discuss?</Label>
              <Textarea placeholder="Share your goal so the mentor can prepare…" value={bookingNotes} onChange={(e) => setBookingNotes(e.target.value)} className="bg-secondary border-border mt-2 rounded-2xl" rows={3} maxLength={1000} />
              <p className="mt-1 text-right text-[10px] text-muted-foreground">{bookingNotes.length}/1000</p>
            </div>

            <div className="mb-3 rounded-2xl border border-primary/15 bg-primary/5 p-3 text-xs text-muted-foreground">
              <ShieldCheck className="mr-1.5 inline h-4 w-4 text-primary" /> The mentor reviews this request before a private conversation is opened. Payment is not collected on this screen.
            </div>
            <Button className="w-full h-12 rounded-2xl text-sm font-bold gap-2" onClick={() => bookMutation.mutate()} disabled={bookMutation.isPending || !selectedDate || !selectedTime || bookingPrice === null}>
              {bookMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending request…</> : <><Sparkles className="w-4 h-4" /> Send request · ₹{bookingPrice ?? "—"}</>}
            </Button>
          </div>
        </div>
      )}

      {/* Sticky header */}
      <div className="flex-shrink-0 bg-background sticky top-0 z-10">
        <div className="px-4 pt-4 pb-2">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-foreground">Consult</h1>
              <p className="text-xs text-muted-foreground">Book 1:1 sessions with verified experts</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs bg-primary/10 text-primary px-2.5 py-1 rounded-full font-semibold">{experts?.length || 0} mentors</span>
            </div>
          </div>
        </div>

        {/* Tabs - topmate style */}
        <div className="px-4 py-1">
          <div className="max-w-5xl mx-auto flex gap-2">
            <button onClick={() => setActiveTab("mentors")}
              className={`flex-1 text-xs font-semibold py-2.5 rounded-full transition-all ${activeTab === "mentors" ? "bg-primary text-primary-foreground" : "bg-card border border-border text-muted-foreground"}`}>
              <Users className="w-3.5 h-3.5 inline mr-1" />Mentors
            </button>
            <button onClick={() => setActiveTab("bookings")}
              className={`flex-1 text-xs font-semibold py-2.5 rounded-full transition-all ${activeTab === "bookings" ? "bg-primary text-primary-foreground" : "bg-card border border-border text-muted-foreground"}`}>
              <Calendar className="w-3.5 h-3.5 inline mr-1" />My Bookings
              {(myBookings?.filter(b => b.status === "pending").length || 0) > 0 && (
                <span className="ml-1 bg-destructive text-destructive-foreground rounded-full px-1.5 text-[10px]">{myBookings?.filter(b => b.status === "pending").length}</span>
              )}
            </button>
          </div>
        </div>

        {activeTab === "mentors" && (
          <>
            <div className="px-4 py-2">
              <div className="max-w-5xl mx-auto relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder="Search by name, skill, or topic..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10 h-12 rounded-2xl bg-card border-border w-full" />
              </div>
            </div>
            <div className="px-4 py-2 overflow-x-auto scrollbar-hide">
              <div className="max-w-5xl mx-auto flex gap-2">
                {CATEGORIES.map((cat) => (
                  <button key={cat} onClick={() => setActiveCategory(cat)}
                    className={`text-xs font-semibold px-4 py-2 rounded-full whitespace-nowrap transition-all ${activeCategory === cat ? "bg-primary text-primary-foreground shadow-sm" : "bg-card border border-border text-muted-foreground hover:text-foreground hover:border-primary/30"}`}>
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Scrollable content */}
      <div className="native-scroll-region flex-1">
        <main className="max-w-5xl mx-auto px-4 py-4 space-y-4 pb-4">
          {activeTab === "bookings" && (
            <>
              {bookingsLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Loading your bookings…</div>
              ) : bookingsError ? (
                <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-center"><AlertCircle className="mx-auto h-8 w-8 text-destructive" /><p className="mt-2 text-sm font-semibold">Couldn’t load your bookings</p><Button variant="outline" size="sm" className="mt-3" onClick={() => void refetchBookings()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry</Button></div>
              ) : !myBookings?.length ? (
                <div className="text-center py-16">
                  <Calendar className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
                  <h3 className="font-bold text-foreground text-sm">No bookings yet</h3>
                  <p className="text-xs text-muted-foreground mt-1">Book a session with a mentor to get started</p>
                </div>
              ) : myBookings.map((booking: any) => (
                <div key={booking.id} className="bg-card border border-border rounded-2xl p-4 animate-fade-in">
                  <div className="flex items-center gap-3 mb-3">
                    {booking.otherProfile?.avatar_url ? (
                      <img src={booking.otherProfile.avatar_url} className="w-10 h-10 rounded-full object-cover" alt="" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <span className="text-sm font-bold text-primary">{getInitials(booking.otherProfile?.name)}</span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm text-foreground">{booking.otherProfile?.name || "User"}</p>
                      <p className="text-[10px] text-muted-foreground">{booking.isConsultant ? "Client" : "Mentor"} · {booking.consultation_type}</p>
                    </div>
                    <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${
                      booking.status === "pending" ? "bg-warning/10 text-warning" :
                      booking.status === "confirmed" ? "bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]" :
                      booking.status === "completed" ? "bg-primary/10 text-primary" :
                      "bg-destructive/10 text-destructive"
                    }`}>{booking.status}</span>
                  </div>
                  {booking.scheduled_at && (
                    <p className="text-xs text-muted-foreground mb-2">
                      📅 {new Date(booking.scheduled_at).toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" })} at {new Date(booking.scheduled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {booking.duration_minutes && ` · ${booking.duration_minutes}min`}
                    </p>
                  )}
                  {booking.notes && <p className="text-xs text-muted-foreground mb-2">💬 {booking.notes}</p>}
                  <p className="text-xs font-semibold text-foreground">₹{booking.amount || 0}</p>
                  {booking.isConsultant && booking.status === "pending" && (
                    <div className="flex gap-2 mt-3">
                      <Button size="sm" className="flex-1 rounded-xl h-8 text-xs" disabled={updateBookingStatus.isPending} onClick={() => updateBookingStatus.mutate({ id: booking.id, status: "confirmed" })}>Accept request</Button>
                      <Button size="sm" variant="outline" className="flex-1 rounded-xl h-8 text-xs" disabled={updateBookingStatus.isPending} onClick={() => updateBookingStatus.mutate({ id: booking.id, status: "cancelled" })}>Decline</Button>
                    </div>
                  )}
                  {!booking.isConsultant && ["pending", "confirmed"].includes(booking.status) && (
                    <Button size="sm" variant="outline" className="mt-3 h-8 w-full rounded-xl text-xs text-destructive" disabled={updateBookingStatus.isPending} onClick={() => updateBookingStatus.mutate({ id: booking.id, status: "cancelled" })}>Cancel booking</Button>
                  )}
                  {booking.isConsultant && booking.status === "confirmed" && booking.scheduled_at && new Date(booking.scheduled_at).getTime() <= Date.now() && (
                    <Button size="sm" variant="outline" className="mt-3 h-8 w-full rounded-xl text-xs" disabled={updateBookingStatus.isPending} onClick={() => updateBookingStatus.mutate({ id: booking.id, status: "completed" })}>Mark completed</Button>
                  )}
                  {booking.chat_room_id && booking.status === "confirmed" && (
                    <Button size="sm" className="mt-2 h-8 w-full rounded-xl text-xs" onClick={() => navigate(`/chats/${booking.chat_room_id}`)}><MessageCircle className="mr-1.5 h-3.5 w-3.5" /> Open private conversation</Button>
                  )}
                </div>
              ))}
            </>
          )}

          {activeTab === "mentors" && (
            <>
              <section className="grid grid-cols-3 gap-2 rounded-3xl border border-primary/15 bg-gradient-to-br from-primary/10 via-card to-card p-4 sm:gap-4 sm:p-5" aria-label="How Consult works">
                {["Choose a verified mentor", "Send a clear request", "Connect after acceptance"].map((step, index) => (
                  <div key={step} className="text-center sm:text-left"><span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{index + 1}</span><p className="mt-2 text-[11px] font-semibold leading-4 text-foreground sm:text-xs">{step}</p></div>
                ))}
              </section>
              {expertsLoading && (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Finding verified mentors…</div>
              )}
              {expertsError && (
                <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-center"><AlertCircle className="mx-auto h-8 w-8 text-destructive" /><p className="mt-2 text-sm font-semibold">Couldn’t load mentors</p><Button variant="outline" size="sm" className="mt-3" onClick={() => void refetchExperts()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry</Button></div>
              )}
              {!expertsLoading && !expertsError && (!experts || experts.length === 0) && !search && (
                <div className="text-center py-16">
                  <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <Users className="w-10 h-10 text-primary" />
                  </div>
                  <h3 className="font-bold text-foreground text-base">No mentors yet</h3>
                  <p className="text-sm text-muted-foreground mt-2">Be the first! Enable mentoring in your profile settings.</p>
                </div>
              )}

              {!expertsLoading && !expertsError && experts?.length === 0 && search && (
                <div className="py-14 text-center"><Search className="mx-auto h-9 w-9 text-muted-foreground/40" /><h3 className="mt-3 text-sm font-bold">No matching mentors</h3><p className="mt-1 text-xs text-muted-foreground">Try another name, skill or category.</p></div>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
              {displayExperts?.map((expert: any, i: number) => {
                const chatPrice = expert.mentor_price_chat;
                const audioPrice = expert.mentor_price_audio;
                const videoPrice = expert.mentor_price_video;
                const skills = expert.skills || [];

                return (
                  <article key={expert.user_id}
                    className="bg-card border border-border rounded-3xl p-5 hover-lift cursor-pointer animate-fade-in overflow-hidden"
                    style={{ animationDelay: `${i * 60}ms` }}
                    onClick={() => navigate(expert.slug ? `/u/${expert.slug}` : `/profile/${expert.user_id}`)}>
                    {/* Topmate-style header */}
                    <div className="flex items-start gap-3.5 mb-4">
                      {expert.avatar_url ? (
                        <img src={expert.avatar_url} alt={expert.name || ""} className="w-16 h-16 rounded-2xl object-cover flex-shrink-0 ring-2 ring-border" loading="lazy" />
                      ) : (
                        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <span className="text-2xl font-bold text-primary">{getInitials(expert.name)}</span>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h2 className="font-bold text-base text-foreground truncate">{expert.name || "Mentor"}</h2>
                          {expert.is_verified && <BadgeCheck className="w-4.5 h-4.5 text-primary flex-shrink-0" />}
                        </div>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{expert.headline || "Professional Mentor"}</p>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {expert.iit_name && <span className="text-[10px] bg-primary/10 text-primary px-2.5 py-0.5 rounded-full font-semibold">{expert.iit_name}</span>}
                          {expert.mentor_category && <span className="text-[10px] bg-secondary text-muted-foreground px-2.5 py-0.5 rounded-full font-medium">{expert.mentor_category}</span>}
                        </div>
                      </div>
                    </div>

                    {/* Bio snippet */}
                    {expert.bio && (
                      <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{expert.bio}</p>
                    )}

                    {/* Skills chips */}
                    {skills.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-4">
                        {skills.slice(0, 5).map((skill: string) => (
                          <span key={skill} className="text-[10px] bg-secondary text-muted-foreground px-2.5 py-1 rounded-full font-medium">{skill}</span>
                        ))}
                        {skills.length > 5 && <span className="text-[10px] text-muted-foreground px-1">+{skills.length - 5}</span>}
                      </div>
                    )}

                    {/* Topmate-style pricing buttons */}
                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                      {!user || !isVerified ? (
                        <div className="flex-1 flex gap-2 opacity-50 pointer-events-none">
                          <div className="flex-1 rounded-2xl py-2.5 px-3 flex items-center justify-center gap-1.5 pricing-chat"><MessageCircle className="w-3.5 h-3.5" /><span className="text-xs font-bold">₹{chatPrice || "-"}</span></div>
                          <div className="flex-1 rounded-2xl py-2.5 px-3 flex items-center justify-center gap-1.5 pricing-audio"><Phone className="w-3.5 h-3.5" /><span className="text-xs font-bold">₹{audioPrice || "-"}</span></div>
                          <div className="flex-1 rounded-2xl py-2.5 px-3 flex items-center justify-center gap-1.5 pricing-video"><Video className="w-3.5 h-3.5" /><span className="text-xs font-bold">₹{videoPrice || "-"}</span></div>
                        </div>
                      ) : (
                        <>
                          {chatPrice !== null && chatPrice !== undefined && (
                            <button onClick={() => { setBookingExpert(expert); setBookingType("chat"); }}
                              className="flex-1 rounded-2xl py-2.5 px-3 flex items-center justify-center gap-1.5 pricing-chat cursor-pointer hover:shadow-md transition-all hover-scale">
                              <MessageCircle className="w-3.5 h-3.5" /><span className="text-xs font-bold">₹{chatPrice}</span>
                            </button>
                          )}
                          {audioPrice !== null && audioPrice !== undefined && (
                            <button onClick={() => { setBookingExpert(expert); setBookingType("audio"); }}
                              className="flex-1 rounded-2xl py-2.5 px-3 flex items-center justify-center gap-1.5 pricing-audio cursor-pointer hover:shadow-md transition-all hover-scale">
                              <Phone className="w-3.5 h-3.5" /><span className="text-xs font-bold">₹{audioPrice}</span>
                            </button>
                          )}
                          {videoPrice !== null && videoPrice !== undefined && (
                            <button onClick={() => { setBookingExpert(expert); setBookingType("video"); }}
                              className="flex-1 rounded-2xl py-2.5 px-3 flex items-center justify-center gap-1.5 pricing-video cursor-pointer hover:shadow-md transition-all hover-scale">
                              <Video className="w-3.5 h-3.5" /><span className="text-xs font-bold">₹{videoPrice}</span>
                            </button>
                          )}
                          {chatPrice == null && audioPrice == null && videoPrice == null && (
                            <div className="flex-1 rounded-2xl border border-border bg-secondary/50 px-3 py-2.5 text-center text-xs font-semibold text-muted-foreground">Services not configured</div>
                          )}
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
              </div>

              {(!user || !isVerified) && (experts?.length || 0) > 0 && (
                <div className="relative rounded-2xl border border-border bg-card/60 backdrop-blur-sm p-8 text-center">
                  <Lock className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                  <h3 className="font-bold text-foreground text-sm">{!user ? "Sign In to Book" : "Unlock All Mentors"}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{!user ? "Sign in to see all mentors and book consultations." : "Verify your account to access all mentors."}</p>
                  <button onClick={() => navigate(!user ? "/auth" : "/iit-verify")} className="mt-4 px-6 py-2 bg-primary text-primary-foreground text-xs font-semibold rounded-full hover:opacity-90 transition-opacity">
                    {!user ? "Sign In" : "Verify Now"}
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
};

export default Consult;
