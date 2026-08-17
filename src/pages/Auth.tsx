import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CountryCodeSelect, { COUNTRY_CODES, type CountryOption } from "@/components/CountryCodeSelect";
import { readResumeRoute } from "@/lib/sessionResume";


const isValidPhone = (digits: string) => digits.length === 10;

const Auth = () => {
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [country, setCountry] = useState<CountryOption>(COUNTRY_CODES[0]);
  const navigate = useNavigate();
  const { user, profile, loading: authLoading } = useAuth();

  // Redirect already-logged-in users
  useEffect(() => {
    if (!authLoading && user) {
      if (!(user.user_metadata as any)?.phone) {
        navigate("/phone-verify", { replace: true });
      } else if (!profile?.is_verified || !profile?.onboarding_completed) {
        navigate("/iit-verify", { replace: true });
      } else {
        navigate(readResumeRoute(user.id), { replace: true });
      }
    }
  }, [user, profile?.is_verified, profile?.onboarding_completed, authLoading, navigate]);

  const handlePhoneChange = (value: string) => {
    setPhone(value.replace(/\D/g, "").slice(0, 10));
  };

  const handleContinue = async () => {
    if (!isValidPhone(phone)) {
      toast.error("Please enter a valid 10-digit mobile number");
      return;
    }
    setLoading(true);
    try {
      const fullPhone = `${country.code}${phone}`;
      const { error } = await supabase.auth.signInWithOtp({
        phone: fullPhone,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;
      navigate("/otp-verify", { state: { phone, countryCode: country.code } });
    } catch (error: any) {
      toast.error(error.message || "Could not start mobile verification. Please try again.");
      setLoading(false);
    }
  };

  const handleGoogleContinue = async () => {
    setLoading(true);
    try {
      const redirect_uri = `${window.location.origin}/phone-verify`;
      const result = await lovable.auth.signInWithOAuth("google", { redirect_uri });
      if (result.error) throw result.error;
      if (!result.redirected) {
        navigate("/phone-verify", { replace: true });
      }
    } catch (error: any) {
      toast.error(error.message || "Could not continue with Google. Please try again.");
      setLoading(false);
    }
  };


  return (
    <div className="relative min-h-[100dvh] overflow-hidden bg-[#f7f9fc] text-foreground" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[52dvh] min-h-[430px] bg-[url('/auth-community-bg.jpg')] bg-[length:100%_auto] bg-top bg-no-repeat opacity-90 grayscale sm:h-[46dvh] sm:min-h-[360px] sm:bg-cover lg:h-[45dvh] lg:min-h-[430px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[67dvh] min-h-[560px] bg-gradient-to-b from-[#111827]/50 via-[#f7f9fc]/76 to-[#f7f9fc] sm:h-[58dvh] sm:min-h-[500px] lg:h-[58dvh]"
      />

      <main className="relative z-10 min-h-[100dvh] w-full px-8 pb-[max(18px,env(safe-area-inset-bottom))] pt-[50dvh] sm:px-8 sm:pt-[45dvh] lg:px-8">
        <section className="w-full" aria-labelledby="login-title">
          <h1 id="login-title" className="text-[36px] font-black leading-none tracking-normal text-[#111827] sm:text-[38px] lg:text-[36px]">
            Welcome
          </h1>
          <p className="mt-2 text-[19px] leading-7 tracking-normal text-slate-500 sm:text-[20px] lg:text-[20px]">
            Sign up or login to your account
          </p>

          <div className="mt-5 flex items-center gap-3 sm:mt-6 sm:gap-3">
            <CountryCodeSelect
              value={country}
              onChange={setCountry}
              className="h-14 rounded-2xl border-[#d5dbe4] bg-[#eaf0f5] px-4 shadow-sm hover:bg-[#e4ebf1] sm:h-[68px] sm:rounded-[18px] sm:px-5 [&>span:first-child]:text-xl [&>span:nth-child(2)]:text-lg [&>svg]:h-4 [&>svg]:w-4"
            />
            <Input
              id="mobile-number"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="Enter 10-digit number"
              value={phone}
              onChange={(e) => handlePhoneChange(e.target.value)}
              className="h-14 min-w-0 flex-1 rounded-2xl border-[#d5dbe4] bg-[#eaf0f5] px-4 text-[20px] tracking-normal text-[#111827] shadow-sm placeholder:text-slate-500 focus:border-primary sm:h-[68px] sm:rounded-[18px] sm:px-5 sm:text-[20px]"
              onKeyDown={(e) => e.key === "Enter" && handleContinue()}
              maxLength={10}
            />
          </div>

          <div className={`mt-3 text-[16px] tracking-normal tabular-nums sm:mt-4 sm:text-[18px] ${isValidPhone(phone) ? "text-[hsl(var(--success))]" : "text-slate-500"}`}>
            {phone.length}/10 digits
          </div>

          <Button
            size="lg"
            className="mt-3 h-14 w-full rounded-2xl bg-[#83b3df] text-[20px] font-bold tracking-normal text-white shadow-none hover:bg-[#6ca4d7] disabled:opacity-70 sm:mt-4 sm:h-[68px] sm:rounded-[18px] sm:text-[22px]"
            onClick={handleContinue}
            disabled={loading || !isValidPhone(phone)}
          >
            {loading ? "Sending code..." : "Continue"}
          </Button>

          <div className="my-4 flex items-center gap-7 text-center text-[18px] tracking-normal text-slate-500 sm:my-8 sm:text-[20px]">
            <span className="h-px flex-1 bg-slate-300" />
            <span>Or</span>
            <span className="h-px flex-1 bg-slate-300" />
          </div>

          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-14 w-full gap-4 rounded-2xl border-[#d5dbe4] bg-[#eaf0f5] text-[18px] font-semibold tracking-normal text-[#111827] shadow-sm hover:bg-[#e4ebf1] sm:h-[68px] sm:rounded-[18px] sm:text-[20px]"
            onClick={handleGoogleContinue}
            disabled={loading}
          >
            <span className="text-[28px] font-black leading-none text-[#4285f4]">G</span>
            Google
          </Button>

          <p className="mt-4 text-center text-[15px] leading-6 tracking-normal text-slate-500 sm:mt-6 sm:text-[17px]">
            By continuing, you agree to our{" "}
            <button onClick={() => setShowTerms(true)} className="font-medium text-slate-600 underline underline-offset-4">T&C</button>
            {" "}&{" "}
            <button onClick={() => setShowPrivacy(true)} className="font-medium text-slate-600 underline underline-offset-4">Privacy policy</button>
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
            <p><strong>1. Data Collection</strong><br />We collect your phone number, profile information, and usage data to provide our services.</p>
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
