// Compatibility export: existing UI code keeps its Supabase-shaped calls while
// all runtime traffic is handled by the Cirkle Node API client.
export {
  apiClient,
  clearSupabaseAuthSession,
  supabase,
  supabaseAuthStorageKey,
  supabaseUrl,
} from "@/integrations/api/client";

export type { ApiSession, ApiUser } from "@/integrations/api/types";
