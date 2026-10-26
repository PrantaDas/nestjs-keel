// Baseline load profile (Phase 3 extends this per feature and compares against the legacy API).
//
//   k6 run -e BASE_URL=http://localhost:4000 -e TOKEN=$(node dist/cli/dev-token.js) test/load/baseline.k6.js
//
// Thresholds encode the targets: p95 < 300 ms, error rate < 1%.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const headers = { Authorization: `Bearer ${__ENV.TOKEN}` };

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
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const health = http.get(`${BASE_URL}/api/health`);
  check(health, { 'health 200': (r) => r.status === 200 });

  const list = http.get(`${BASE_URL}/api/v6/samples?limit=20`, { headers });
  check(list, { 'list 200': (r) => r.status === 200 });

  sleep(1);
}
