export interface Server {
  id: string;
  hostname: string;
  port: number;
  tls: boolean;
  name: string;
  description?: string;
  tags: string[];
  languages: string[];
  is_nsfw: boolean;
  is_featured: boolean;
  verification_status: 'pending' | 'verified' | 'lapsed';
  health_status: 'up' | 'down' | 'unknown';
  user_count?: number;
  registered_by?: string;
  registered_at: string;
}

// Owner-scoped server view returned from POST /servers,
// POST /servers/{id}/regenerate-token, and GET /servers/me for rows
// still in `pending` status. The token field is omitted by the
// backend once the row reaches `verified` or `lapsed` — this type
// reflects that omission via the optional marker.
export interface ServerWithToken extends Server {
  verification_token?: string;
  verification_token_issued_at?: string;
}

// Per-resolver verify outcome — mirrors the backend's
// internal/services/server/dns.Result. Surfaced in the verify-step UI
// so the user sees "Cloudflare ✓ / Google ✗ (record missing) / Quad9 ✓"
// when DNS propagation is still settling.
export type VerifyOutcome = 'match' | 'missing_record' | 'timeout' | 'error';

export interface VerifyResolverResult {
  outcome: VerifyOutcome;
  detail?: string;
  records?: string[];
}

export interface VerifyReport {
  success: boolean;
  results: Record<string, VerifyResolverResult>;
}

export interface VerifyResponse {
  server: ServerWithToken;
  report: VerifyReport;
  success: boolean;
}

// Sent on POST /servers.
export interface RegisterServerInput {
  hostname: string;
  port: number;
  tls: boolean;
  name: string;
  description?: string;
  tags?: string[];
  languages?: string[];
  is_nsfw?: boolean;
}

export interface ServersResponse {
  servers: Server[];
  count: number;
}

export interface User {
  id: string;
  handle: string;
  display_name?: string;
  is_discoverable: boolean;
  encrypted_user_secret: string; // base64
  created_at: string;
}

// ---- NickClaim (automated NickServ email-confirmation flow) ---------

export interface NickClaimCreateResponse {
  id: string;
  email: string;
}

export type NickClaimStatus = 'pending' | 'captured' | 'consumed' | 'expired';

export interface NickClaimPollResponse {
  status: NickClaimStatus;
  // Only present when status is 'captured' or 'consumed'.
  code?: string;
}
