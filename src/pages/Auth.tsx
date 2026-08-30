import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { readResumeRoute } from "@/lib/sessionResume";
import { applyThemePreference, readThemePreference, type ThemePreference } from "@/lib/theme";
import { Monitor, Moon, Sun } from "lucide-react";
import { readEdgeFunctionError } from "@/lib/edgeFunctionError";

const GoogleMark = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0">
    <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z" />
    <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.36l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.05v2.62A10 10 0 0 0 12 22Z" />
    <path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.05A10 10 0 0 0 2 12c0 1.61.38 3.14 1.05 4.55l3.34-2.62Z" />
    <path fill="#EA4335" d="M12 5.94c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.95 5.45l3.34 2.62C7.18 7.7 9.39 5.94 12 5.94Z" />
  </svg>
);

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "212611404330-csee4btkmuatmslubjb7fe3etek6f5ng.apps.googleusercontent.com";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
            nonce?: string;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
            context?: "signin" | "signup" | "use";
          }) => void;
          renderButton: (element: HTMLElement, options: {
            type: "standard";
            theme: "outline" | "filled_black";
            size: "large";
            text: "continue_with";
            shape: "rectangular";
            logo_alignment: "left";
            width: number;
          }) => void;
        };
      };
    };
  }
}


const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

const Auth = () => {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [authStep, setAuthStep] = useState<"email" | "otp">("email");
  const [authMethod, setAuthMethod] = useState<"otp" | "password">("otp");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoverySent, setRecoverySent] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [googleButtonReady, setGoogleButtonReady] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const googleNonceRef = useRef("");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, profile, loading: authLoading } = useAuth();

  useEffect(() => {
    applyThemePreference(theme);
  }, [theme]);

  useEffect(() => {
    if (searchParams.get("password_reset") !== "success") return;
    toast.success("Password updated. Sign in with your new password.");
    setAuthMethod("password");
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  // Redirect already-logged-in users
  useEffect(() => {
    if (!authLoading && user) {
      if (!profile?.is_verified || !profile?.onboarding_completed) {
        navigate("/iit-verify", { replace: true });
      } else {
        navigate(readResumeRoute(user.id), { replace: true });
      }
    }
  }, [user, profile?.is_verified, profile?.onboarding_completed, authLoading, navigate]);

  const handleEmailChange = (value: string) => {
    setEmail(value.trim().toLowerCase());
    setEmailSent(false);
    setOtp("");
  };

  const handleEmailContinue = async () => {
    if (!isValidEmail(email)) {
      toast.error("Please enter a valid email address");
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("request-login-otp", {
        body: {
          email,
          redirect_to: `${window.location.origin}/iit-verify`,
        },
      });
      if (error) {
        const parsed = await readEdgeFunctionError(error, data, "Could not send the email code. Please try again.");
        throw new Error(parsed.message);
      }
      if (data?.error) throw new Error(data.error);
      setEmailSent(true);
      setAuthStep("otp");
      toast.success("Verification code sent to your email");
    } catch (error: any) {
      toast.error(error.message || "Could not send email code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleCredential = useCallback(async (response: { credential?: string }) => {
    if (!response.credential) {
      toast.error("Google did not return a valid sign-in credential. Please try again.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithIdToken({
        provider: "google",
        token: response.credential,
        nonce: googleNonceRef.current || undefined,
      });
      if (error) throw error;
    } catch (error: any) {
      toast.error(error.message || "Google sign-in could not be completed. Please use email verification.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let initialized = false;
    let resizeTimer: number | undefined;

    const renderGoogleButton = () => {
      const target = googleButtonRef.current;
      if (cancelled || !initialized || !target || !window.google?.accounts.id) return;
      const width = Math.max(240, Math.min(400, Math.floor(target.clientWidth || 400)));
      target.replaceChildren();
      window.google.accounts.id.renderButton(target, {
        type: "standard",
        theme: document.documentElement.classList.contains("dark") ? "filled_black" : "outline",
        size: "large",
        text: "continue_with",
        shape: "rectangular",
        logo_alignment: "left",
        width,
      });
      setGoogleButtonReady(true);
    };

    const initializeGoogleButton = async () => {
      if (cancelled || !window.google?.accounts.id) return;
      const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
      const rawNonce = btoa(String.fromCharCode(...nonceBytes));
      const nonceHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawNonce));
      const hashedNonce = Array.from(new Uint8Array(nonceHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (cancelled || !window.google?.accounts.id) return;
      googleNonceRef.current = rawNonce;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCredential,
        nonce: hashedNonce,
        auto_select: false,
        cancel_on_tap_outside: true,
        context: "signin",
      });
      initialized = true;
      renderGoogleButton();
    };

    const onResize = () => {
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(renderGoogleButton, 120);
    };

    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    if (window.google?.accounts.id) {
      void initializeGoogleButton();
    } else if (existing) {
      existing.addEventListener("load", initializeGoogleButton, { once: true });
    } else {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", initializeGoogleButton, { once: true });
      script.addEventListener("error", () => {
        if (!cancelled) setGoogleButtonReady(false);
      }, { once: true });
      document.head.appendChild(script);
    }
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      existing?.removeEventListener("load", initializeGoogleButton);
    };
  }, [handleGoogleCredential, theme]);

  const handlePasswordLogin = async () => {
    if (!isValidEmail(email)) {
      toast.error("Please enter a valid email address");
      return;
    }
    if (!password) {
      toast.error("Please enter your password");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      toast.success("Signed in securely");
    } catch {
      toast.error("Email or password is incorrect. You can also use an email code.");
      setLoading(false);
    }
  };

  const openForgotPassword = () => {
    setRecoveryEmail(email);
    setRecoverySent(false);
    setShowForgotPassword(true);
  };

  const handleForgotPassword = async () => {
    const normalizedEmail = recoveryEmail.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      toast.error("Please enter a valid email address");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setRecoveryEmail(normalizedEmail);
      setRecoverySent(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      toast.error(message.includes("rate") ? "Too many requests. Please wait before trying again." : "Could not send the recovery email. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyEmailOtp = async () => {
    if (!isValidEmail(email) || otp.length !== 6) {
      toast.error("Enter the 6-digit code sent to your email");
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("verify-login-otp", {
        body: { email, code: otp },
      });
      if (error) {
        const parsed = await readEdgeFunctionError(error, data, "Could not verify this code. Request a new code and try again.");
        throw new Error(parsed.message);
      }
      if (!data?.session) throw new Error("Could not start your session. Please request a new code.");
      const { error: sessionError } = await supabase.auth.setSession(data.session);
      if (sessionError) throw sessionError;
      toast.success("Email verified");
      navigate("/iit-verify", { replace: true });
    } catch (error: any) {
      toast.error(error.message || "Could not verify the code. Please try again.");
      setLoading(false);
    }
  };

  const handleEditEmail = () => {
    setAuthStep("email");
    setOtp("");
    setEmailSent(false);
  };

  return (
    <div className="min-h-[100svh] bg-[#f5f7f9] text-[#10161e] supports-[height:100dvh]:min-h-[100dvh] dark:bg-[#0d0e10] dark:text-white lg:grid lg:grid-cols-[minmax(0,1.25fr)_minmax(430px,0.75fr)]">
      <div className="relative h-[38svh] min-h-[250px] max-h-[390px] overflow-hidden bg-[#dfe3e7] dark:bg-[#111214] lg:sticky lg:top-0 lg:h-[100dvh] lg:min-h-0 lg:max-h-none">
        <picture>
          <source media="(min-width: 1024px)" srcSet="/auth-community-landscape-v2.webp" />
          <img
            src="/auth-community-portrait-v2.webp"
            alt=""
            aria-hidden="true"
            fetchPriority="high"
            className="absolute inset-0 h-full w-full object-cover object-[center_20%] opacity-85 dark:opacity-100 lg:object-cover lg:object-center"
          />
        </picture>
        <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(245,247,249,0.02)_0%,rgba(245,247,249,0.12)_55%,#f5f7f9_100%)] dark:bg-[linear-gradient(to_bottom,rgba(13,14,16,0.04)_0%,rgba(13,14,16,0.14)_60%,#0d0e10_100%)] lg:bg-[linear-gradient(to_right,rgba(245,247,249,0.02)_0%,rgba(245,247,249,0.08)_55%,rgba(245,247,249,0.56)_100%)] lg:dark:bg-[linear-gradient(to_right,rgba(13,14,16,0.08)_0%,rgba(13,14,16,0.12)_55%,rgba(13,14,16,0.72)_100%)]" />
        <div className="absolute inset-x-8 bottom-10 hidden max-w-lg lg:block">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/55">The verified IIT network</p>
          <p className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.025em] text-white/90">Your campus community, without the noise.</p>
        </div>
      </div>
      <main
        id="main-content"
        className="relative z-10 -mt-5 flex min-h-[calc(62svh+20px)] w-full items-start rounded-t-[28px] bg-[#f5f7f9] px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-7 dark:bg-[#0d0e10] lg:mt-0 lg:min-h-[100dvh] lg:items-center lg:rounded-none lg:px-10 lg:py-12 xl:px-16"
      >
        <div className="absolute right-5 top-5 flex rounded-full border border-black/10 bg-white/80 p-1 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-[#1a1a22]/90" role="group" aria-label="Appearance">
          {([
            { value: "light", label: "Use light theme", icon: Sun },
            { value: "system", label: "Use device theme", icon: Monitor },
            { value: "dark", label: "Use dark theme", icon: Moon },
          ] as const).map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              aria-label={label}
              aria-pressed={theme === value}
              title={label}
              className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${theme === value ? "bg-[#10161e] text-white dark:bg-white dark:text-[#10161e]" : "text-[#637083] hover:bg-black/5 hover:text-[#10161e] dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white"}`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
        <section className="mx-auto w-full max-w-md" aria-labelledby="login-title">
          <div className="mb-6 hidden items-center gap-3 lg:flex">
            <img src="/cirkle-logo.png" alt="Cirkle" className="h-10 w-10 rounded-xl" />
            <div>
              <p className="text-lg font-bold tracking-[-0.02em]">Cirkle</p>
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#637083] dark:text-white/40">IIT Community</p>
            </div>
          </div>
          <h1 id="login-title" className="text-[30px] font-bold leading-9 tracking-[-0.025em] text-[#10161e] dark:text-white lg:text-4xl lg:leading-tight">
            Welcome
          </h1>
          <p className="mb-5 mt-1 text-sm leading-5 text-[#637083] dark:text-white/55 lg:text-base">
            Sign up or login to your account
          </p>

          <div className="relative h-12 w-full overflow-hidden rounded-xl" aria-busy={!googleButtonReady}>
            {!googleButtonReady && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-xl border border-black/10 bg-white text-base font-semibold text-[#10161e] shadow-sm dark:border-white/10 dark:bg-[#1a1a22] dark:text-white dark:shadow-none">
                <GoogleMark />
                Loading Google sign-in…
              </div>
            )}
            <div ref={googleButtonRef} className={`flex h-12 w-full justify-center [&>div]:!w-full [&_iframe]:!h-12 [&_iframe]:!w-full ${loading ? "pointer-events-none opacity-60" : ""}`} />
          </div>

          <div className="my-4 flex h-5 items-center gap-4 text-center text-sm leading-5 text-[#637083] dark:text-white/45">
            <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
            <span>Or</span>
            <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
          </div>

          {authStep === "email" ? (
            <>
              <Input
                id="email-address"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => handleEmailChange(e.target.value)}
                aria-label="Enter your email"
                className="h-12 w-full rounded-xl border-black/10 bg-white px-4 text-base text-[#10161e] shadow-sm placeholder:text-[#7b8796] focus-visible:border-[#1666b6]/70 focus-visible:ring-2 focus-visible:ring-[#1666b6]/15 dark:border-white/10 dark:bg-[#1a1a22] dark:text-white dark:shadow-none dark:placeholder:text-white/38 dark:focus-visible:border-[#75b7ff]/70 dark:focus-visible:ring-[#75b7ff]/15 sm:text-sm"
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  if (authMethod === "otp") handleEmailContinue();
                  else handlePasswordLogin();
                }}
              />

              {authMethod === "password" && (
                <div className="relative mt-3">
                  <Input
                    id="account-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-label="Enter your password"
                    className="h-12 w-full rounded-xl border-black/10 bg-white px-4 pr-16 text-base text-[#10161e] shadow-sm placeholder:text-[#7b8796] focus-visible:border-[#1666b6]/70 focus-visible:ring-2 focus-visible:ring-[#1666b6]/15 dark:border-white/10 dark:bg-[#1a1a22] dark:text-white dark:shadow-none dark:placeholder:text-white/38 dark:focus-visible:border-[#75b7ff]/70 dark:focus-visible:ring-[#75b7ff]/15 sm:text-sm"
                    onKeyDown={(event) => event.key === "Enter" && handlePasswordLogin()}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((current) => !current)}
                    className="absolute inset-y-0 right-3 text-xs font-semibold text-[#637083] hover:text-[#10161e] dark:text-white/55 dark:hover:text-white"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
              )}

              <p className="mb-2 mt-4 text-xs leading-4 text-[#637083] dark:text-white/45" aria-live="polite">
                {authMethod === "otp"
                  ? "We'll email a 6-digit secure code to verify this account."
                  : "Sign in with your existing account password."}
              </p>

              <Button
                size="lg"
                className="h-12 w-full rounded-xl bg-[#1666b6] px-8 text-base font-semibold text-white shadow-sm hover:bg-[#125a9f] disabled:bg-[#b8cce0] disabled:text-white/80 disabled:opacity-100 dark:bg-[#343438] dark:shadow-none dark:hover:bg-[#414146] dark:disabled:bg-[#242428] dark:disabled:text-white/35"
                onClick={authMethod === "otp" ? handleEmailContinue : handlePasswordLogin}
                disabled={loading || !isValidEmail(email) || (authMethod === "password" && !password)}
              >
                {loading
                  ? authMethod === "otp" ? "Sending code..." : "Signing in..."
                  : authMethod === "otp" ? "Send email code" : "Sign in"}
              </Button>

              <div className="mt-3 flex items-center justify-between gap-3 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod((current) => current === "otp" ? "password" : "otp");
                    setPassword("");
                  }}
                  className="text-left text-[#1666b6] underline-offset-2 hover:underline dark:text-[#75b7ff]"
                >
                  {authMethod === "otp" ? "Use password instead" : "Use email code"}
                </button>
                <button
                  type="button"
                  onClick={openForgotPassword}
                  className="text-right text-[#637083] underline-offset-2 hover:text-[#10161e] hover:underline dark:text-white/55 dark:hover:text-white"
                >
                  Forgot password?
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mb-4 text-sm leading-5 text-[#637083] dark:text-white/55" aria-live="polite">
                Enter the 6-digit code sent to <span className="font-semibold text-[#10161e] dark:text-white">{email}</span>
                <button type="button" onClick={handleEditEmail} className="ml-2 font-semibold text-[#1666b6] underline underline-offset-2 dark:text-[#75b7ff]">Change</button>
              </p>
              <div className="flex justify-center overflow-hidden">
                <InputOTP autoFocus maxLength={6} value={otp} onChange={setOtp}>
                  <InputOTPGroup className="gap-1.5 sm:gap-2">
                    {[0, 1, 2, 3, 4, 5].map((index) => (
                      <InputOTPSlot key={index} index={index} className="h-12 w-10 rounded-xl border-black/10 bg-white text-lg font-bold text-[#10161e] shadow-sm first:rounded-xl last:rounded-xl dark:border-white/10 dark:bg-[#1a1a22] dark:text-white dark:shadow-none sm:w-12" />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <Button
                size="lg"
                className="mt-4 h-12 w-full rounded-xl bg-[#1666b6] px-8 text-base font-semibold text-white shadow-sm hover:bg-[#125a9f] disabled:bg-[#b8cce0] disabled:text-white/80 disabled:opacity-100 dark:bg-[#343438] dark:shadow-none dark:hover:bg-[#414146] dark:disabled:bg-[#242428] dark:disabled:text-white/35"
                onClick={handleVerifyEmailOtp}
                disabled={loading || otp.length !== 6}
              >
                {loading ? "Verifying..." : "Verify email"}
              </Button>
              <button type="button" onClick={handleEmailContinue} disabled={loading} className="mt-3 w-full text-center text-xs font-semibold text-[#1666b6] disabled:opacity-50 dark:text-[#75b7ff]">
                {emailSent ? "Send a new code" : "Resend code"}
              </button>
            </>
          )}

          <p className="mt-5 text-center text-xs leading-4 text-[#637083] dark:text-white/45">
            By continuing, you agree to our{" "}
            <button onClick={() => setShowTerms(true)} className="font-medium text-[#495565] underline decoration-black/20 underline-offset-2 hover:text-[#10161e] dark:text-white/70 dark:decoration-white/30 dark:hover:text-white">T&C</button>
            {" "}&{" "}
            <button onClick={() => setShowPrivacy(true)} className="font-medium text-[#495565] underline decoration-black/20 underline-offset-2 hover:text-[#10161e] dark:text-white/70 dark:decoration-white/30 dark:hover:text-white">Privacy policy</button>
          </p>
        </section>
      </main>


      <Dialog open={showForgotPassword} onOpenChange={(open) => {
        setShowForgotPassword(open);
        if (!open) setRecoverySent(false);
      }}>
        <DialogContent className="w-[calc(100%_-_1.5rem)] max-w-md rounded-[24px] p-5 sm:p-6">
          <DialogHeader>
            <DialogTitle>{recoverySent ? "Check your email" : "Reset your password"}</DialogTitle>
            <DialogDescription>
              {recoverySent
                ? `If an account exists for ${recoveryEmail}, a secure reset link has been sent.`
                : "Enter your account email. We’ll send a secure, single-use password reset link."}
            </DialogDescription>
          </DialogHeader>
          {recoverySent ? (
            <div className="space-y-3 pt-2">
              <p className="text-sm text-muted-foreground">The link expires automatically. Also check your spam folder.</p>
              <Button className="h-11 w-full rounded-xl" onClick={() => setShowForgotPassword(false)}>Back to sign in</Button>
              <button
                type="button"
                className="w-full text-center text-xs font-semibold text-[#1666b6]"
                onClick={() => setRecoverySent(false)}
              >
                Use a different email
              </button>
            </div>
          ) : (
            <div className="space-y-3 pt-2">
              <label htmlFor="recovery-email" className="text-sm font-semibold text-[#10161e]">Email address</label>
              <Input
                id="recovery-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={recoveryEmail}
                onChange={(event) => setRecoveryEmail(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && handleForgotPassword()}
                className="h-11 rounded-xl"
              />
              <Button
                className="h-11 w-full rounded-xl"
                disabled={loading || !isValidEmail(recoveryEmail)}
                onClick={handleForgotPassword}
              >
                {loading ? "Sending secure link..." : "Send reset link"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>




      {/* Terms Dialog */}
      <Dialog open={showTerms} onOpenChange={setShowTerms}>
        <DialogContent className="max-h-[min(88dvh,720px)] w-[calc(100%_-_1.5rem)] max-w-md overflow-y-auto rounded-[24px] p-5 sm:p-6">
          <DialogHeader><DialogTitle>Terms & Conditions</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground space-y-3">
            <p><strong>1. Acceptance of Terms</strong><br />By accessing and using Cirkle, you agree to be bound by these Terms and Conditions.</p>
            <p><strong>2. User Account</strong><br />You must provide accurate information during registration. You are responsible for maintaining the confidentiality of your account.</p>
            <p><strong>3. Community Guidelines</strong><br />Users must maintain respectful communication. Harassment, spam, and inappropriate content are strictly prohibited.</p>
            <p><strong>4. Intellectual Property</strong><br />Content posted on Cirkle remains the property of the original creator. By posting, you grant Cirkle a non-exclusive license to display your content.</p>
            <p><strong>5. Privacy</strong><br />Your data is handled in accordance with our Privacy Policy. We do not sell personal data to third parties.</p>
            <p><strong>6. Termination</strong><br />Cirkle reserves the right to terminate accounts that violate these terms without prior notice.</p>
            <p><strong>7. Limitation of Liability</strong><br />Cirkle is provided "as is" without warranties. We are not liable for any indirect damages arising from use of the platform.</p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Privacy Dialog */}
      <Dialog open={showPrivacy} onOpenChange={setShowPrivacy}>
        <DialogContent className="max-h-[min(88dvh,720px)] w-[calc(100%_-_1.5rem)] max-w-md overflow-y-auto rounded-[24px] p-5 sm:p-6">
          <DialogHeader><DialogTitle>Privacy Policy</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground space-y-3">
            <p><strong>1. Data Collection</strong><br />We collect your email address, profile information, and usage data to provide our services.</p>
            <p><strong>2. Data Usage</strong><br />Your data is used to personalize your experience, facilitate connections, and improve our platform.</p>
            <p><strong>3. Data Sharing</strong><br />We do not sell your personal data. Information is shared only with your consent or as required by law.</p>
            <p><strong>4. Data Security</strong><br />We implement industry-standard security measures to protect your data including encryption and secure storage.</p>
            <p><strong>5. Your Rights</strong><br />You can access, update, or delete your personal data at any time through your profile settings.</p>
            <p><strong>6. Cookies</strong><br />We use cookies to enhance your browsing experience and analyze platform usage.</p>
            <p><strong>7. Contact</strong><br />For privacy-related inquiries, contact us at privacy@cirkle.world</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Auth;
