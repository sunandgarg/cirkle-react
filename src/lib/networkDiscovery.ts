export const NETWORK_MEMBER_PAGE_SIZE = 48;
export const NETWORK_SEARCH_PAGE_SIZE = 250;

export type NetworkTab = "explore" | "discover" | "pending" | "connected";

export type NetworkMember = {
  user_id: string;
  name?: string | null;
  slug?: string | null;
  avatar_url?: string | null;
  headline?: string | null;
  location?: string | null;
  iit_name?: string | null;
  student_status?: string | null;
  is_verified?: boolean | null;
  skills?: unknown;
  expertise?: unknown;
  [key: string]: unknown;
};

export type NetworkMemberPage = {
  rows: NetworkMember[];
  count?: number | null;
};

const NETWORK_TABS = new Set<NetworkTab>(["explore", "discover", "pending", "connected"]);

export const resolveNetworkTab = (pathname: string, requestedTab: string | null): NetworkTab => {
  if (requestedTab && NETWORK_TABS.has(requestedTab as NetworkTab)) return requestedTab as NetworkTab;
  if (pathname === "/network/connections") return "connected";
  if (pathname === "/network/suggestions") return "discover";
  return "explore";
};

export const networkSearchTerms = (search: string): string[] =>
  search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

const searchableValues = (member: NetworkMember): unknown[] => [
  member.name,
  member.headline,
  member.iit_name,
  member.student_status,
  member.location,
  ...(Array.isArray(member.skills) ? member.skills : []),
  ...(Array.isArray(member.expertise) ? member.expertise : []),
];

export const memberMatchesNetworkSearch = (member: NetworkMember, search: string): boolean => {
  const terms = networkSearchTerms(search);
  if (!terms.length) return true;
  const searchable = searchableValues(member)
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
};

export const collectNetworkMemberPages = async (
  fetchPage: (from: number, to: number) => Promise<NetworkMemberPage>,
  pageSize = NETWORK_SEARCH_PAGE_SIZE,
): Promise<NetworkMember[]> => {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error("Invalid member page size");
  const members = new Map<string, NetworkMember>();
  let from = 0;
  let expectedCount: number | null = null;

  while (expectedCount === null || from < expectedCount) {
    const page = await fetchPage(from, from + pageSize - 1);
    if (expectedCount === null && typeof page.count === "number" && Number.isFinite(page.count)) {
      expectedCount = Math.max(0, Math.floor(page.count));
    }
    const previousSize = members.size;
    for (const member of page.rows) {
      if (member?.user_id) members.set(member.user_id, member);
    }
    if (page.rows.length < pageSize) break;
    if (members.size === previousSize) throw new Error("Member pagination did not advance");
    from += pageSize;
  }

  return [...members.values()];
};

export const pageCount = (total: number, pageSize = NETWORK_MEMBER_PAGE_SIZE): number =>
  Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
