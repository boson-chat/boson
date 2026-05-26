import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { AuthService, type AuthState } from './auth.service';

const AuthContext = createContext<AuthService | null>(null);

interface AuthProviderProps {
  service: AuthService;
  children: ComponentChildren;
}

export function AuthProvider({ service, children }: AuthProviderProps) {
  return <AuthContext.Provider value={service}>{children}</AuthContext.Provider>;
}

export function useAuthService(): AuthService {
  const svc = useContext(AuthContext);
  if (!svc) throw new Error('useAuthService must be used inside AuthProvider');
  return svc;
}

export function useAuthState(): AuthState {
  const svc = useAuthService();
  const [state, setState] = useState<AuthState>(svc.getState());
  useEffect(() => svc.subscribe(setState), [svc]);
  return state;
}
