// Baseline load profile: a skeleton to grow per feature. Targets live in the thresholds.
//
//   TOKEN=$(pnpm -s dev:token <userId>) k6 run -e BASE_URL=http://localhost:3000 \
//     -e GRAPHQL_URL=http://localhost:3002 -e TOKEN=$TOKEN test/load/baseline.k6.js
//
// Point it at a production-like environment (never production itself): it writes notes.
import http from 'k6/http';
import { check, group, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const GRAPHQL_URL = __ENV.GRAPHQL_URL || 'http://localhost:3002';
const headers = { Authorization: `Bearer ${__ENV.TOKEN}`, 'Content-Type': 'application/json' };

export const options = {
  scenarios: {
    steady: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 200 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<300'],
    'http_req_duration{kind:write}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  group('liveness', () => {
    const health = http.get(`${BASE_URL}/api/health`, { tags: { kind: 'read' } });
    check(health, { 'health 200': (r) => r.status === 200 });
  });

  group('notes (REST)', () => {
    const list = http.get(`${BASE_URL}/api/v2/notes?limit=20`, { headers, tags: { kind: 'read' } });
    check(list, { 'list 200': (r) => r.status === 200 });
    if (Math.random() < 0.1) {
      const created = http.post(`${BASE_URL}/api/v1/notes`, JSON.stringify({ title: `k6 ${__VU}-${__ITER}` }), {
        headers,
        tags: { kind: 'write' },
      });
      check(created, { 'create 201': (r) => r.status === 201 });
    }
  });

  group('notes (GraphQL)', () => {
    const res = http.post(GRAPHQL_URL + '/graphql', JSON.stringify({ query: '{ notes(limit: 10) { meta { totalDocs } } }' }), {
      headers,
      tags: { kind: 'read' },
    });
    check(res, { 'graphql ok': (r) => r.status === 200 && !r.json('errors') });
  });

  sleep(1);
}
