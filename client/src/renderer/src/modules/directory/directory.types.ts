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
