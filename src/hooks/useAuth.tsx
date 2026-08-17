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
  isAdmin: boolean;
  isVerified: boolean;
  refetchProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null, profile: null, loading: true, isAdmin: false, isVerified: false, refetchProfile: async () => {},
});

const fetchProfileAndAdmin = async (userId: string) => {
  const [profileRes, adminRes] = await Promise.all([
    supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
  ]);
  if (profileRes.error) throw profileRes.error;
  return { profile: profileRes.data, isAdmin: !!adminRes.data };
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
  const [isAdmin, setIsAdmin] = useState(false);
  const initializedRef = useRef(false);

  const isVerified = !!profile?.is_verified;

  const loadUserData = useCallback(async (u: User) => {
    setUser(u);
    const cachedProfile = readCachedProfile(u.id);
    if (cachedProfile) setProfile(cachedProfile);
    try {
      const { profile: p, isAdmin: admin } = await fetchProfileAndAdmin(u.id);
      setUser(u);
      setProfile(p);
      setIsAdmin(admin);
      if (p) localStorage.setItem(profileCacheKey(u.id), JSON.stringify(p));
    } catch (err) {
      // Network error - keep existing user state, don't sign out
      console.warn("Failed to load user data, keeping session:", err);
      setUser(u);
    } finally {
      setLoading(false);
      initializedRef.current = true;
    }
  }, []);

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
        setProfile(null);
        setIsAdmin(false);
        setLoading(false);
        void clearChatCache();
        if ("caches" in window) void caches.delete("cirkle-images-v1");
        return;
      }

      if (session?.user) {
        // A verified cached profile may render immediately. New/unverified
        // sessions wait for the authoritative profile to avoid briefly sending
        // returning members back through verification.
        setUser(session.user);
        const cachedProfile = readCachedProfile(session.user.id);
        if (cachedProfile) setProfile(cachedProfile);
        setLoading(!cachedProfile?.is_verified);
        // Use setTimeout to avoid Supabase deadlock
        setTimeout(async () => {
          await loadUserData(session.user);
        }, 0);
      } else if (event === "INITIAL_SESSION" && !session) {
        setLoading(false);
        initializedRef.current = true;
      }
    });

    // Then initialize
    const init = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (!session && !error) {
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
    const { profile: p, isAdmin: admin } = await fetchProfileAndAdmin(currentUser.id);
    setProfile(p);
    setIsAdmin(admin);
    if (p) localStorage.setItem(profileCacheKey(currentUser.id), JSON.stringify(p));
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, profile, loading, isAdmin, isVerified, refetchProfile }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
