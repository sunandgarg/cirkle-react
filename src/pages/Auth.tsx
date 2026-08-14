import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CountryCodeSelect, { COUNTRY_CODES, type CountryOption } from "@/components/CountryCodeSelect";
import { hasMobileTestMode, isMobileTestPhone, MOBILE_TEST_OTP } from "@/lib/mobileVerification";
import cirkleLogo from "@/assets/cirkle-logo.png";
import { ArrowRight, LockKeyhole, ShieldCheck, Sparkles, Users } from "lucide-react";


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
        navigate("/cirkle-forum", { replace: true });
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
    if (!isMobileTestPhone(country.code, phone)) {
      toast.error("SMS verification is not available right now. Please try again later.");
      return;
    }

    setLoading(true);
    try {
      if (isMobileTestPhone(country.code, phone)) {
        navigate("/otp-verify", { state: { phone, countryCode: country.code } });
        return;
      }
      const { error } = await supabase.auth.signInWithOtp({ phone: `${country.code}${phone}` });
      if (error) throw error;
      navigate("/otp-verify", { state: { phone, countryCode: country.code } });
    } catch (error: any) {
      toast.error(error.message || "Could not start mobile verification. Please try again.");
      setLoading(false);
    }
  };


  return (
    <div className="onboarding-shell">
      <main className="onboarding-scroll flex items-center py-5 sm:py-8">
        <div className="mx-auto grid w-full max-w-4xl items-center gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="px-1 text-center lg:px-6 lg:text-left">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-card/80 px-3 py-1.5 text-xs font-bold text-primary shadow-sm backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" /> The verified IIT network
            </div>
            <div className="mt-5 flex items-center justify-center gap-3 lg:justify-start">
              <img src={cirkleLogo} alt="Cirkle" className="h-14 w-14 rounded-[18px] shadow-[0_14px_35px_-16px_hsl(var(--primary))]" />
              <div className="text-left">
                <p className="text-2xl font-black tracking-[-0.04em] text-foreground">Cirkle</p>
                <p className="text-xs font-semibold tracking-[0.16em] text-muted-foreground">IIT COMMUNITY</p>
              </div>
            </div>
            <h1 className="mt-5 text-[34px] font-black leading-[1.04] tracking-[-0.045em] text-foreground sm:text-5xl">
              Your campus network,<br className="hidden sm:block" /> without the noise.
            </h1>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-6 text-muted-foreground lg:mx-0">
              Verified conversations, the right batch groups, and alumni access—ready the moment your profile is complete.
            </p>
            <div className="mt-5 hidden grid-cols-3 gap-2.5 sm:grid lg:max-w-md">
              {[
                { icon: ShieldCheck, label: "Verified" },
                { icon: Users, label: "23 IITs" },
                { icon: LockKeyhole, label: "Private" },
              ].map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-center justify-center gap-1.5 rounded-2xl border border-border/70 bg-card/70 px-3 py-2.5 text-xs font-semibold text-foreground shadow-sm">
                  <Icon className="h-4 w-4 text-primary" /> {label}
                </div>
              ))}
            </div>
          </section>

          <section className="onboarding-stage !max-w-md !p-5 sm:!p-7" aria-labelledby="login-title">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary">Welcome back</p>
            <h2 id="login-title" className="mt-1 text-2xl font-black tracking-tight text-foreground">Continue with mobile</h2>
            <p className="mt-1.5 text-sm leading-5 text-muted-foreground">We’ll remember verified members on this device.</p>

            <label htmlFor="mobile-number" className="mt-6 block text-sm font-bold text-foreground">Mobile number</label>
            <div className="mt-2 flex items-center gap-2">
              <CountryCodeSelect value={country} onChange={setCountry} />
              <div className="relative min-w-0 flex-1">
                <Input
                  id="mobile-number"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="10-digit number"
                  value={phone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  className="h-12 rounded-xl border-border bg-secondary pr-14 text-[16px] text-foreground placeholder:text-muted-foreground focus:border-primary"
                  onKeyDown={(e) => e.key === "Enter" && handleContinue()}
                  maxLength={10}
                />
                <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-bold tabular-nums ${isValidPhone(phone) ? "text-[hsl(var(--success))]" : "text-muted-foreground"}`}>
                  {phone.length}/10
                </span>
              </div>
            </div>

            {hasMobileTestMode() && (
              <div className="mt-3 rounded-xl border border-primary/15 bg-primary/[0.06] px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
                <span className="font-bold text-primary">Test mode:</span> 99999 99999 or 88888 88888 · code {MOBILE_TEST_OTP}
              </div>
            )}

            <Button size="lg" className="mt-4 h-12 w-full gap-2 rounded-xl text-base font-bold shadow-[0_14px_30px_-16px_hsl(var(--primary))]" onClick={handleContinue} disabled={loading || !isValidPhone(phone)}>
              {loading ? "Sending secure code..." : "Continue securely"}
              {!loading && <ArrowRight className="h-4 w-4" />}
            </Button>

            <div className="mt-4 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
              <LockKeyhole className="h-3.5 w-3.5" /> Your number is never shown publicly
            </div>
            <p className="mt-5 text-center text-[11px] leading-5 text-muted-foreground">
              By continuing, you agree to our{" "}
              <button onClick={() => setShowTerms(true)} className="font-semibold text-foreground underline underline-offset-2">Terms</button>{" "}and{" "}
              <button onClick={() => setShowPrivacy(true)} className="font-semibold text-foreground underline underline-offset-2">Privacy Policy</button>.
            </p>
          </section>
        </div>
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
