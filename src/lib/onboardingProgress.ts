import { supabase } from "@/integrations/supabase/client";

export type OnboardingProgressData = {
  selectedIit?: string;
  studentStatus?: "current_student" | "alumni" | "";
  iitEmail?: string;
  accountName?: string;
  phoneCountryCode?: string;
  phone?: string;
  name?: string;
  degree?: string;
  otherCourse?: string;
  specialisation?: string;
  year?: string;
  location?: string;
  linkedin?: string;
  company?: string;
  companyLogoUrl?: string;
  acceptedTerms?: boolean;
};

export type OnboardingProgress = {
  flow_step: string;
  progress_data: OnboardingProgressData;
};

export const loadOnboardingProgress = async (userId: string): Promise<OnboardingProgress | null> => {
  const { data, error } = await (supabase as any)
    .from("onboarding_progress")
    .select("flow_step,progress_data")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as OnboardingProgress | null;
};

export const saveOnboardingProgress = async (
  userId: string,
  flowStep: string,
  progressData: OnboardingProgressData,
) => {
  const { error } = await (supabase as any).from("onboarding_progress").upsert({
    user_id: userId,
    flow_step: flowStep,
    progress_data: progressData,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw error;
};

export const clearOnboardingProgress = async (userId: string) => {
  const { error } = await (supabase as any).from("onboarding_progress").delete().eq("user_id", userId);
  if (error) throw error;
};
