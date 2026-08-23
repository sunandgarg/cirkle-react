import { Navigate, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { saveResumeRoute } from "@/lib/sessionResume";

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, profile, loading } = useAuth();
  const location = useLocation();

  const canEnterApp = Boolean(profile?.is_verified && profile?.onboarding_completed);

  useEffect(() => {
    if (user?.id && canEnterApp) {
      saveResumeRoute(user.id, `${location.pathname}${location.search}${location.hash}`);
    }
  }, [canEnterApp, location.hash, location.pathname, location.search, user?.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  // Verification and onboarding are durable server-side states. No protected
  // route can bypass them, so a returning member always resumes the exact gate.
  if (!canEnterApp) {
    return <Navigate to="/iit-verify" replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
