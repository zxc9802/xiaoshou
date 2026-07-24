import assert from 'node:assert/strict';
import test from 'node:test';
import type { CustomerProfile } from '../shared/contracts.js';
import * as customerProfilesPage from '../src/components/CustomerProfilesPage.js';

type CustomerProfilesPageModule = typeof customerProfilesPage & {
  replaceCustomerProfile?: (profiles: CustomerProfile[], currentId: string, updated: CustomerProfile) => CustomerProfile[];
};

test('a merged customer profile replaces the stale card id', () => {
  const replaceCustomerProfile = (customerProfilesPage as CustomerProfilesPageModule).replaceCustomerProfile;
  assert.equal(typeof replaceCustomerProfile, 'function');
  if (!replaceCustomerProfile) return;

  const stale = { id: 'stale-profile' } as CustomerProfile;
  const updated = { id: 'merged-profile' } as CustomerProfile;

  assert.deepEqual(replaceCustomerProfile([stale], stale.id, updated), [updated]);
});
