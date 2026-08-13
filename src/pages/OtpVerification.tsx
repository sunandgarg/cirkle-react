import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "sonner";
import { ArrowLeft, Check, Clock3, ShieldCheck } from "lucide-react";
import { isMobileTestPhone, MOBILE_TEST_OTP, startMobileTestSession } from "@/lib/mobileVerification";

const SUPER_ADMIN_PHONE = "8700602524";

const OtpVerification = () => {
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendIn, setResendIn] = useState(30);
  const [authComplete, setAuthComplete] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, profile } = useAuth();
  const phone = (location.state as any)?.phone || "";
  const countryCode = (location.state as any)?.countryCode || "+91";

  // Once auth state propagates, route based on verification/onboarding status
  useEffect(() => {
    if (!authComplete || !user) return;
    // If profile not loaded yet, wait for it
    if (profile === undefined) return;
    if (!profile?.is_verified) {
      navigate("/iit-verify", { replace: true });
    } else if (!profile?.onboarding_completed) {
      // AppLayout will render the onboarding wizard
      navigate("/cirkle-forum", { replace: true });
    } else {
      navigate("/cirkle-forum", { replace: true });
    }
  }, [authComplete, user, profile, navigate]);

  const isTestMode = isMobileTestPhone(countryCode, phone);
  const maskedPhone = phone.length >= 4 ? `••••••${phone.slice(-4)}` : phone;

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setInterval(() => setResendIn((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  if (!phone) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
        <ShieldCheck className="w-16 h-16 text-primary mb-4" />
        <h1 className="text-xl font-bold text-foreground mb-2">Session Expired</h1>
        <p className="text-sm text-muted-foreground mb-6 text-center">Please go back and enter your phone number again.</p>
        <Button onClick={() => navigate("/auth")} className="rounded-xl">Go to Login</Button>
      </div>
    );
  }

  const handleVerify = async () => {
    if (otp.length !== 6) { toast.error("Please enter the full 6-digit OTP"); return; }

    if (!isTestMode) {
      // Production guard: hardcoded-password auth path is dev-only.
      toast.error("SMS verification is not available right now. Please try again later.");
      return;
    }
    if (otp !== MOBILE_TEST_OTP) { toast.error(`Invalid OTP. Use test code: ${MOBILE_TEST_OTP}`); return; }

    setLoading(true);
    try {
      const cleanPhone = phone.replace(/\D/g, "");
      const isSuperAdmin = cleanPhone === SUPER_ADMIN_PHONE;
      const fullPhone = `${countryCode}${cleanPhone}`;

      if (isTestMode) {
        startMobileTestSession(countryCode, cleanPhone);
        toast.success("Test account verified");
        window.location.assign("/cirkle-forum");
        return;
      }

      const { data, error } = await supabase.auth.verifyOtp({
        phone: fullPhone,
        token: otp,
        type: "sms",
      });
      if (error) throw error;
      const session = data.session;

      // Ensure the phone number is always present on the account metadata
      if (!(session?.user?.user_metadata as any)?.phone) {
        await supabase.auth.updateUser({ data: { phone: cleanPhone, phone_country_code: countryCode, phone_full: fullPhone } });
      }

      // If super admin, use ensure_super_admin RPC (non-blocking, runs with service role)
      if (isSuperAdmin && session?.user?.id) {
        supabase.rpc("ensure_super_admin", { p_user_id: session.user.id }).then(() => {});
      }


      toast.success("Verified successfully!");
      // Don't navigate directly - set flag and let useEffect handle it
      // once auth state propagates
      setAuthComplete(true);
    } catch (err: any) {
      console.error("Auth error:", err);
      toast.error(err.message || "Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendIn > 0 || resending) return;
    if (!isTestMode) {
      toast.error("SMS verification is not available right now. Please try again later.");
      return;
    }
    setResending(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({ phone: `${countryCode}${phone}` });
      if (error) throw error;
      setOtp("");
      setResendIn(30);
      toast.success("A new code has been sent");
    } catch (error: any) {
      toast.error(error.message || "Could not resend the code. Please try again.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="px-5 pt-5 pb-2">
        <button aria-label="Change mobile number" onClick={() => navigate("/auth")} className="w-11 h-11 -ml-2 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
          <ArrowLeft className="w-6 h-6" />
        </button>
      </div>
      <main className="flex-1 flex flex-col items-center px-5 pt-[7vh] pb-8">
        <div className="relative w-20 h-20 rounded-3xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-6 shadow-sm">
          <ShieldCheck className="w-9 h-9 text-primary" />
          <span className="absolute -right-1 -bottom-1 w-7 h-7 rounded-full bg-primary text-primary-foreground border-4 border-background flex items-center justify-center">
            <Check className="w-3.5 h-3.5" strokeWidth={3} />
          </span>
        </div>
        <h1 className="text-[28px] leading-tight font-bold tracking-tight text-foreground text-center">Enter your code</h1>
        <p className="text-sm leading-6 text-muted-foreground mt-2 text-center max-w-sm">
          We sent a 6-digit verification code to<br />
          <span className="text-foreground font-semibold">{countryCode} {maskedPhone}</span>
          <button onClick={() => navigate("/auth")} className="ml-2 text-primary font-semibold hover:underline">Change</button>
        </p>
        {isTestMode && (
          <button onClick={() => setOtp(MOBILE_TEST_OTP)} className="mt-6 w-full max-w-sm bg-primary/10 border border-primary/20 rounded-2xl px-4 py-3.5 text-center hover:bg-primary/15 active:scale-[0.99] transition-all">
            <span className="block text-[11px] uppercase tracking-[0.14em] text-primary font-bold">Test mode · tap to use code</span>
            <span className="block text-xl font-mono font-bold text-foreground tracking-[0.35em] mt-1 pl-[0.35em]">{MOBILE_TEST_OTP}</span>
          </button>
        )}
        <div className="mt-7 w-full flex justify-center">
          <InputOTP autoFocus maxLength={6} value={otp} onChange={setOtp}>
            <InputOTPGroup className="gap-1.5 sm:gap-3">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <InputOTPSlot key={index} index={index} className="w-10 sm:w-12 h-14 text-xl font-bold text-foreground bg-secondary border-border rounded-xl first:rounded-xl last:rounded-xl" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        <Button size="lg" className="w-full max-w-sm h-12 text-base font-semibold rounded-xl mt-7 shadow-sm" onClick={handleVerify} disabled={loading || otp.length !== 6}>
          {loading ? "Checking code..." : "Verify and continue"}
        </Button>
        <div className="h-10 mt-4 flex items-center justify-center text-sm">
          {resendIn > 0 ? (
            <span className="text-muted-foreground flex items-center gap-1.5"><Clock3 className="w-4 h-4" /> Resend code in {resendIn}s</span>
          ) : (
            <button onClick={handleResend} disabled={resending} className="text-primary font-semibold hover:underline disabled:opacity-60">
              {resending ? "Sending new code..." : "Didn't get it? Resend code"}
            </button>
          )}
        </div>
        <p className="mt-auto pt-8 text-xs text-muted-foreground text-center max-w-xs">Your code is private. Cirkle will never ask you to share it.</p>
      </main>
    </div>
  );
};

export default OtpVerification;
