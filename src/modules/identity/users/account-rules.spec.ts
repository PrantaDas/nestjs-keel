import { canSignIn, isReachable } from './account-rules';

describe('account rules', () => {
  it('only an active account may be contacted: no push, inbox, e-mail or SMS otherwise', () => {
    expect(isReachable({ status: 'active' })).toBe(true);
    expect(isReachable({ status: 'deactivated' })).toBe(false);
    expect(isReachable({ status: 'deletion_pending' })).toBe(false);
    expect(isReachable({ status: 'deleted' })).toBe(false);
  });

  it('a self-deactivated or deletion-pending account may sign in (and reactivates); an admin-disabled one may not', () => {
    expect(canSignIn({ status: 'active', deactivatedBy: null })).toBe(true);
    expect(canSignIn({ status: 'deactivated', deactivatedBy: 'self' })).toBe(true);
    expect(canSignIn({ status: 'deletion_pending', deactivatedBy: 'self' })).toBe(true);
    expect(canSignIn({ status: 'deactivated', deactivatedBy: 'admin' })).toBe(false);
    expect(canSignIn({ status: 'deleted', deactivatedBy: null })).toBe(false);
  });
});
