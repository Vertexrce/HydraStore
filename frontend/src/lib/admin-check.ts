export type FutureAdminResponse = {
  profile?: { isAdmin?: boolean; role?: string };
  isAdmin?: boolean;
  role?: string;
};

/**
 * Isolated adapter for the future server-owned admin response.
 * Demo IDs and local toggles are not an authorization boundary.
 */
export function readAdminStatus(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const value = response as FutureAdminResponse;
  return value.isAdmin === true || value.profile?.isAdmin === true || value.role === 'admin' || value.profile?.role === 'admin';
}