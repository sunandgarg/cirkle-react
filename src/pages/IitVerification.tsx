import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, GraduationCap, CheckCircle2, Mail, ShieldCheck, AlertCircle, Search } from "lucide-react";
import PostVerifyOnboarding from "@/components/PostVerifyOnboarding";
import { useQuery } from "@tanstack/react-query";
import { defaultIitLogo, IIT_LIST, iitLogoSettingKey, type IitInstitute } from "@/data/iitInstitutes";

const IitLogo = ({ iit, customUrl }: { iit: IitInstitute; customUrl?: string }) => {
  const [failed, setFailed] = useState(false);
  const initials = iit.name
    .replace("IIT ", "")
    .replace(" (ISM)", "")
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();

  return (
    <div className="w-11 h-11 rounded-xl bg-white border border-border/70 shadow-sm flex items-center justify-center overflow-hidden shrink-0">
      {failed ? (
        <span className="text-sm font-black tracking-tight text-primary">{initials}</span>
      ) : (
        <img
          src={customUrl || defaultIitLogo(iit.studentDomain)}
          alt={`${iit.name} logo`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="w-8 h-8 object-contain"
        />
      )}
    </div>
  );
};

/** Derive IIT name from email domain */
function deriveIitFromEmail(email: string): string | undefined {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return undefined;
  const match = IIT_LIST.find(iit => domain === iit.studentDomain || domain === iit.alumniDomain || domain.endsWith(iit.studentDomain));
  return match?.name;
}

type Step = "select_iit" | "select_status" | "verify_email" | "verify_otp" | "onboarding";

const IitVerification = () => {
  const navigate = useNavigate();
  const { user, refetchProfile } = useAuth();
  const [step, setStep] = useState<Step>("select_iit");
  const [selectedIit, setSelectedIit] = useState<typeof IIT_LIST[0] | null>(null);
  const [studentStatus, setStudentStatus] = useState<string>("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [existingRecordMessage, setExistingRecordMessage] = useState("");

  const { data: iitLogos = {} } = useQuery({
    queryKey: ["iit-logos"],
    queryFn: async () => {
      const keys = IIT_LIST.map((iit) => iitLogoSettingKey(iit.studentDomain));
      const { data } = await supabase.from("app_settings").select("key,value").in("key", keys);
      return Object.fromEntries((data ?? []).map((item) => [item.key, item.value])) as Record<string, string>;
    },
    staleTime: 5 * 60 * 1000,
  });

  const filteredIits = IIT_LIST.filter((iit) =>
    iit.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSelectIit = (iit: typeof IIT_LIST[0]) => {
    setSelectedIit(iit);
    setStep("select_status");
  };

  const handleSelectStatus = (status: string) => {
    setStudentStatus(status);
    setStep("verify_email");
  };

  const getExpectedDomain = () => {
    if (!selectedIit) return "";
    return studentStatus === "alumni" ? selectedIit.alumniDomain : selectedIit.studentDomain;
  };

  const handleSendCode = async () => {
    if (!email.trim()) { toast.error("Please enter your email"); return; }
    const domain = email.split("@")[1]?.toLowerCase();
    const expectedDomain = getExpectedDomain();
    const isValidDomain = domain === expectedDomain || domain === selectedIit?.studentDomain;
    const isAcademicEmail = domain?.endsWith(".ac.in");
    if (!isValidDomain && !isAcademicEmail) {
      toast.error(`Please use a valid email from ${selectedIit?.name} (${expectedDomain})`);
      return;
    }
    setLoading(true);
    try {
      const res = await supabase.functions.invoke("send-verification-email", {
        body: { email: email.trim().toLowerCase(), iit_name: selectedIit?.name, user_id: user?.id },
      });
      
      const data = res.data as any;
      
      // Handle errors from edge function (409 etc.)
      if (res.error) {
        const errMsg = data?.error || "Failed to send code";
        // If user already verified with same email, just go to onboarding
        if (data?.already_verified) {
          toast.success("Already verified! Let's complete your profile.");
          setStep("onboarding");
          setLoading(false);
          return;
        }
        if (data?.code === "EMAIL_ALREADY_LINKED" || data?.code === "USER_ALREADY_VERIFIED") {
          setExistingRecordMessage(errMsg);
          setLoading(false);
          return;
        }
        toast.error(errMsg);
        setLoading(false);
        return;
      }
      
      if (data?.error) {
        if (data?.code === "EMAIL_ALREADY_LINKED" || data?.code === "USER_ALREADY_VERIFIED") {
          setExistingRecordMessage(data.error);
        } else {
          toast.error(data.error);
        }
        setLoading(false);
        return;
      }
      // If already verified with same email, skip to onboarding
      if (data?.already_verified) {
        toast.success("Already verified! Let's complete your profile.");
        setStep("onboarding");
        setLoading(false);
        return;
      }
      toast.success("Verification code sent to your email!");
      setStep("verify_otp");
    } catch (err: any) {
      toast.error(err.message || "Failed to send verification code");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp.length !== 6) { toast.error("Please enter the 6-digit code"); return; }
    setLoading(true);
    try {
      const { data: testModeSetting } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "verification_test_mode")
        .maybeSingle();
      const isTestMode = testModeSetting?.value === "true";

      let isValidCode = false;
      const normalizedEmail = email.trim().toLowerCase();

      if (isTestMode && otp === "123456") {
        isValidCode = true;
      } else {
        const { data: codeData } = await supabase
          .from("verification_codes")
          .select("*")
          .eq("email", normalizedEmail)
          .eq("code", otp)
          .eq("used", false)
          .gte("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (codeData) {
          isValidCode = true;
          await supabase.from("verification_codes").update({ used: true } as any).eq("id", codeData.id);
        }
      }

      if (!isValidCode) {
        toast.error("Invalid or expired code. Please try again.");
        setLoading(false);
        return;
      }

      if (user) {
        // Get user's phone for locking
        const userPhone = (user as any).phone || (user as any).user_metadata?.phone || "";

        // Upsert verification record
        const { data: existingVerif } = await supabase
          .from("verifications")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (existingVerif) {
          await supabase.from("verifications").update({
            iit_email: normalizedEmail,
            iit_email_normalized: normalizedEmail,
            iit_domain: normalizedEmail.split("@")[1],
            email_verified_at: new Date().toISOString(),
            verified_status: "VERIFIED",
            locked_to_phone: userPhone,
            updated_at: new Date().toISOString(),
          }).eq("id", existingVerif.id);
        } else {
          await supabase.from("verifications").insert({
            user_id: user.id,
            iit_email: normalizedEmail,
            iit_email_normalized: normalizedEmail,
            iit_domain: normalizedEmail.split("@")[1],
            email_verified_at: new Date().toISOString(),
            verified_status: "VERIFIED",
            locked_to_phone: userPhone,
          });
        }

        // Save verified status immediately; onboarding details are collected next.
        const { error: profileError } = await supabase.from("profiles").upsert({
          user_id: user.id,
          name: (user.user_metadata?.name as string) || user.email || "Cirkle Member",
          iit_name: selectedIit?.name,
          student_status: studentStatus,
          iit_email: normalizedEmail,
          is_verified: true,
          onboarding_completed: false,
        } as any, { onConflict: "user_id" });
        if (profileError) throw profileError;

        await refetchProfile();
      }

      toast.success("Verified! Now let's complete your profile 🎉");
      setStep("onboarding");
    } catch (err: any) {
      toast.error(err.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  // Show onboarding wizard after verification
  if (step === "onboarding") {
    return (
      <PostVerifyOnboarding
        derivedIit={selectedIit?.name || deriveIitFromEmail(email)}
        onComplete={async () => {
          // Ensure profile is fresh before navigating
          await refetchProfile();
          navigate("/cirkle-forum", { replace: true });
        }}
      />
    );
  }

  const stepIndex = ["select_iit", "select_status", "verify_email", "verify_otp"].indexOf(step);

  return (
    <div className="min-h-screen bg-background flex flex-col overflow-hidden">
      <div className="px-4 pt-6 pb-4 flex items-center gap-3">
        <button
          onClick={() => {
            if (step === "verify_otp") setStep("verify_email");
            else if (step === "verify_email") setStep("select_status");
            else if (step === "select_status") setStep("select_iit");
            else navigate(-1);
          }}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex gap-1.5 flex-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-300 ${stepIndex >= i ? "bg-primary" : "bg-border"}`} />
          ))}
        </div>
      </div>

      <div className="flex-1 px-4 pb-8 overflow-y-auto">
        {step === "select_iit" && (
          <div className="animate-fade-in max-w-2xl mx-auto">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <GraduationCap className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Step 1 of 4</p>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Which IIT are you from?</h1>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-5 ml-[60px]">Select your institute to personalize your Cirkle community.</p>
            <div className="relative mb-5">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                autoFocus
                aria-label="Search all IITs"
                placeholder="Search all 23 IITs"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-secondary border-border rounded-xl h-12 pl-10"
              />
            </div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-foreground">All IITs</p>
              <span className="text-xs text-muted-foreground">{filteredIits.length} institutes</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pb-4">
              {filteredIits.map((iit) => (
                <button key={iit.studentDomain} onClick={() => handleSelectIit(iit)}
                  className="group min-h-[68px] px-4 py-2.5 rounded-2xl bg-card border border-border hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-all text-left press-scale flex items-center gap-3">
                  <IitLogo iit={iit} customUrl={iitLogos[iitLogoSettingKey(iit.studentDomain)]} />
                  <span className="text-sm leading-5 text-foreground font-semibold group-hover:text-primary transition-colors">{iit.name}</span>
                </button>
              ))}
              {filteredIits.length === 0 && (
                <div className="col-span-full py-12 text-center">
                  <p className="font-semibold text-foreground">No IIT found</p>
                  <p className="text-sm text-muted-foreground mt-1">Try a city or institute name.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {step === "select_status" && (
          <div className="animate-fade-in max-w-lg mx-auto">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-4 h-4 text-primary" />
              <span className="text-sm text-primary font-medium">{selectedIit?.name}</span>
            </div>
            <h1 className="text-xl font-bold text-foreground mb-2 mt-4">Student or Alumni?</h1>
            <p className="text-sm text-muted-foreground mb-8">This helps personalize your experience</p>
            <div className="space-y-3">
              {[
                { value: "current_student", label: "🎓 Current Student", desc: `I'm currently studying at ${selectedIit?.name}` },
                { value: "alumni", label: "🏛️ Alumni", desc: `I graduated from ${selectedIit?.name}` },
              ].map(s => (
                <button key={s.value} onClick={() => handleSelectStatus(s.value)} className="w-full p-5 rounded-2xl bg-card border border-border hover:border-primary hover:bg-primary/5 transition-all text-left press-scale">
                  <p className="text-base font-bold text-foreground">{s.label}</p>
                  <p className="text-sm text-muted-foreground mt-1">{s.desc}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "verify_email" && (
          <div className="animate-fade-in max-w-lg mx-auto">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{selectedIit?.name}</span>
              <span className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full capitalize">{studentStatus?.replace("_", " ")}</span>
            </div>
            <div className="flex items-center gap-3 mt-6 mb-2">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Mail className="w-6 h-6 text-primary" />
              </div>
              <h1 className="text-xl font-bold text-foreground">Verify your email</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              Enter your <span className="text-foreground font-medium">@{getExpectedDomain()}</span> email
            </p>
            <Input type="email" placeholder={`yourname@${getExpectedDomain()}`} value={email} onChange={(e) => setEmail(e.target.value)} className="bg-secondary border-border h-12 rounded-xl mb-4" onKeyDown={(e) => e.key === "Enter" && handleSendCode()} />
            <Button size="lg" className="w-full h-12 text-base font-semibold rounded-xl" onClick={handleSendCode} disabled={loading}>
              {loading ? "Sending..." : "Send Verification Code"}
            </Button>
            <p className="text-xs text-muted-foreground mt-4 text-center">We'll send a 6-digit code to verify your email</p>
          </div>
        )}

        {step === "verify_otp" && (
          <div className="animate-fade-in max-w-lg mx-auto">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{selectedIit?.name}</span>
              <span className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full">{email}</span>
            </div>
            <div className="flex items-center gap-3 mt-6 mb-2">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <ShieldCheck className="w-6 h-6 text-primary" />
              </div>
              <h1 className="text-xl font-bold text-foreground">Enter verification code</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              Enter the 6-digit code sent to <span className="text-foreground font-medium">{email}</span>
            </p>
            <div className="flex justify-center mb-6">
              <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <Button size="lg" className="w-full h-12 text-base font-semibold rounded-xl" onClick={handleVerifyOtp} disabled={loading}>
              {loading ? "Verifying..." : "Verify & Continue"}
            </Button>
            <button onClick={() => { setOtp(""); handleSendCode(); }} className="text-xs text-primary mt-4 block mx-auto hover:underline">Resend Code</button>
          </div>
        )}
      </div>

      <Dialog open={!!existingRecordMessage} onOpenChange={(open) => !open && setExistingRecordMessage("")}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <div className="w-12 h-12 rounded-xl bg-destructive/10 flex items-center justify-center mb-2">
              <AlertCircle className="w-6 h-6 text-destructive" />
            </div>
            <DialogTitle>Already existing record</DialogTitle>
            <DialogDescription>{existingRecordMessage}</DialogDescription>
          </DialogHeader>
          <Button className="w-full h-11 rounded-xl" onClick={() => navigate("/auth", { replace: true })}>
            Go to login
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default IitVerification;
