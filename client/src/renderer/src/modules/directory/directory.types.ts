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
  // Computed CDN URLs for the listing's icon (square) + banner (wide),
  // absent when unset. Owners manage these via the icon/banner endpoints.
  icon_url?: string;
  banner_url?: string;
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

// A Boson member resolved from a presence lookup — what the client needs to
// render their identity on a nick it saw in a channel.
export interface PresenceMatch {
  nick: string;
  handle: string;
  display_name?: string;
  avatar_url?: string;
}

export interface User {
  id: string;
  handle: string;
  display_name?: string;
  is_discoverable: boolean;
  // Public CDN URL of the user's profile image, or absent if none set.
  // Computed server-side from the stored avatar key.
  avatar_url?: string;
  encrypted_user_secret: string; // base64
  // Second wrap of user_secret keyed by the recovery code; absent until the
  // user has enrolled one. base64.
  encrypted_user_secret_recovery?: string;
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

// ---- NickServ secret sync (E2E-encrypted password storage) ----------

// One per-(user, server) ciphertext blob as returned by the backend. The
// ciphertext is opaque — produced by encryptCreds() on the client; only the
// client (holding user_secret) can decrypt it.
export interface NickservSecretDTO {
  server_id: string;
  ciphertext: string; // base64
  updated_at: string; // RFC3339
}

export interface NickservSecretsListResponse {
  secrets: NickservSecretDTO[];
}
