import { AuthError } from './auth.js';

export interface SupabaseAuthConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
}

export interface SupabaseAuthUser {
  id: string;
  email: string;
  name?: string;
}

/**
 * Lightweight Supabase GoTrue Auth client using native fetch.
 * Used when SUPABASE_URL and SUPABASE_ANON_KEY are configured on the server.
 */
export class SupabaseAuthClient {
  private base: string;
  constructor(private cfg: SupabaseAuthConfig) {
    this.base = cfg.url.replace(/\/+$/, '');
  }

  private headers(useService = false): Record<string, string> {
    const key = useService && this.cfg.serviceRoleKey ? this.cfg.serviceRoleKey : this.cfg.anonKey;
    return {
      'content-type': 'application/json',
      apikey: key,
      authorization: `Bearer ${key}`,
    };
  }

  async signUp(email: string, password: string, name: string): Promise<SupabaseAuthUser> {
    // If service role key is present, use admin create with email_confirm: true so the CEO can sign in immediately.
    if (this.cfg.serviceRoleKey) {
      const res = await fetch(`${this.base}/auth/v1/admin/users`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } }),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        if (res.status === 422 || /already/i.test(data.msg || data.message || '')) {
          return this.signIn(email, password);
        }
        throw new AuthError(data.msg || data.message || `Supabase sign up failed (${res.status})`, res.status === 400 ? 400 : 502);
      }
      return { id: data.id, email: data.email || email, name };
    }

    const res = await fetch(`${this.base}/auth/v1/signup`, {
      method: 'POST',
      headers: this.headers(false),
      body: JSON.stringify({ email, password, data: { name } }),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      if (/already/i.test(data.msg || data.error_description || '')) {
        return this.signIn(email, password);
      }
      throw new AuthError(data.msg || data.error_description || `Supabase sign up failed (${res.status})`, 400);
    }
    const u = data.user ?? data;
    return { id: u.id, email: u.email || email, name };
  }

  async signIn(email: string, password: string): Promise<SupabaseAuthUser> {
    const res = await fetch(`${this.base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: this.headers(false),
      body: JSON.stringify({ email, password }),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      throw new AuthError(data.error_description || data.msg || 'Email or password is incorrect', 401);
    }
    const u = data.user;
    if (!u?.id) throw new AuthError('Supabase returned no user', 401);
    return { id: u.id, email: u.email || email, name: u.user_metadata?.name };
  }
}
