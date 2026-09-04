import {
  ArrowLeft, BookOpen, ChevronRight, Database, ExternalLink, KeyRound, LogOut,
  Mail, MessagesSquare, Moon, Phone, Settings2, ShieldCheck, Smartphone, Sun,
  UserRound, UsersRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { clearChatCache } from "@/lib/chatCache";
import { clearForumHistoryCache } from "@/lib/forumHistoryCache";
import { clearMobileTestSession } from "@/lib/mobileVerification";
import { applyThemePreference, readThemePreference, type ThemePreference } from "@/lib/theme";

const SettingsRow = ({ icon: Icon, label, description, onClick }: {
  icon: typeof UserRound;
  label: string;
  description?: string;
  onClick: () => void;
}) => (
  <button type="button" onClick={onClick} className="flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3.5 text-left transition-colors last:border-0 hover:bg-muted/30">
    <span className="flex min-w-0 items-center gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-secondary"><Icon className="h-4 w-4 text-muted-foreground" /></span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description && <span className="block truncate text-[11px] text-muted-foreground">{description}</span>}
      </span>
    </span>
    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
  </button>
);

const Settings = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, profile } = useAuth();
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const section = location.pathname.endsWith("/account") ? "account" : location.pathname.endsWith("/privacy") ? "privacy" : "general";

  useEffect(() => { applyThemePreference(theme); }, [theme]);

  const handleLogout = async () => {
    clearMobileTestSession();
    await supabase.auth.signOut({ scope: "local" });
    navigate("/");
  };

  const { data: isAdmin } = useQuery({
    queryKey: ["is-admin", user?.id],
    queryFn: async () => {
      if (!user) return false;
      const { data } = await supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin");
      return (data && data.length > 0) || profile?.role === "admin";
    },
    enabled: !!user,
  });

  const changePassword = async () => {
    if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      toast.error("Use at least 10 characters with a letter and number");
      return;
    }
    if (password !== confirmation) {
      toast.error("Passwords do not match");
      return;
    }
    setSavingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password updated. Sign in again on this device.");
      clearMobileTestSession();
      await supabase.auth.signOut({ scope: "local" });
      navigate("/auth?password_reset=success", { replace: true });
    } catch (error: any) {
      toast.error(error?.message || "Password could not be updated");
    } finally {
      setSavingPassword(false);
    }
  };

  const clearDeviceCache = async () => {
    if (!user?.id || clearingCache) return;
    setClearingCache(true);
    try {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.includes(user.id)) localStorage.removeItem(key);
      }
      await Promise.all([clearChatCache(), clearForumHistoryCache()]);
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.filter((name) => name.startsWith("cirkle-")).map((name) => caches.delete(name)));
      }
      toast.success("Cached Cirkle data was cleared from this device");
    } catch {
      toast.error("Some cached data could not be cleared");
    } finally {
      setClearingCache(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 bg-card px-4 py-4">
        <div className="mx-auto flex max-w-lg items-center justify-between">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => section === "general" ? navigate(-1) : navigate("/settings")} className="p-1 text-foreground hover-scale" aria-label="Go back">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-foreground">{section === "account" ? "Account & security" : section === "privacy" ? "Privacy" : "Settings"}</h1>
              {section !== "general" && <p className="text-[11px] text-muted-foreground">Settings for {user?.email || "your account"}</p>}
            </div>
          </div>
          <button type="button" onClick={() => void handleLogout()} className="p-2 text-destructive hover-scale" aria-label="Sign out">
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-4">
        {section === "account" ? (
          <div className="space-y-6">
            <section aria-labelledby="account-details-title">
              <h2 id="account-details-title" className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Account details</h2>
              <div className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-secondary"><Mail className="h-4 w-4 text-muted-foreground" /></span>
                  <div className="min-w-0"><p className="text-xs text-muted-foreground">Signed-in email</p><p className="truncate text-sm font-medium text-foreground">{user?.email || "Unavailable"}</p></div>
                </div>
              </div>
            </section>

            <section aria-labelledby="password-title">
              <h2 id="password-title" className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Change password</h2>
              <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
                <p className="text-xs leading-5 text-muted-foreground">Changing your password signs out existing sessions. Use at least 10 characters with a letter and number.</p>
                <div><Label htmlFor="new-account-password">New password</Label><Input id="new-account-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1.5" /></div>
                <div><Label htmlFor="confirm-account-password">Confirm new password</Label><Input id="confirm-account-password" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-1.5" /></div>
                <Button type="button" className="w-full rounded-xl" disabled={savingPassword || !password || !confirmation} onClick={() => void changePassword()}>
                  <KeyRound className="mr-2 h-4 w-4" />{savingPassword ? "Updating…" : "Update password"}
                </Button>
              </div>
            </section>
          </div>
        ) : section === "privacy" ? (
          <div className="space-y-6">
            <section aria-labelledby="privacy-controls-title">
              <h2 id="privacy-controls-title" className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Device privacy</h2>
              <div className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-secondary"><Database className="h-4 w-4 text-muted-foreground" /></span>
                  <div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">Cached app data</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">Remove locally cached chats, Forum history, drafts and images. Your server data and active login are not deleted.</p></div>
                </div>
                <Button type="button" variant="outline" className="mt-4 w-full rounded-xl" disabled={clearingCache} onClick={() => void clearDeviceCache()}>{clearingCache ? "Clearing…" : "Clear cached data"}</Button>
              </div>
            </section>
            <section aria-labelledby="privacy-resources-title">
              <h2 id="privacy-resources-title" className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Your data</h2>
              <div className="overflow-hidden rounded-2xl border border-border bg-card">
                <SettingsRow icon={ShieldCheck} label="Read privacy policy" onClick={() => navigate("/privacy")} />
                <a href="mailto:privacy@cirkle.world" className="flex w-full items-center justify-between gap-3 px-4 py-3.5 hover:bg-muted/30">
                  <span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-secondary"><Mail className="h-4 w-4 text-muted-foreground" /></span><span><span className="block text-sm font-medium text-foreground">Request or delete account data</span><span className="block text-[11px] text-muted-foreground">privacy@cirkle.world</span></span></span>
                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                </a>
              </div>
            </section>
          </div>
        ) : (
          <>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">General</h2>
            <div className="mb-6 overflow-hidden rounded-2xl border border-border bg-card">
              <div className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-secondary"><Sun className="h-4 w-4 text-muted-foreground" /></span><span className="text-sm font-medium text-foreground">Theme</span></div>
                <div className="flex overflow-hidden rounded-lg bg-secondary" role="group" aria-label="Theme preference">
                  {(["light", "dark", "system"] as const).map((value) => (
                    <button key={value} type="button" onClick={() => setTheme(value)} aria-label={`${value[0].toUpperCase()}${value.slice(1)} theme`} aria-pressed={theme === value} title={`${value} theme`} className={`p-2 transition-colors ${theme === value ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                      {value === "light" && <Sun className="h-4 w-4" />}{value === "dark" && <Moon className="h-4 w-4" />}{value === "system" && <Smartphone className="h-4 w-4" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Account settings</h2>
            <div className="mb-6 overflow-hidden rounded-2xl border border-border bg-card">
              <SettingsRow icon={UserRound} label="Edit profile" onClick={() => navigate("/profile")} />
              <SettingsRow icon={KeyRound} label="Account & security" description={user?.email} onClick={() => navigate("/settings/account")} />
              <SettingsRow icon={ShieldCheck} label="Privacy" description="Cached data and privacy requests" onClick={() => navigate("/settings/privacy")} />
            </div>

            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Community</h2>
            <div className="mb-6 overflow-hidden rounded-2xl border border-border bg-card">
              <SettingsRow icon={UsersRound} label="Connections" onClick={() => navigate("/network/connections")} />
              <SettingsRow icon={MessagesSquare} label="Messages" onClick={() => navigate("/chats")} />
              <SettingsRow icon={Phone} label="Consultation bookings" onClick={() => navigate("/consult/bookings")} />
            </div>

            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Content</h2>
            <div className="mb-6 overflow-hidden rounded-2xl border border-border bg-card"><SettingsRow icon={BookOpen} label="Blogs" onClick={() => navigate("/blogs")} /></div>

            {isAdmin && <><h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Administration</h2><div className="mb-6 overflow-hidden rounded-2xl border border-border bg-card"><SettingsRow icon={Settings2} label="Admin panel" onClick={() => navigate("/admin")} /></div></>}
          </>
        )}
      </main>
    </div>
  );
};

export default Settings;
