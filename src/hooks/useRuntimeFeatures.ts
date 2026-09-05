import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/integrations/api/http";

type RuntimeFeatures = {
  daily_calls?: unknown;
};

const pagesAllowDailyCalls = import.meta.env.VITE_DAILY_CALLS_ENABLED === "true";

export const resolveDailyCallsEnabled = (
  pagesEnabled: boolean,
  serverFeatures: RuntimeFeatures | null | undefined,
): boolean => pagesEnabled && serverFeatures?.daily_calls === true;

export type DailyCallAvailability = {
  enabled: boolean;
  resolved: boolean;
};

export const resolveDailyCallAvailability = (
  pagesEnabled: boolean,
  serverFeatures: RuntimeFeatures | null | undefined,
  requestPending: boolean,
): DailyCallAvailability => ({
  enabled: resolveDailyCallsEnabled(pagesEnabled, serverFeatures),
  // A disabled Pages flag needs no request. With an opt-in flag, wait until
  // the API either answers or fails before handling an incoming call URL.
  resolved: !pagesEnabled || !requestPending,
});

export const useDailyCallAvailability = (): DailyCallAvailability => {
  const { data, isPending } = useQuery({
    queryKey: ["runtime-features"],
    enabled: pagesAllowDailyCalls,
    queryFn: async () => {
      const result = await apiRequest<RuntimeFeatures>("features", {
        auth: false,
        retryAuth: false,
      });
      if (result.error) throw result.error;
      return result.data;
    },
    staleTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });

  // Missing/invalid API data and failed requests all resolve to disabled.
  return resolveDailyCallAvailability(pagesAllowDailyCalls, data, isPending);
};

export const useDailyCallsEnabled = (): boolean => useDailyCallAvailability().enabled;
