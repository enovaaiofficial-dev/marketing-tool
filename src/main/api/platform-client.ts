import type { TokenStatus } from "@shared/types";

const GRAPH_API = "https://graph.facebook.com/v21.0";

interface FbError {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
}

interface FbMeResponse {
  id?: string;
  name?: string;
  error?: { message: string; type: string; code: number; error_subcode?: number };
}

interface FbGroupMember {
  id: string;
  name?: string;
  link?: string;
  administrator?: boolean;
}

interface FbGroupMembersResponse {
  data?: FbGroupMember[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
  error?: FbError;
}

interface FbGroupMembersFieldResponse {
  members?: {
    data?: FbGroupMember[];
    paging?: {
      cursors?: { before?: string; after?: string };
      next?: string;
    };
  };
  error?: FbError;
}

interface FbGroupInfoResponse {
  id?: string;
  name?: string;
  error?: { message: string; type: string; code: number; error_subcode?: number };
}

export interface MemberPage {
  members: { id: string; name: string; link: string }[];
  hasMore: boolean;
  nextCursor: string | null;
  nextPageUrl: string | null;
}

function buildMemberPage(data: FbGroupMember[], paging?: FbGroupMembersResponse["paging"]): MemberPage {
  const members = (data ?? []).map((m) => ({
    id: m.id,
    name: m.name ?? "",
    link: m.link ?? `https://www.facebook.com/${m.id}`,
  }));

  const nextPageLink = paging?.next ?? null;
  const nextCursor = paging?.cursors?.after ?? null;
  const hasMore = !!nextPageLink || !!nextCursor;

  return {
    members,
    hasMore,
    nextCursor: hasMore ? nextCursor : null,
    nextPageUrl: hasMore ? nextPageLink : null,
  };
}

function shouldRetryWithMembersField(error?: FbError): boolean {
  if (!error || error.code !== 100) return false;
  const msg = error.message?.toLowerCase() ?? "";
  return msg.includes("nonexisting field") && msg.includes("members");
}

function extractAfterCursor(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get("after");
  } catch {
    return null;
  }
}

function buildMembersFieldUrl(token: string, groupId: string, limit: number, afterCursor?: string | null) {
  const fields = afterCursor
    ? `members.after(${afterCursor}).limit(${limit}){id,name,link}`
    : `members.limit(${limit}){id,name,link}`;

  return (
    `${GRAPH_API}/${encodeURIComponent(groupId)}` +
    `?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`
  );
}

function classifyStatus(error: FbError): TokenStatus {
  if (error.error_subcode === 463 || error.error_subcode === 467) return "Expired";
  if (
    error.code === 190 &&
    (error.message?.toLowerCase().includes("checkpoint") ||
      error.message?.toLowerCase().includes("logged-in"))
  ) {
    return "Blocked";
  }
  if (error.code === 10 || error.code === 100 || error.code === 190) return "Invalid";
  if (
    error.error_subcode === 368 ||
    error.code === 368 ||
    error.message?.toLowerCase().includes("blocked")
  )
    return "Blocked";
  return "Invalid";
}

function formatGraphError(error: FbError, context: "group-members" | "group-info", groupId: string): string {
  if (context === "group-members" && error.code === 10) {
    return `Token is valid for login, but Facebook denied access to members of group ${groupId} (code 10). The selected account does not have permission to read this group's member list.`;
  }

  if (context === "group-members" && error.code === 190) {
    return `Facebook rejected the token while reading members for group ${groupId} (code 190). Re-login, pass any checkpoint, then validate the token again.`;
  }

  if (context === "group-members" && error.code === 100) {
    return `Facebook does not allow the requested members endpoint for group ${groupId} (code 100). The token or app context cannot access this group's member list.`;
  }

  if (context === "group-info" && error.code === 10) {
    return `Facebook denied access to group ${groupId} metadata (code 10). The selected account may not be allowed to access this group.`;
  }

  return `[${error.code}] ${error.message}`;
}

export async function validateToken(
  token: string
): Promise<{ valid: boolean; status: TokenStatus; name?: string; id?: string }> {
  try {
    const res = await fetch(
      `${GRAPH_API}/me?fields=id,name&access_token=${encodeURIComponent(token)}`
    );
    const data: FbMeResponse = await res.json();

    if (data.error) {
      return { valid: false, status: classifyStatus(data.error) };
    }

    return {
      valid: true,
      status: "Valid",
      name: data.name ?? undefined,
      id: data.id ?? undefined,
    };
  } catch {
    return { valid: false, status: "Invalid" };
  }
}

export async function fetchGroupInfo(
  token: string,
  groupId: string
): Promise<{ name: string } | null> {
  try {
    const res = await fetch(
      `${GRAPH_API}/${encodeURIComponent(groupId)}?fields=name&access_token=${encodeURIComponent(token)}`
    );
    const data: FbGroupInfoResponse = await res.json();
    if (data.error) {
      throw new Error(formatGraphError(data.error, "group-info", groupId));
    }
    if (!data.name) return null;
    return { name: data.name };
  } catch {
    return null;
  }
}

export async function fetchGroupMembers(
  token: string,
  groupId: string,
  afterCursor?: string | null,
  limit: number = 10,
  nextPageUrl?: string | null
): Promise<MemberPage> {
  let url = nextPageUrl ?? "";
  if (!url) {
    url =
      `${GRAPH_API}/${encodeURIComponent(groupId)}` +
      `/members?fields=id,name,link&limit=${limit}&access_token=${encodeURIComponent(token)}`;
    if (afterCursor) {
      url += `&after=${encodeURIComponent(afterCursor)}`;
    }
  }

  const res = await fetch(url);
  const data: FbGroupMembersResponse = await res.json();

  if (data.error) {
    if (shouldRetryWithMembersField(data.error)) {
      const fallbackAfter = afterCursor ?? extractAfterCursor(nextPageUrl);
      const fallbackUrl = buildMembersFieldUrl(token, groupId, limit, fallbackAfter);
      const fallbackRes = await fetch(fallbackUrl);
      const fallbackData: FbGroupMembersFieldResponse = await fallbackRes.json();

      if (fallbackData.error) {
        throw new Error(formatGraphError(fallbackData.error, "group-members", groupId));
      }

      return buildMemberPage(fallbackData.members?.data ?? [], fallbackData.members?.paging);
    }

    throw new Error(formatGraphError(data.error, "group-members", groupId));
  }

  return buildMemberPage(data.data ?? [], data.paging);
}
