"""Run with: python -m pytest tests/test_rooms.py."""
import base64
import hashlib
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def api(tmp_path, monkeypatch):
    database_path = tmp_path / "rooms.db"
    monkeypatch.setenv("GONGGANG_DB", str(database_path))
    from app import main

    monkeypatch.setattr(main, "DB_PATH", database_path)
    main.init_db()
    return main


@pytest.fixture
def clients(api):
    with TestClient(api.app) as owner, TestClient(api.app) as guest:
        yield owner, guest


def create_room(client, **options):
    response = client.post("/api/rooms", json={"title": "팀플", **options})
    assert response.status_code == 200
    return "/api/rooms/" + response.json()["room_id"]


@pytest.mark.parametrize("scheme", ["http", "https"])
def test_identity_cookie_is_private_reused_and_hashed(api, scheme):
    with TestClient(api.app, base_url=scheme + "://testserver") as client:
        response = client.post("/api/rooms", json={"title": "팀플"})
        token = client.cookies.get(api.IDENTITY_COOKIE)
        assert len(base64.urlsafe_b64decode(token + "=")) == 32
        cookie_header = response.headers["set-cookie"].lower()
        assert "httponly" in cookie_header
        assert "samesite=strict" in cookie_header
        assert "path=/" in cookie_header
        assert ("secure" in cookie_header) == (scheme == "https")
        room_url = "/api/rooms/" + response.json()["room_id"]
        room = client.get(room_url)
        assert room.status_code == 200
        assert room.headers["cache-control"] == "no-store"
        assert "set-cookie" not in room.headers
        assert room.json()["is_owner"] is True
        assert room.json()["expected_members"] is None
        assert room.json()["confirmed_meeting"] is None
        assert room.json()["members"] == []
        assert client.post("/api/rooms", json={"title": "두 번째 방"}).status_code == 200
        assert client.cookies.get(api.IDENTITY_COOKIE) == token
        with api.get_db() as db:
            hashes = [row["owner_hash"] for row in db.execute("SELECT owner_hash FROM rooms")]
        assert hashes == [hashlib.sha256(token.encode()).hexdigest()] * 2
        assert token not in room.text
        assert hashes[0] not in room.text


def test_only_original_browser_can_edit_existing_member(api, clients):
    owner, guest = clients
    room_url = create_room(owner, expected_members=2)
    assert owner.put(room_url + "/timetable", json={"name": "가람", "busy_slots": [1]}).status_code == 200
    guest_room = guest.get(room_url)
    assert guest_room.json()["members"] == [{"name": "가람", "busy_slots": [1], "editable": False}]
    assert guest_room.json()["is_owner"] is False
    assert guest.cookies.get(api.IDENTITY_COOKIE)
    blocked = guest.put(room_url + "/timetable", json={"name": "가람", "busy_slots": [2]})
    assert blocked.status_code == 403
    assert "처음 저장한 브라우저" in blocked.json()["detail"]
    assert guest.put(room_url + "/timetable", json={"name": "나래", "busy_slots": [3]}).status_code == 200
    assert owner.put(room_url + "/timetable", json={"name": "가람", "busy_slots": [4, 2, 2]}).status_code == 200
    room = owner.get(room_url).json()
    assert room["expected_members"] == 2
    assert len(room["members"]) == 2
    members = {member["name"]: member for member in room["members"]}
    assert members["가람"] == {"name": "가람", "busy_slots": [2, 4], "editable": True}
    assert members["나래"]["editable"] is False
    assert not {2, 3, 4}.intersection(room["free_slots"])
    with api.get_db() as db:
        hashes = [row["owner_hash"] for row in db.execute("SELECT owner_hash FROM members")]
    assert all(value and value not in str(room) for value in hashes)


@pytest.mark.parametrize("cookie", [None, "malformed", "A" * 43])
def test_missing_or_forged_cookie_cannot_edit_or_confirm(api, clients, cookie):
    owner, attacker = clients
    room_url = create_room(owner)
    assert owner.put(room_url + "/timetable", json={"name": "가람", "busy_slots": []}).status_code == 200
    if cookie is not None:
        attacker.cookies.set(api.IDENTITY_COOKIE, cookie)
    for suffix, payload in (
        ("/timetable", {"name": "가람", "busy_slots": [1]}),
        ("/meeting", {"start_slot": 0}),
    ):
        response = attacker.put(room_url + suffix, json=payload)
        assert response.status_code == 403
        assert "set-cookie" not in response.headers
    room = owner.get(room_url).json()
    assert room["members"][0]["busy_slots"] == []
    assert room["confirmed_meeting"] is None
    if cookie != "A" * 43:
        response = attacker.put(room_url + "/timetable", json={"name": "새 팀원", "busy_slots": []})
        assert response.status_code == 403
        assert "set-cookie" not in response.headers
        assert attacker.get(room_url).status_code == 200
        assert attacker.cookies.get(api.IDENTITY_COOKIE, domain="testserver.local") != cookie


def test_simultaneous_first_save_does_not_overwrite_nickname(api, clients):
    owner, guest = clients
    room_url = create_room(owner)
    assert guest.get(room_url).status_code == 200
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(client.put, room_url + "/timetable", json={"name": "같은 닉네임", "busy_slots": [slot]})
            for client, slot in ((owner, 1), (guest, 2))
        ]
        responses = [future.result() for future in futures]
    assert sorted(response.status_code for response in responses) == [200, 403]
    winner_index = next(index for index, response in enumerate(responses) if response.status_code == 200)
    room = (owner, guest)[winner_index].get(room_url).json()
    assert room["members"] == [{"name": "같은 닉네임", "busy_slots": [winner_index + 1], "editable": True}]


