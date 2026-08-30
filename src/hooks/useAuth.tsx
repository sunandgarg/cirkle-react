import { useState, useEffect, createContext, useContext, useCallback, ReactNode, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { clearChatCache } from "@/lib/chatCache";
import type { Tables } from "@/integrations/supabase/types";
import type { User } from "@supabase/supabase-js";

type Profile = Tables<"profiles">;

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  profileResolved: boolean;
  profileError: string | null;
  isAdmin: boolean;
  isVerified: boolean;
  refetchProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null, profile: null, loading: true, profileResolved: false, profileError: null,
  isAdmin: false, isVerified: false, refetchProfile: async () => {},
});

const fetchProfileAndAdmin = async (userId: string) => {
  const [stateRes, adminRes] = await Promise.all([
    (supabase as any).rpc("get_my_profile_state"),
    supabase.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
  ]);

  // Keep the direct read as a deployment-safe fallback while the migration is
  // rolling out. Once live, the RPC also repairs stale trusted verification.
  let profile = stateRes.data as Profile | null;
  if (stateRes.error) {
    const profileRes = await supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle();
    if (profileRes.error) throw profileRes.error;
    profile = profileRes.data;
  }
  if (adminRes.error) throw adminRes.error;
  return { profile, isAdmin: !!adminRes.data };
};

const fetchProfileWithRetry = async (userId: string) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchProfileAndAdmin(userId);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
};

const profileCacheKey = (userId: string) => `cirkle:profile:${userId}`;

const readCachedProfile = (userId: string): Profile | null => {
  try { return JSON.parse(localStorage.getItem(profileCacheKey(userId)) || "null") as Profile | null; }
  catch { return null; }
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileResolved, setProfileResolved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const initializedRef = useRef(false);
  const activeUserIdRef = useRef<string | null>(null);

  const isVerified = !!profile?.is_verified;

  const loadUserData = useCallback(async (u: User) => {
    activeUserIdRef.current = u.id;
    setUser(u);
    setLoading(true);
    setProfileResolved(false);
    setProfileError(null);
    const cachedProfile = readCachedProfile(u.id);
    setProfile(cachedProfile);
    setIsAdmin(false);
    try {
      const { profile: p, isAdmin: admin } = await fetchProfileWithRetry(u.id);
      if (activeUserIdRef.current !== u.id) return;
      setUser(u);
      setProfile(p);
      setIsAdmin(admin);
      setProfileResolved(true);
      if (p) localStorage.setItem(profileCacheKey(u.id), JSON.stringify(p));
    } catch (err) {
      if (activeUserIdRef.current !== u.id) return;
      // A read failure is not proof that a member is unverified. Preserve the
      // session and cache, but do not send the user back through verification.
      console.warn("Failed to resolve server account state, keeping session:", err);
      setUser(u);
      setProfileError("We could not load your account status. Check your connection and try again.");
    } finally {
      if (activeUserIdRef.current === u.id) {
        setLoading(false);
        initializedRef.current = true;
      }
    }
  }, []);

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") {
        activeUserIdRef.current = null;
        setUser(null);
        setProfile(null);
        setProfileResolved(true);
        setProfileError(null);
        setIsAdmin(false);
        setLoading(false);
        void clearChatCache();
        if ("caches" in window) {
          void caches.delete("cirkle-images-v1");
          void caches.delete("cirkle-images-v2");
        }
        return;
      }

      if (session?.user) {
        // A verified cached profile may render immediately. New/unverified
        // sessions wait for the authoritative profile to avoid briefly sending
        // returning members back through verification.
        setUser(session.user);
        const cachedProfile = readCachedProfile(session.user.id);
        setProfile(cachedProfile);
        setIsAdmin(false);
        // Cached state makes rendering fast, but routing always waits for the
        // authoritative server result on this device.
        setLoading(true);
        setProfileResolved(false);
        // Use setTimeout to avoid Supabase deadlock
        setTimeout(async () => {
          await loadUserData(session.user);
        }, 0);
      } else if (event === "INITIAL_SESSION" && !session) {
        activeUserIdRef.current = null;
        setProfileResolved(true);
        setLoading(false);
        initializedRef.current = true;
      }
    });

    // Then initialize
    const init = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (!session && !error) {
          setProfileResolved(true);
          setLoading(false);
          initializedRef.current = true;
        }
      } catch {
        // Network failure on init - don't force logout, just stop loading
        setLoading(false);
        initializedRef.current = true;
      }
    };
    init();

    return () => {
      subscription.unsubscribe();
    };
  }, [loadUserData]);

  const refetchProfile = useCallback(async () => {
    const currentUser = user;
    if (!currentUser) return;
    setProfileError(null);
    try {
      const { profile: p, isAdmin: admin } = await fetchProfileWithRetry(currentUser.id);
      if (activeUserIdRef.current !== currentUser.id) return;
      setProfile(p);
      setIsAdmin(admin);
      setProfileResolved(true);
      if (p) localStorage.setItem(profileCacheKey(currentUser.id), JSON.stringify(p));
    } catch (error) {
      if (activeUserIdRef.current !== currentUser.id) return;
      setProfileResolved(false);
      setProfileError("We could not load your account status. Check your connection and try again.");
      throw error;
    }
  }, [user]);

  useEffect(() => {
    if (!user?.id) return;
    const channel = supabase
      .channel(`member-profile:${user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const nextProfile = payload.new as Profile;
          setProfile(nextProfile);
          setProfileResolved(true);
          setProfileError(null);
          localStorage.setItem(profileCacheKey(user.id), JSON.stringify(nextProfile));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    const refresh = () => { void refetchProfile().catch(() => undefined); };
    const handleVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refetchProfile, user]);

  return (
    <AuthContext.Provider value={{ user, profile, loading, profileResolved, profileError, isAdmin, isVerified, refetchProfile }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
