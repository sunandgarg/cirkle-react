import { ArrowLeft, LogOut, ChevronRight, Sun, Moon, Smartphone, UserRound, UsersRound, MessagesSquare, Phone, Settings2, BookOpen } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { clearMobileTestSession } from "@/lib/mobileVerification";
import { applyThemePreference, readThemePreference, type ThemePreference } from "@/lib/theme";

const Settings = () => {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    applyThemePreference(theme);
  }, [theme]);

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

  return (
    <div className="bg-background min-h-screen">
      <header className="sticky top-0 z-40 bg-card px-4 py-4">
        <div className="flex items-center justify-between max-w-lg mx-auto">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-1 text-foreground hover-scale" aria-label="Go back">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-xl font-bold text-foreground">Settings</h1>
          </div>
          <button onClick={handleLogout} className="p-2 text-destructive hover-scale" aria-label="Sign out">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-4">
        {/* General */}
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">General</p>
        <div className="bg-card border border-border rounded-2xl overflow-hidden mb-6">
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center"><Sun className="w-4 h-4 text-muted-foreground" /></div>
              <span className="text-sm font-medium text-foreground">Theme</span>
            </div>
            <div className="flex bg-secondary rounded-lg overflow-hidden">
              {(["light", "dark", "system"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`p-2 transition-colors ${theme === t ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {t === "light" && <Sun className="w-4 h-4" />}
                  {t === "dark" && <Moon className="w-4 h-4" />}
                  {t === "system" && <Smartphone className="w-4 h-4" />}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Account Settings */}
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">Account Settings</p>
        <div className="bg-card border border-border rounded-2xl overflow-hidden mb-6">
          <button onClick={() => navigate("/profile")} className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center"><UserRound className="w-4 h-4 text-muted-foreground" /></div>
              <span className="text-sm font-medium text-foreground">Edit Profile</span>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Community */}
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">Community</p>
        <div className="bg-card border border-border rounded-2xl overflow-hidden mb-6">
          {[
            { icon: UsersRound, label: "Connections", path: "/network/connections" },
            { icon: MessagesSquare, label: "Messages", path: "/chats" },
            { icon: Phone, label: "Consultation Bookings", path: "/consult/bookings" },
          ].map((item, i, arr) => (
            <button key={item.label} onClick={() => navigate(item.path)} className={`w-full flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors ${i < arr.length - 1 ? "border-b border-border" : ""}`}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center"><item.icon className="w-4 h-4 text-muted-foreground" /></div>
                <span className="text-sm font-medium text-foreground">{item.label}</span>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </button>
          ))}
        </div>

        {/* Content */}
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">Content</p>
        <div className="bg-card border border-border rounded-2xl overflow-hidden mb-6">
          <button onClick={() => navigate("/blogs")} className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center"><BookOpen className="w-4 h-4 text-muted-foreground" /></div>
              <span className="text-sm font-medium text-foreground">Blogs</span>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Admin */}
        {isAdmin && (
          <>
            <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">Administration</p>
            <div className="bg-card border border-border rounded-2xl overflow-hidden mb-6">
              <button onClick={() => navigate("/admin")} className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center"><Settings2 className="w-4 h-4 text-muted-foreground" /></div>
                  <span className="text-sm font-medium text-foreground">Admin Panel</span>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default Settings;
