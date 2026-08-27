import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { readResumeRoute } from "@/lib/sessionResume";

const GoogleMark = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0">
    <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z" />
    <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.36l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.05v2.62A10 10 0 0 0 12 22Z" />
    <path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.05A10 10 0 0 0 2 12c0 1.61.38 3.14 1.05 4.55l3.34-2.62Z" />
    <path fill="#EA4335" d="M12 5.94c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.95 5.45l3.34 2.62C7.18 7.7 9.39 5.94 12 5.94Z" />
  </svg>
);


const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

const Auth = () => {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [authStep, setAuthStep] = useState<"email" | "otp">("email");
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const navigate = useNavigate();
  const { user, profile, loading: authLoading } = useAuth();

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
      const { error } = await supabase.functions.invoke("request-login-otp", {
        body: {
          email,
          redirect_to: `${window.location.origin}/iit-verify`,
        },
      });
      if (error) throw error;
      setEmailSent(true);
      setAuthStep("otp");
      toast.success("Verification code sent to your email");
    } catch (error: any) {
      toast.error(error.message || "Could not send email code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/iit-verify`,
          queryParams: {
            access_type: "offline",
            prompt: "select_account",
          },
        },
      });
      if (error) throw error;
    } catch (error: any) {
      setLoading(false);
      toast.error(error.message || "Google login is not available yet. Please try email verification.");
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
      if (error) throw error;
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
    <div className="relative min-h-[100svh] overflow-hidden bg-[#f6f7f9] text-[#10161e] supports-[height:100dvh]:min-h-[100dvh]">
      {/*
        This is deliberately a cropped, image-only version of the supplied
        mobile reference. It always renders once across the full viewport at
        its natural aspect ratio, preventing both desktop tile seams and
        stretched portraits on 4K displays.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[min(500px,48svh)] bg-no-repeat bg-top bg-[length:100%_auto] sm:h-[clamp(300px,45svh,480px)]"
        style={{ backgroundImage: 'url("/auth-community-grid.jpg")' }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[min(500px,48svh)] bg-[linear-gradient(to_bottom,rgba(246,247,249,0)_0%,rgba(246,247,249,0.08)_38%,rgba(246,247,249,0.72)_76%,#f6f7f9_100%)] sm:h-[clamp(300px,45svh,480px)]"
      />
      <main
        id="main-content"
        className="relative z-10 flex min-h-[100svh] w-full items-start px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-[min(45svh,470px)] supports-[height:100dvh]:min-h-[100dvh] sm:items-end sm:pt-0"
      >
        <section className="relative w-full bg-[#f6f7f9] before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-12 before:bg-gradient-to-t before:from-[#f6f7f9] before:to-transparent" aria-labelledby="login-title">
          <h1 id="login-title" className="text-[30px] font-bold leading-9 tracking-[-0.02em] text-[#10161e]">
            Welcome
          </h1>
          <p className="mb-4 mt-1 text-sm leading-5 text-[#637083]">
            Sign up or login to your account
          </p>

          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-12 w-full gap-2 rounded-xl border-[#d6dbe1] bg-[#e7ebee] p-0 text-base font-semibold text-[#10161e] shadow-none hover:bg-[#dfe5e9]"
            onClick={handleGoogleLogin}
            disabled={loading}
          >
            <GoogleMark />
            Google
          </Button>

          <div className="my-4 flex h-5 items-center gap-4 text-center text-sm leading-5 text-[#637083]">
            <span className="h-px flex-1 bg-[#d6dbe1]" />
            <span>Or</span>
            <span className="h-px flex-1 bg-[#d6dbe1]" />
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
                className="h-12 w-full rounded-xl border-[#d6dbe1] bg-[#e7ebee] px-3 text-base text-[#10161e] shadow-none placeholder:text-[#637083] focus-visible:border-[#1666b6] focus-visible:ring-2 focus-visible:ring-[#1666b6]/20 sm:text-sm"
                onKeyDown={(e) => e.key === "Enter" && handleEmailContinue()}
              />

              <p className="mb-2 mt-4 text-xs leading-4 text-[#637083]" aria-live="polite">
                We'll email a 6-digit secure code to verify this account.
              </p>

              <Button
                size="lg"
                className="h-12 w-full rounded-xl bg-[#1666b6] px-8 text-base font-semibold text-white shadow-none hover:bg-[#125a9f] disabled:opacity-50"
                onClick={handleEmailContinue}
                disabled={loading || !isValidEmail(email)}
              >
                {loading ? "Sending code..." : "Send email code"}
              </Button>
            </>
          ) : (
            <>
              <p className="mb-4 text-sm leading-5 text-[#637083]" aria-live="polite">
                Enter the 6-digit code sent to <span className="font-semibold text-[#10161e]">{email}</span>
                <button type="button" onClick={handleEditEmail} className="ml-2 font-semibold text-[#1666b6] underline underline-offset-2">Change</button>
              </p>
              <div className="flex justify-center overflow-hidden">
                <InputOTP autoFocus maxLength={6} value={otp} onChange={setOtp}>
                  <InputOTPGroup className="gap-1.5 sm:gap-2">
                    {[0, 1, 2, 3, 4, 5].map((index) => (
                      <InputOTPSlot key={index} index={index} className="h-12 w-10 rounded-xl border-[#d6dbe1] bg-[#e7ebee] text-lg font-bold text-[#10161e] first:rounded-xl last:rounded-xl sm:w-12" />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <Button
                size="lg"
                className="mt-4 h-12 w-full rounded-xl bg-[#1666b6] px-8 text-base font-semibold text-white shadow-none hover:bg-[#125a9f] disabled:opacity-50"
                onClick={handleVerifyEmailOtp}
                disabled={loading || otp.length !== 6}
              >
                {loading ? "Verifying..." : "Verify email"}
              </Button>
              <button type="button" onClick={handleEmailContinue} disabled={loading} className="mt-3 w-full text-center text-xs font-semibold text-[#1666b6] disabled:opacity-50">
                {emailSent ? "Send a new code" : "Resend code"}
              </button>
            </>
          )}

          <p className="mt-4 text-center text-xs leading-4 text-[#637083]">
            By continuing, you agree to our{" "}
            <button onClick={() => setShowTerms(true)} className="font-medium text-[#566273] underline underline-offset-2">T&C</button>
            {" "}&{" "}
            <button onClick={() => setShowPrivacy(true)} className="font-medium text-[#566273] underline underline-offset-2">Privacy policy</button>
          </p>
        </section>
      </main>




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
