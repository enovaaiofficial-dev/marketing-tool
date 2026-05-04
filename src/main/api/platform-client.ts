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
  error?: FbError;
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
  ) {
    return "Blocked";
  }
  return "Invalid";
}

/**
 * Validate a Facebook access token by hitting the Graph /me endpoint.
 * This is the only Graph API call retained in the app — group-member
 * extraction is done entirely via the browser scraper, not the Graph API.
 */
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
