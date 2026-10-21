import React, { createContext, useContext, useState, useCallback } from 'react';
import {
  setAuthTokenGetter,
  getGetCardQueryKey,
  getGetDiscountsQueryKey,
  getListDiscountCouponsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import type { AdminMe } from '@workspace/api-client-react';

const CARD_TOKEN_KEY = 'bhi_card_token';
const ADMIN_TOKEN_KEY = 'bhi_admin_token';
const ADMIN_USER_KEY = 'bhi_admin_user';

/**
 * Install the bearer-token getter at MODULE LOAD, before any component mounts.
 *
 * This used to live in a `useEffect` inside AuthProvider, which was too late.
 * React runs a child's effects before its parent's, so the first query on a
 * freshly loaded admin page fired before the getter existed and went out with
 * no Authorization header — every hard load cost a 401 and a retry, and the
 * screen sat empty for the length of React Query's backoff.
 *
 * It reads storage rather than React state for the same reason: storage is
 * written synchronously by the setters below, so the token is correct from the
 * first render without waiting for a re-render to publish it.
 */
setAuthTokenGetter(() => {
  const isAdmin = window.location.pathname.includes('/admin');
  return isAdmin
    ? localStorage.getItem(ADMIN_TOKEN_KEY)
    : sessionStorage.getItem(CARD_TOKEN_KEY);
});

interface AuthContextValue {
  // Card session
  cardToken: string | null;
  setCardToken: (token: string | null) => void;
  clearCardSession: () => void;
  
  // Admin session
  adminToken: string | null;
  adminUser: AdminMe | null;
  setAdminSession: (token: string, user: AdminMe) => void;
  clearAdminSession: () => void;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [cardToken, setCardTokenState] = useState<string | null>(() =>
    sessionStorage.getItem(CARD_TOKEN_KEY)
  );
  const [adminToken, setAdminTokenState] = useState<string | null>(() =>
    localStorage.getItem(ADMIN_TOKEN_KEY)
  );
  const [adminUser, setAdminUser] = useState<AdminMe | null>(() => {
    const stored = localStorage.getItem(ADMIN_USER_KEY);
    return stored ? JSON.parse(stored) : null;
  });

  // Each setter writes storage synchronously: that write, not the state
  // update, is what the token getter above reads.
  const setCardToken = useCallback((token: string | null) => {
    // A card belongs to one session: whenever the session starts or ends, the
    // previous member's card must go, or the next person in this browser could
    // be shown it — including someone with no policy, who should see none.
    queryClient.removeQueries({ queryKey: getGetCardQueryKey() });
    // The same goes for their discount allowance and coupons.
    queryClient.removeQueries({ queryKey: getGetDiscountsQueryKey() });
    queryClient.removeQueries({ queryKey: getListDiscountCouponsQueryKey() });
    setCardTokenState(token);
    if (token) {
      sessionStorage.setItem(CARD_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(CARD_TOKEN_KEY);
    }
  }, [queryClient]);

  const clearCardSession = useCallback(() => {
    setCardToken(null);
  }, [setCardToken]);

  const setAdminSession = useCallback((token: string, user: AdminMe) => {
    setAdminTokenState(token);
    setAdminUser(user);
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
    localStorage.setItem(ADMIN_USER_KEY, JSON.stringify(user));
  }, []);

  const clearAdminSession = useCallback(() => {
    setAdminTokenState(null);
    setAdminUser(null);
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_USER_KEY);
  }, []);

  const hasPermission = useCallback((permission: string) => {
    return adminUser?.permissions.includes(permission) ?? false;
  }, [adminUser]);

  const value: AuthContextValue = {
    cardToken,
    setCardToken,
    clearCardSession,
    adminToken,
    adminUser,
    setAdminSession,
    clearAdminSession,
    hasPermission,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
