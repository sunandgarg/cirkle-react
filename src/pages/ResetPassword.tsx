import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type RecoveryState = "checking" | "ready" | "invalid" | "saving";

const passwordChecks = (password: string) => ({
  length: password.length >= 10,
  letter: /[A-Za-z]/.test(password),
  number: /\d/.test(password),
  maximum: password.length <= 128,
});

const ResetPassword = () => {
  const navigate = useNavigate();
  const [state, setState] = useState<RecoveryState>("checking");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const checks = useMemo(() => passwordChecks(password), [password]);
  const passwordValid = checks.length && checks.letter && checks.number && checks.maximum;
  const confirmationValid = confirmation.length > 0 && confirmation === password;

  useEffect(() => {
    let active = true;
    let invalidTimer: ReturnType<typeof setTimeout> | undefined;

    const markReady = () => {
      if (!active) return;
      if (invalidTimer) clearTimeout(invalidTimer);
      setState("ready");
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" && session) markReady();
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (!error && data.session) {
        markReady();
        return;
      }
      invalidTimer = setTimeout(() => active && setState("invalid"), 2500);
    });

    return () => {
      active = false;
      if (invalidTimer) clearTimeout(invalidTimer);
      subscription.unsubscribe();
    };
  }, []);

  const handleUpdatePassword = async () => {
    if (!passwordValid) {
      toast.error("Use at least 10 characters with a letter and a number");
      return;
    }
    if (!confirmationValid) {
      toast.error("Passwords do not match");
      return;
    }

    setState("saving");
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      await supabase.auth.signOut({ scope: "local" });
      navigate("/auth?password_reset=success", { replace: true });
    } catch (error: any) {
      toast.error(error?.message || "Could not update your password. Request a new reset link.");
      setState("ready");
    }
  };

  return (
    <div className="relative min-h-[100svh] overflow-hidden bg-[#f6f7f9] text-[#10161e] supports-[height:100dvh]:min-h-[100dvh]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[min(360px,38svh)] bg-no-repeat bg-top bg-[length:100%_auto]"
        style={{ backgroundImage: 'url("/auth-community-grid.jpg")' }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[min(360px,38svh)] bg-gradient-to-b from-transparent via-[#f6f7f9]/60 to-[#f6f7f9]" />
      <main id="main-content" className="relative z-10 flex min-h-[100svh] items-end justify-center px-5 pb-[max(28px,env(safe-area-inset-bottom))] pt-28 supports-[height:100dvh]:min-h-[100dvh] sm:items-center">
        <section className="w-full max-w-md rounded-[24px] border border-[#dfe3e8] bg-white/95 p-5 shadow-[0_18px_50px_rgba(16,22,30,0.10)] backdrop-blur sm:p-7" aria-labelledby="reset-title">
          {state === "checking" && (
            <div className="py-10 text-center" aria-live="polite">
              <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-[#1666b6] border-t-transparent" />
              <p className="mt-4 text-sm text-[#637083]">Verifying your secure reset link…</p>
            </div>
          )}

          {state === "invalid" && (
            <div className="py-4 text-center">
              <h1 id="reset-title" className="text-2xl font-bold">Reset link expired</h1>
              <p className="mt-2 text-sm leading-5 text-[#637083]">This link is invalid or has already been used. Request a new one from the sign-in screen.</p>
              <Button className="mt-5 h-11 w-full rounded-xl" onClick={() => navigate("/auth", { replace: true })}>Return to sign in</Button>
            </div>
          )}

          {(state === "ready" || state === "saving") && (
            <>
              <h1 id="reset-title" className="text-[28px] font-bold leading-9 tracking-[-0.02em]">Create a new password</h1>
              <p className="mb-5 mt-1 text-sm leading-5 text-[#637083]">Choose a unique password you don’t use anywhere else.</p>

              <label htmlFor="new-password" className="text-sm font-semibold">New password</label>
              <div className="relative mt-2">
                <Input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 rounded-xl pr-16"
                  maxLength={128}
                />
                <button type="button" onClick={() => setShowPassword((current) => !current)} className="absolute inset-y-0 right-3 text-xs font-semibold text-[#566273]">
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>

              <div className="my-3 grid grid-cols-2 gap-1 text-xs text-[#637083]" aria-live="polite">
                <span className={checks.length ? "text-emerald-700" : ""}>• 10+ characters</span>
                <span className={checks.letter ? "text-emerald-700" : ""}>• At least one letter</span>
                <span className={checks.number ? "text-emerald-700" : ""}>• At least one number</span>
                <span className={checks.maximum ? "text-emerald-700" : "text-red-600"}>• Maximum 128 characters</span>
              </div>

              <label htmlFor="confirm-password" className="text-sm font-semibold">Confirm password</label>
              <Input
                id="confirm-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && handleUpdatePassword()}
                className="mt-2 h-12 rounded-xl"
                maxLength={128}
                aria-invalid={confirmation.length > 0 && !confirmationValid}
              />
              {confirmation.length > 0 && !confirmationValid && <p className="mt-1 text-xs text-red-600">Passwords do not match.</p>}

              <Button
                className="mt-5 h-12 w-full rounded-xl bg-[#1666b6] text-base font-semibold hover:bg-[#125a9f]"
                disabled={state === "saving" || !passwordValid || !confirmationValid}
                onClick={handleUpdatePassword}
              >
                {state === "saving" ? "Updating password…" : "Update password"}
              </Button>
            </>
          )}
        </section>
      </main>
    </div>
  );
};

export default ResetPassword;
