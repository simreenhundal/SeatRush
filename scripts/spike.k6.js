// k6 spike test: a ticket drop where traffic jumps from 0 to 500 virtual users.
//
//   brew install k6           (or see https://k6.io/docs/get-started/installation)
//   k6 run -e EVENT_ID=1 -e FIRST_SEAT=1 scripts/spike.k6.js
//
// Create the event first (POST /events) and pass its id and first seat id.
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.API_URL || "http://localhost:3000";
const EVENT_ID = Number(__ENV.EVENT_ID || 1);
const FIRST_SEAT = Number(__ENV.FIRST_SEAT || 1);
const SEATS = Number(__ENV.SEATS || 100);

export const options = {
  scenarios: {
    drop: {
      executor: "ramping-vus",
      stages: [
        { duration: "5s", target: 500 }, // the drop
        { duration: "20s", target: 500 },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    // Losing the race is expected (409). Server errors are not.
    "http_req_failed{expected_response:true}": ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
  },
};

http.setResponseCallback(http.expectedStatuses(200, 201, 402, 409, 410));

export default function () {
  const user = `vu-${__VU}-${__ITER}`;
  const seat = FIRST_SEAT + Math.floor(Math.random() * SEATS);
  const hold = http.post(`${BASE}/holds`, JSON.stringify({ eventId: EVENT_ID, seatIds: [seat] }), {
    headers: { "Content-Type": "application/json", "X-User-Id": user },
  });
  check(hold, { "hold: no server error": (r) => r.status < 500 });
  if (hold.status !== 201) return;

  const pay = http.post(`${BASE}/holds/${hold.json("id")}/checkout`, null, {
    headers: { "X-User-Id": user, "Idempotency-Key": `k6-${user}` },
  });
  check(pay, { "checkout: no server error": (r) => r.status < 500 });
}