def test_owner_confirms_only_complete_available_meeting_and_conflicts_are_visible(clients):
    owner, guest = clients
    room_url = create_room(owner, expected_members=2)
    assert owner.put(room_url + "/meeting", json={"start_slot": 0}).status_code == 409
    assert owner.put(room_url + "/timetable", json={"name": "가람", "busy_slots": [0]}).status_code == 200
    incomplete = owner.put(room_url + "/meeting", json={"start_slot": 2})
    assert incomplete.status_code == 409
    assert "모두 저장되지" in incomplete.json()["detail"]
    assert guest.get(room_url).status_code == 200
    assert guest.put(room_url + "/timetable", json={"name": "나래", "busy_slots": [4]}).status_code == 200
    assert guest.put(room_url + "/meeting", json={"start_slot": 2}).status_code == 403
    for start_slot in (0, 3, 4):
        assert owner.put(room_url + "/meeting", json={"start_slot": start_slot}).status_code == 409
    assert owner.put(room_url + "/meeting", json={"start_slot": 2}).status_code == 200
    confirmed = {"start_slot": 2, "minutes": 60, "is_valid": True}
    assert guest.get(room_url).json()["confirmed_meeting"] == confirmed
    assert owner.put(room_url + "/meeting", json={"start_slot": 0}).status_code == 409
    assert owner.get(room_url).json()["confirmed_meeting"] == confirmed
    assert guest.put(room_url + "/timetable", json={"name": "나래", "busy_slots": [3]}).status_code == 200
    assert owner.get(room_url).json()["confirmed_meeting"] == {**confirmed, "is_valid": False}
    assert owner.put(room_url + "/meeting", json={"start_slot": 4}).status_code == 200
    assert guest.get(room_url).json()["confirmed_meeting"] == {**confirmed, "start_slot": 4}


def test_room_without_expected_count_can_confirm_after_first_response(clients):
    owner, _ = clients
    room_url = create_room(owner)
    assert owner.put(room_url + "/meeting", json={"start_slot": 118}).status_code == 409
    assert owner.put(room_url + "/timetable", json={"name": "가람", "busy_slots": []}).status_code == 200
    assert owner.put(room_url + "/meeting", json={"start_slot": 118}).status_code == 200
    assert owner.get(room_url).json()["confirmed_meeting"] == {"start_slot": 118, "minutes": 60, "is_valid": True}


@pytest.mark.parametrize("slot", [True, False, "1", 1.0, 1.5, None, -1, 120])
def test_invalid_timetable_slots_do_not_overwrite_saved_schedule(api, clients, slot):
    owner, _ = clients
    room_url = create_room(owner)
    busy_slots = [0, api.TOTAL_SLOTS - 1]
    assert owner.put(room_url + "/timetable", json={"name": "가람", "busy_slots": busy_slots}).status_code == 200

    response = owner.put(room_url + "/timetable", json={"name": "가람", "busy_slots": [0, slot]})

    assert response.status_code == 422
    assert owner.get(room_url).json()["members"][0]["busy_slots"] == busy_slots


@pytest.mark.parametrize("start_slot", [-1, 23, 47, 71, 95, 119, 120, 1.5, True, "2"])
def test_invalid_meeting_slots_are_rejected(clients, start_slot):
    owner, _ = clients
    room_url = create_room(owner)
    assert owner.put(room_url + "/meeting", json={"start_slot": start_slot}).status_code == 422
    assert owner.get(room_url).json()["confirmed_meeting"] is None


@pytest.mark.parametrize("count", [0, -1, 101, 1.5, True, "2"])
def test_invalid_expected_member_counts_are_rejected(clients, count):
    owner, _ = clients
    assert owner.post("/api/rooms", json={"title": "팀플", "expected_members": count}).status_code == 422


def test_legacy_migration_is_idempotent_and_does_not_claim_old_members(api, clients, tmp_path, monkeypatch):
    legacy_path = tmp_path / "legacy.db"
    with sqlite3.connect(legacy_path) as db:
        db.executescript("""
            CREATE TABLE rooms (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE members (
                room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                name TEXT NOT NULL, busy_slots TEXT NOT NULL DEFAULT '',
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (room_id, name)
            );
            INSERT INTO rooms (id, title) VALUES ('legacy', '기존 방');
            INSERT INTO members (room_id, name, busy_slots) VALUES ('legacy', '기존 팀원', '0,1');
        """)
    monkeypatch.setattr(api, "DB_PATH", legacy_path)
    api.init_db()
    api.init_db()
    owner, guest = clients
    for client in (owner, guest):
        room = client.get("/api/rooms/legacy").json()
        assert room["title"] == "기존 방"
        assert room["expected_members"] is None
        assert room["confirmed_meeting"] is None
        assert room["is_owner"] is False
        assert room["members"] == [{"name": "기존 팀원", "busy_slots": [0, 1], "editable": False}]
        assert client.put("/api/rooms/legacy/timetable", json={"name": "기존 팀원", "busy_slots": []}).status_code == 403
        assert client.put("/api/rooms/legacy/meeting", json={"start_slot": 2}).status_code == 403
    assert guest.put("/api/rooms/legacy/timetable", json={"name": "새 팀원", "busy_slots": [2]}).status_code == 200
    with api.get_db() as db:
        legacy = db.execute("SELECT busy_slots, owner_hash FROM members WHERE name = ?", ("기존 팀원",)).fetchone()
    assert legacy["busy_slots"] == "0,1"
    assert legacy["owner_hash"] is None


def test_missing_room_returns_404(clients):
    owner, _ = clients
    assert owner.get("/api/rooms/missing").status_code == 404
    assert owner.put("/api/rooms/missing/timetable", json={"name": "가람", "busy_slots": []}).status_code == 404
    assert owner.put("/api/rooms/missing/meeting", json={"start_slot": 0}).status_code == 404
