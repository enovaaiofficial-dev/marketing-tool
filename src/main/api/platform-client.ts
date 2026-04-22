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

interface FbGroupInfoResponse {
  id?: string;
  name?: string;
  error?: { message: string; type: string; code: number; error_subcode?: number };
}

export interface MemberPage {
  members: { id: string; name: string; link: string }[];
  nextCursor: string | null;
}

function classifyStatus(error: FbError): TokenStatus {
  if (error.error_subcode === 463 || error.error_subcode === 467) return "Expired";
  if (error.code === 10 || error.code === 100 || error.code === 190) return "Invalid";
  if (
    error.error_subcode === 368 ||
    error.code === 368 ||
    error.message?.toLowerCase().includes("blocked")
  )
    return "Blocked";
  return "Invalid";
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
    if (data.error || !data.name) return null;
    return { name: data.name };
  } catch {
    return null;
  }
}

export async function fetchGroupMembers(
  token: string,
  groupId: string,
  afterCursor?: string | null,
  limit: number = 10
): Promise<MemberPage> {
  let url =
    `${GRAPH_API}/${encodeURIComponent(groupId)}` +
    `/members?fields=id,name,link&limit=${limit}&access_token=${encodeURIComponent(token)}`;
  if (afterCursor) {
    url += `&after=${encodeURIComponent(afterCursor)}`;
  }

  const res = await fetch(url);
  const data: FbGroupMembersResponse = await res.json();

  if (data.error) {
    throw new Error(`[${data.error.code}] ${data.error.message}`);
  }

  const members = (data.data ?? []).map((m) => ({
    id: m.id,
    name: m.name ?? "",
    link: m.link ?? `https://www.facebook.com/${m.id}`,
  }));

  const nextCursor = data.paging?.cursors?.after ?? null;
  const hasMore = !!data.paging?.next && members.length > 0;

  return {
    members,
    nextCursor: hasMore ? nextCursor : null,
  };
}
