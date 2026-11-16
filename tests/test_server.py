"""Behavioral HTTP and SQLite tests; temporary servers/data are always cleaned up."""
import concurrent.futures
import http.client
import importlib.util
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("studio_app", ROOT / "server" / "app.py")
APP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APP)
ADMIN = "synthetic-admin-token-only-for-tests"
TODAY = "2031-06-10"
DAY = "2031-06-11"


class BookingHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="liniya-test-")
        self.db = Path(self.temp.name) / "test.sqlite3"
        self.clock = lambda: datetime(2031, 6, 10, 12, tzinfo=APP.MOSCOW)
        self.store = APP.BookingStore(self.db, clock=self.clock)
        self.server = APP.BookingServer(("127.0.0.1", 0), self.store, admin_token=ADMIN)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.cleanup_server)

    def cleanup_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive(), "Test HTTP server must stop")
        self.temp.cleanup()

    def request(self, method, path, data=None, headers=None, raw=None):
        headers = dict(headers or {})
        body = raw
        if data is not None:
            body = json.dumps(data, ensure_ascii=False).encode()
            headers.setdefault("Content-Type", "application/json")
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=20)
        try:
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            payload = response.read()
            if response.getheader("Content-Type", "").startswith("application/json"):
                payload = json.loads(payload)
            return response.status, payload, dict(response.getheaders())
        finally:
            conn.close()

    @staticmethod
    def data(**changes):
        return dict(serviceId="cut", staffId="anna", date=DAY, time="10:00", name="Учебный гость", **{}) | changes

    def create(self, **changes):
        status, value, _ = self.request("POST", "/api/bookings", self.data(**changes))
        self.assertEqual(status, 201, value)
        return value

    @staticmethod
    def owner(value):
        return {"X-Booking-Token": value["token"]}

    @staticmethod
    def path(value):
        return "/api/bookings/" + value["booking"]["id"]

    def count(self):
        return len(self.store.list_all()["bookings"])

    def parallel(self, jobs):
        barrier = threading.Barrier(len(jobs))
        def run(job):
            barrier.wait(timeout=15)
            return job()
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
            return list(pool.map(run, jobs))

    def assert_no_overlap(self):
        with self.store.connect() as connection:
            count = connection.execute("""SELECT COUNT(*) FROM bookings a JOIN bookings b ON a.id<b.id
              AND a.staffId=b.staffId AND a.date=b.date AND a.status='confirmed' AND b.status='confirmed'
              AND a.startMinute<b.endMinute AND a.endMinute>b.startMinute""").fetchone()[0]
        self.assertEqual(count, 0)

    def test_catalog_and_duration_aware_slots(self):
        status, catalog, _ = self.request("GET", "/api/catalog")
        self.assertEqual(status, 200)
        self.assertEqual(catalog["mode"], "server")
        self.assertEqual(catalog["today"], TODAY)
        self.assertEqual(catalog["timezone"], "Europe/Moscow")
        self.create(serviceId="color", time="10:30")
        status, value, _ = self.request("GET", "/api/slots?service=cut&staff=anna&date=" + DAY)
        self.assertEqual(status, 200)
        for occupied in ("10:00", "10:30", "11:00", "11:30", "12:00"):
            self.assertNotIn(occupied, value["slots"])
        self.assertIn("12:30", value["slots"])
        self.assertIn("19:00", value["slots"])
        self.assertNotIn("19:30", value["slots"])

    def test_twenty_four_competing_creates_same_slot(self):
        result = self.parallel([lambda: self.request("POST", "/api/bookings", self.data()) for _ in range(24)])
        statuses = [item[0] for item in result]
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(409), 23)
        self.assertEqual(self.count(), 1)
        self.assert_no_overlap()

    def test_twenty_four_competing_creates_different_overlapping_starts(self):
        jobs = [lambda time=time: self.request("POST", "/api/bookings", self.data(serviceId="color", time=time))
                for time in ("10:00", "10:30", "11:00") * 8]
        statuses = [item[0] for item in self.parallel(jobs)]
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(409), 23)
        self.assertEqual(self.count(), 1)
        self.assert_no_overlap()

    def test_adjacent_intervals_and_other_staff_allowed(self):
        self.create(serviceId="color", time="10:00")
        self.create(serviceId="care", time="12:00")
        self.create(staffId="maria", time="10:00")
        self.assertEqual(self.count(), 3)
        self.assert_no_overlap()

    def test_two_competing_moves_preserve_losing_original(self):
        a = self.create(serviceId="color", time="15:00")
        b = self.create(serviceId="color", time="17:00")
        requests = [(a, "10:00"), (b, "10:30")]
        results = self.parallel([lambda booking=booking, time=time: self.request("PATCH", self.path(booking),
                    {"staffId": "anna", "date": DAY, "time": time}, self.owner(booking)) for booking, time in requests])
        self.assertEqual(sorted(item[0] for item in results), [200, 409])
        for (booking, target), result in zip(requests, results):
            status, value, _ = self.request("GET", self.path(booking), headers=self.owner(booking))
            self.assertEqual(status, 200)
            self.assertEqual(value["booking"]["time"], target if result[0] == 200 else booking["booking"]["time"])
        self.assert_no_overlap()

    def test_competing_create_and_move(self):
        old = self.create(serviceId="care", time="15:00")
        result = self.parallel([
            lambda: self.request("POST", "/api/bookings", self.data(serviceId="color", time="10:00")),
            lambda: self.request("PATCH", self.path(old), {"staffId": "anna", "date": DAY, "time": "10:30"}, self.owner(old)),
        ])
        self.assertIn([item[0] for item in result], ([201, 409], [409, 200]))
        _, value, _ = self.request("GET", self.path(old), headers=self.owner(old))
        self.assertEqual(value["booking"]["time"], "15:00" if result[1][0] == 409 else "10:30")
        self.assert_no_overlap()

    def test_failed_move_preserves_all_fields_and_slots(self):
        old = self.create(time="15:00")
        self.create(serviceId="color", time="10:00")
        status, value, _ = self.request("PATCH", self.path(old), {"staffId": "anna", "date": DAY, "time": "10:30"}, self.owner(old))
        self.assertEqual(status, 409)
        self.assertEqual(value["code"], "conflict")
        _, actual, _ = self.request("GET", self.path(old), headers=self.owner(old))
        self.assertEqual(actual["booking"], old["booking"])
        _, slots, _ = self.request("GET", "/api/slots?service=cut&staff=anna&date=" + DAY)
        self.assertNotIn("15:00", slots["slots"])

    def test_successful_move_releases_original_and_preserves_service(self):
        old = self.create(time="15:00")
        status, value, _ = self.request("PATCH", self.path(old), {"staffId": "maria", "date": DAY, "time": "13:00"}, self.owner(old))
        self.assertEqual(status, 200)
        self.assertEqual(value["booking"]["serviceId"], "cut")
        _, slots, _ = self.request("GET", "/api/slots?service=cut&staff=anna&date=" + DAY)
        self.assertIn("15:00", slots["slots"])
        self.create(time="15:00")
        self.assert_no_overlap()

    def test_cancel_releases_slot_and_cannot_be_moved(self):
        old = self.create()
        for _ in range(2):
            status, value, _ = self.request("DELETE", self.path(old), headers=self.owner(old))
            self.assertEqual(status, 200)
            self.assertEqual(value["booking"]["status"], "cancelled")
        self.create()
        status, _, _ = self.request("PATCH", self.path(old), {"staffId": "anna", "date": DAY, "time": "14:00"}, self.owner(old))
        self.assertEqual(status, 409)
        self.assert_no_overlap()

    def test_owner_admin_authorization_and_no_secret_fields(self):
        a, b = self.create(), self.create(time="15:00")
        for headers in ({}, self.owner(b), {"Authorization": "Bearer invalid", "X-Role": "admin"}):
            with self.subTest(headers=headers.keys()):
                self.assertEqual(self.request("GET", self.path(a), headers=headers)[0], 403)
                self.assertEqual(self.request("PATCH", self.path(a), {"staffId": "anna", "date": DAY, "time": "13:00"}, headers)[0], 403)
                self.assertEqual(self.request("DELETE", self.path(a), headers=headers)[0], 403)
        self.assertEqual(self.request("GET", "/api/admin/bookings")[0], 403)
        self.assertEqual(self.request("GET", "/api/admin/bookings", headers=self.owner(a))[0], 403)
        admin = {"Authorization": "Bearer " + ADMIN}
        status, value, _ = self.request("GET", "/api/admin/bookings", headers=admin)
        self.assertEqual(status, 200)
        self.assertEqual(len(value["bookings"]), 2)
        for booking in value["bookings"]:
            self.assertEqual(set(booking), set(APP.PUBLIC_FIELDS))
        self.assertNotIn("token", json.dumps(value))
        self.assertEqual(self.request("PATCH", self.path(a), {"staffId": "maria", "date": DAY, "time": "13:00"}, admin)[0], 200)
        self.assertEqual(self.request("DELETE", self.path(a), headers=admin)[0], 200)

    def test_disabled_admin_does_not_accept_forged_role(self):
        self.server.admin_token = None
        status, value, _ = self.request("GET", "/api/admin/bookings", headers={"Authorization": "Bearer " + ADMIN})
        self.assertEqual(status, 503)
        self.assertEqual(value["code"], "admin_disabled")

    def test_excluding_booking_requires_its_key_or_admin(self):
        old = self.create()
        path = "/api/slots?service=cut&staff=anna&date=" + DAY + "&exclude=" + old["booking"]["id"]
        self.assertEqual(self.request("GET", path)[0], 403)
        for auth in (self.owner(old), {"Authorization": "Bearer " + ADMIN}):
            status, value, _ = self.request("GET", path, headers=auth)
            self.assertEqual(status, 200)
            self.assertIn("10:00", value["slots"])

    def test_invalid_booking_payloads_leave_database_unchanged(self):
        invalid = [
            {"serviceId": "unknown"}, {"staffId": "unknown"}, {"serviceId": "color", "staffId": "maria"},
            {"date": TODAY}, {"date": "2031-06-09"}, {"date": "2031-07-11"}, {"date": "2031-02-30"}, {"date": None},
            {"time": "09:30"}, {"time": "19:30"}, {"time": "10:15"}, {"time": "10:60"}, {"time": "24:00"},
            {"time": 600}, {"time": "1e:00"}, {"name": " "}, {"name": "x" * 61}, {"name": "\x00name"},
            {"name": ["guest"]}, {"serviceId": []}, {"unexpected": "field"}, {"duration": 1}, {"status": "confirmed"},
        ]
        for change in invalid:
            with self.subTest(change=change):
                status, _, _ = self.request("POST", "/api/bookings", self.data(**change))
                self.assertEqual(status, 400)
        self.assertEqual(self.count(), 0)

    def test_invalid_move_payloads_cannot_edit_owner_name_service_or_status(self):
        old = self.create()
        for payload in ({"staffId": "maria", "date": DAY, "time": "12:00", "serviceId": "care"},
                        {"staffId": "anna", "date": TODAY, "time": "12:00"}, {"date": DAY, "time": "12:00"}):
            self.assertEqual(self.request("PATCH", self.path(old), payload, self.owner(old))[0], 400)
        self.assertEqual(self.store.get(old["booking"]["id"], old["token"])["booking"], old["booking"])

    def test_idempotent_create_replay_survives_reopen_and_key_does_not_store_token(self):
        key = str(uuid.uuid4())
        auth = {"Idempotency-Key": key}
        first = self.request("POST", "/api/bookings", self.data(), auth)
        second = self.request("POST", "/api/bookings", self.data(), auth)
        self.assertEqual(first[:2], second[:2])
        self.assertEqual(first[0], 201)
        reopened = APP.BookingStore(self.db, clock=self.clock)
        self.assertEqual(reopened.create(self.data(), request_key=key), first[1])
        self.assertEqual(self.count(), 1)
        with self.store.connect() as connection:
            records = str([tuple(row) for row in connection.execute("SELECT * FROM idempotency")])
            self.assertNotIn(first[1]["token"], records)
            self.assertNotIn(key, records)

    def test_twenty_concurrent_idempotent_retries_create_only_once(self):
        key = {"Idempotency-Key": str(uuid.uuid4())}
        result = self.parallel([lambda: self.request("POST", "/api/bookings", self.data(), key) for _ in range(20)])
        self.assertTrue(all(item[0] == 201 for item in result))
        self.assertEqual(len({item[1]["booking"]["id"] for item in result}), 1)
        self.assertEqual(len({item[1]["token"] for item in result}), 1)
        self.assertEqual(self.count(), 1)

    def test_reusing_idempotency_key_with_other_payload_or_action_rejected(self):
        key = {"Idempotency-Key": str(uuid.uuid4())}
        status, old, _ = self.request("POST", "/api/bookings", self.data(), key)
        self.assertEqual(status, 201)
        for payload in (self.data(time="14:00"), self.data(name="Другой гость")):
            status, value, _ = self.request("POST", "/api/bookings", payload, key)
            self.assertEqual(status, 409)
            self.assertEqual(value["code"], "idempotency_conflict")
        self.assertEqual(self.request("DELETE", self.path(old), headers=self.owner(old) | key)[0], 409)
        self.assertEqual(self.count(), 1)

    def test_move_and_cancel_replay_require_authorization(self):
        old = self.create()
        key = {"Idempotency-Key": str(uuid.uuid4())}
        payload = {"staffId": "anna", "date": DAY, "time": "14:00"}
        first = self.request("PATCH", self.path(old), payload, self.owner(old) | key)
        second = self.request("PATCH", self.path(old), payload, self.owner(old) | key)
        self.assertEqual(first[:2], second[:2])
        self.assertEqual(first[0], 200)
        self.assertEqual(self.request("PATCH", self.path(old), payload, key)[0], 403)
        self.assertEqual(self.request("PATCH", self.path(old), payload | {"time": "15:00"}, self.owner(old) | key)[0], 409)
        cancel_key = {"Idempotency-Key": str(uuid.uuid4())}
        first = self.request("DELETE", self.path(old), headers=self.owner(old) | cancel_key)
        second = self.request("DELETE", self.path(old), headers=self.owner(old) | cancel_key)
        self.assertEqual(first[:2], second[:2])
        self.assertEqual(first[0], 200)
        self.assertEqual(self.request("DELETE", self.path(old), headers=cancel_key)[0], 403)

    def test_failed_action_does_not_poison_idempotency_key(self):
        taken, old = self.create(time="10:00"), self.create(time="15:00")
        key = {"Idempotency-Key": str(uuid.uuid4())}
        payload = {"staffId": "anna", "date": DAY, "time": "10:30"}
        self.assertEqual(self.request("PATCH", self.path(old), payload, self.owner(old) | key)[0], 409)
        self.request("DELETE", self.path(taken), headers=self.owner(taken))
        self.assertEqual(self.request("PATCH", self.path(old), payload, self.owner(old) | key)[0], 200)

    def test_bad_idempotency_keys_rejected(self):
        for key in ("", "short", "x" * 129, "invalid/key-with-enough-length"):
            self.assertEqual(self.request("POST", "/api/bookings", self.data(), {"Idempotency-Key": key})[0], 400)
        self.assertEqual(self.count(), 0)

    def test_sqlite_trigger_rejects_direct_overlapping_insert_and_update(self):
        a, b = self.create(), self.create(time="15:00")
        with self.store.connect() as connection:
            row = dict(connection.execute("SELECT * FROM bookings WHERE id=?", (a["booking"]["id"],)).fetchone())
            row["id"] = "another-direct-row"
            with self.assertRaisesRegex(sqlite3.IntegrityError, "booking_overlap"):
                connection.execute("INSERT INTO bookings (" + ",".join(row) + ") VALUES (" + ",".join("?" for _ in row) + ")", tuple(row.values()))
            with self.assertRaisesRegex(sqlite3.IntegrityError, "booking_overlap"):
                connection.execute("UPDATE bookings SET time='10:30',startMinute=630,endMinute=690 WHERE id=?", (b["booking"]["id"],))
        self.assert_no_overlap()

    def test_two_store_instances_share_database_lock_and_persistence(self):
        other = APP.BookingStore(self.db, clock=self.clock)
        def create(store):
            try:
                return (201, store.create(self.data(serviceId="color")))
            except APP.APIError as error:
                return (error.status, error.code)
        result = self.parallel([lambda: create(self.store), lambda: create(other)])
        self.assertEqual(sorted(item[0] for item in result), [201, 409])
        winner = next(item[1] for item in result if item[0] == 201)
        self.assertEqual(other.get(winner["booking"]["id"], winner["token"]), {"booking": winner["booking"]})
        self.assert_no_overlap()

    def test_host_origin_fetch_metadata_and_no_cors(self):
        for headers in ({"Host": "evil.example"}, {"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("POST", "/api/bookings", self.data(), headers)[0], 403)
        status, _, headers = self.request("GET", "/api/catalog")
        self.assertEqual(status, 200)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.count(), 0)

    def test_body_and_query_errors(self):
        for raw, headers, expected in (
            (b"{broken", {"Content-Type": "application/json"}, 400),
            (b"[]", {"Content-Type": "application/json"}, 400),
            (b"{}", {"Content-Type": "text/plain"}, 415),
            (b"x" * (APP.MAX_BODY + 1), {"Content-Type": "application/json"}, 413),
        ):
            self.assertEqual(self.request("POST", "/api/bookings", headers=headers, raw=raw)[0], expected)
        for query in ("service=cut&service=care&staff=anna&date=" + DAY, "service=cut&staff=anna&date=" + DAY + "&role=admin"):
            self.assertEqual(self.request("GET", "/api/slots?" + query)[0], 400)
        self.assertEqual(self.request("POST", "/api/bookings", {})[0], 400)
        self.assertEqual(self.count(), 0)

    def test_only_public_files_are_served(self):
        status, html, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("линия".encode(), html)
        for path in ("/server/app.py", "/runtime/studio.sqlite3", "/.env", "/../server/app.py", "/%2e%2e/server/app.py", "/%2e%2e%2fserver/app.py", "/%5c..%5cserver/app.py"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(self.request("GET", "/api/bookings")[0], 404)
        self.assertEqual(self.request("GET", "/api/unknown")[0], 404)


if __name__ == "__main__":
    unittest.main()
