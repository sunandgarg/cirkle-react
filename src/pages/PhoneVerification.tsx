import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "sonner";
import { Smartphone, ShieldCheck, ArrowLeft } from "lucide-react";
import CountryCodeSelect, { COUNTRY_CODES, type CountryOption } from "@/components/CountryCodeSelect";

const isValidPhone = (digits: string) => digits.length === 10;

/** Mobile verification step shown after social (Google) sign-in. */
const PhoneVerification = () => {
  const navigate = useNavigate();
  const { user, profile, loading } = useAuth();
  const [country, setCountry] = useState<CountryOption>(COUNTRY_CODES[0]);
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [otp, setOtp] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) { navigate("/auth", { replace: true }); return; }
    if ((user.user_metadata as any)?.phone) {
      navigate(profile?.is_verified ? "/cirkle-forum" : "/iit-verify", { replace: true });
    }
  }, [user, profile?.is_verified, loading, navigate]);

  const sendCode = async () => {
    if (!isValidPhone(phone)) {
      toast.error("Enter a valid 10-digit mobile number");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ phone: `${country.code}${phone}` });
      if (error) throw error;
      setStep("otp");
      toast.success("Verification code sent");
    } catch (error: any) {
      toast.error(error.message || "Could not start mobile verification. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    if (otp.length !== 6) { toast.error("Enter the full 6-digit code"); return; }
    setSaving(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        phone: `${country.code}${phone}`,
        token: otp,
        type: "phone_change",
      });
      if (error) throw error;
      const { error: metadataError } = await supabase.auth.updateUser({
        data: { phone, phone_country_code: country.code, phone_full: `${country.code}${phone}` },
      });
      if (metadataError) throw metadataError;
      toast.success("Mobile number verified!");
      navigate(profile?.is_verified ? "/cirkle-forum" : "/iit-verify", { replace: true });
    } catch (err: any) {
      toast.error(err.message || "Could not save your number. Please try again.");
      setSaving(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="px-6 pt-6 pb-2">
        {step === "otp" && (
          <button onClick={() => { setStep("phone"); setOtp(""); }} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-6 h-6" />
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
          {step === "phone" ? <Smartphone className="w-9 h-9 text-primary" /> : <ShieldCheck className="w-9 h-9 text-primary" />}
        </div>

        {step === "phone" ? (
          <>
            <h1 className="text-2xl font-bold text-foreground text-center">Verify your mobile</h1>
            <p className="text-sm text-muted-foreground mt-2 mb-6 text-center max-w-xs">
              Add your 10-digit mobile number to secure your Cirkle account.
            </p>
            <div className="w-full max-w-xs flex items-center gap-2">
              <CountryCodeSelect value={country} onChange={setCountry} />
              <Input
                type="tel"
                inputMode="numeric"
                placeholder="Mobile number"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                onKeyDown={(e) => e.key === "Enter" && sendCode()}
                className="bg-secondary border-border h-12 rounded-xl flex-1"
                maxLength={10}
              />
            </div>
            <Button size="lg" className="w-full max-w-xs h-12 text-base font-semibold rounded-xl mt-6" onClick={sendCode} disabled={saving || !isValidPhone(phone)}>
              {saving ? "Sending..." : "Send code"}
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-foreground text-center">Verify OTP</h1>
            <p className="text-sm text-muted-foreground mt-2 text-center">
              Enter the 6-digit code sent to <span className="text-foreground font-medium">{country.code} {phone}</span>
            </p>
            <div className="mt-8">
              <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <InputOTPSlot key={i} index={i} className="w-12 h-14 text-lg font-bold text-foreground bg-secondary border-border rounded-xl" />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
            <Button size="lg" className="w-full max-w-xs h-12 text-base font-semibold rounded-xl mt-8" onClick={verify} disabled={saving || otp.length !== 6}>
              {saving ? "Verifying..." : "Verify & Continue"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
};

export default PhoneVerification;
