import { Navigate, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { saveResumeRoute } from "@/lib/sessionResume";
import { resolveMemberAccessState } from "@/lib/memberAccess";

const ProtectedRoute = ({ children, requireAdmin = false }: { children: React.ReactNode; requireAdmin?: boolean }) => {
  const { user, profile, loading, profileResolved, profileError, refetchProfile, isAdmin } = useAuth();
  const location = useLocation();

  const accessState = resolveMemberAccessState(profile, profileResolved);
  const canEnterApp = accessState === "ready";

  useEffect(() => {
    if (user?.id && canEnterApp) {
      saveResumeRoute(user.id, `${location.pathname}${location.search}${location.hash}`);
    }
  }, [canEnterApp, location.hash, location.pathname, location.search, user?.id]);

  if (loading || (user && accessState === "pending" && !profileError)) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  if (profileError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-xl font-bold text-foreground">Could not load your account</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{profileError}</p>
          <button
            type="button"
            onClick={() => { void refetchProfile().catch(() => undefined); }}
            className="mt-5 h-11 rounded-xl bg-primary px-6 font-semibold text-primary-foreground"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Verification and onboarding are durable server-side states. No protected
  // route can bypass them, so a returning member always resumes the exact gate.
  if (accessState === "verification" || accessState === "onboarding") {
    return <Navigate to="/iit-verify" replace />;
  }

  if (requireAdmin && !isAdmin) {
    return <Navigate to="/cirkle-forum" replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
