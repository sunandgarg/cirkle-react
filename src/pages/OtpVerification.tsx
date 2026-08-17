import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "sonner";
import { ArrowLeft, Check, Clock3, ShieldCheck } from "lucide-react";
import { readResumeRoute } from "@/lib/sessionResume";

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
    if (!profile?.is_verified || !profile?.onboarding_completed) {
      navigate("/iit-verify", { replace: true });
    } else {
      navigate(readResumeRoute(user.id), { replace: true });
    }
  }, [authComplete, user, profile, navigate]);

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

    setLoading(true);
    try {
      const cleanPhone = phone.replace(/\D/g, "");
      const fullPhone = `${countryCode}${cleanPhone}`;

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
    <div className="onboarding-shell">
      <header className="onboarding-topbar">
        <button aria-label="Change mobile number" onClick={() => navigate("/auth")} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          <ArrowLeft className="w-6 h-6" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-foreground">Secure verification</p>
          <p className="text-[11px] text-muted-foreground">Step 2 of 2 · mobile</p>
        </div>
        <ShieldCheck className="h-5 w-5 text-primary" />
      </header>
      <main className="onboarding-scroll flex items-center">
        <section className="onboarding-stage text-center" aria-labelledby="otp-title">
        <div className="relative mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[26px] border border-primary/20 bg-gradient-to-br from-primary/15 to-primary/5 shadow-[0_18px_45px_-24px_hsl(var(--primary))]">
          <ShieldCheck className="w-9 h-9 text-primary" />
          <span className="absolute -right-1 -bottom-1 w-7 h-7 rounded-full bg-primary text-primary-foreground border-4 border-background flex items-center justify-center">
            <Check className="w-3.5 h-3.5" strokeWidth={3} />
          </span>
        </div>
        <h1 id="otp-title" className="text-[28px] leading-tight font-black tracking-tight text-foreground">Enter your code</h1>
        <p className="text-sm leading-6 text-muted-foreground mt-2 text-center max-w-sm">
          We sent a 6-digit verification code to<br />
          <span className="text-foreground font-semibold">{countryCode} {maskedPhone}</span>
          <button onClick={() => navigate("/auth")} className="ml-2 text-primary font-semibold hover:underline">Change</button>
        </p>
        <div className="mt-6 flex w-full justify-center overflow-hidden">
          <InputOTP autoFocus maxLength={6} value={otp} onChange={setOtp}>
            <InputOTPGroup className="gap-1 sm:gap-3">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <InputOTPSlot key={index} index={index} className="h-[52px] w-10 rounded-xl border-border bg-secondary text-xl font-bold text-foreground first:rounded-xl last:rounded-xl sm:h-14 sm:w-12" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        <Button size="lg" className="mt-6 h-12 w-full max-w-sm rounded-xl text-base font-bold shadow-[0_14px_30px_-16px_hsl(var(--primary))]" onClick={handleVerify} disabled={loading || otp.length !== 6}>
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
        <p className="mx-auto mt-5 max-w-xs text-center text-xs text-muted-foreground">Your code is private. Cirkle will never ask you to share it.</p>
        </section>
      </main>
    </div>
  );
};

export default OtpVerification;
