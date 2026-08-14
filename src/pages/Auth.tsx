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
    <div className="h-[100dvh] flex flex-col overflow-hidden bg-background" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      {/* Avatar grid background - dark image only */}
      <div className="flex-1 relative overflow-hidden min-h-0 bg-[hsl(216_28%_5%)]">
        <div className="grid grid-cols-4 gap-1 p-1 opacity-60">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="aspect-square rounded-lg"
              style={{
                backgroundImage: `url(https://i.pravatar.cc/150?img=${i + 1})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                filter: "grayscale(100%) blur(1px) brightness(0.35) contrast(1.2)",
              }}
            />
          ))}
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/85 to-transparent" />
      </div>

      {/* Login form */}
      <div className="relative z-10 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 -mt-16 flex-shrink-0">
        <h1 className="text-3xl font-bold text-foreground">Welcome</h1>
        <p className="text-sm text-muted-foreground mt-1 mb-4">Continue securely with your mobile number</p>

        <div className="flex items-center gap-2 mb-4">
          {/* Country code selector (supports custom "Other" codes) */}
          <CountryCodeSelect value={country} onChange={setCountry} />
          <Input
            type="tel"
            inputMode="numeric"
            placeholder="Enter 10-digit number"
            value={phone}
            onChange={(e) => handlePhoneChange(e.target.value)}
            className="bg-secondary border-border text-foreground placeholder:text-muted-foreground h-12 rounded-xl focus:border-primary flex-1"
            onKeyDown={(e) => e.key === "Enter" && handleContinue()}
            maxLength={10}
          />
        </div>

        {/* Digit count indicator */}
        <p className={`text-xs mb-2 ${isValidPhone(phone) ? "text-green-500" : "text-muted-foreground"}`}>
          {phone.length}/10 digits
        </p>

        {hasMobileTestMode() && (
          <p className="text-xs mb-3 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-primary">
            Test logins: +91 99999 99999 or +91 88888 88888 · OTP {MOBILE_TEST_OTP}
          </p>
        )}


        <Button
          size="lg"
          className="w-full h-12 text-base font-semibold rounded-xl"
          onClick={handleContinue}
          disabled={loading || !isValidPhone(phone)}
        >
          {loading ? "Sending code..." : "Continue with mobile"}
        </Button>

        <p className="text-center text-xs text-muted-foreground mt-5">
          By continuing, you agree to our{" "}
          <button onClick={() => setShowTerms(true)} className="underline text-muted-foreground hover:text-foreground transition-colors">T&C</button> &{" "}
          <button onClick={() => setShowPrivacy(true)} className="underline text-muted-foreground hover:text-foreground transition-colors">Privacy policy</button>
        </p>
      </div>




      {/* Terms Dialog */}
      <Dialog open={showTerms} onOpenChange={setShowTerms}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
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
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
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
