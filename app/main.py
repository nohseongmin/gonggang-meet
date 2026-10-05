"""Gonggang-Meet: find shared free slots for university team meetings."""
import hashlib
import logging
import os
import re
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StrictInt, field_validator

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("GONGGANG_DB", BASE_DIR.parent / "gonggang.db"))
STATIC_DIR = BASE_DIR / "static"

# Grid constants: Mon-Fri (5 days), 09:00-21:00 in 30-min slots (24 per day)
DAYS = 5
SLOTS_PER_DAY = 24
TOTAL_SLOTS = DAYS * SLOTS_PER_DAY
MIN_MEETING_SLOTS = 2  # 60 minutes
SLOT_MINUTES = 30
MAX_EXPECTED_MEMBERS = 100
IDENTITY_COOKIE = "gonggang_identity"
IDENTITY_BYTES = 32
IDENTITY_COOKIE_MAX_AGE = 365 * 24 * 60 * 60

logger = logging.getLogger(__name__)
app = FastAPI(title="Gonggang-Meet", docs_url=None, redoc_url=None)


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS members (
                room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                busy_slots TEXT NOT NULL DEFAULT '',
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (room_id, name)
            );
            """
        )
        columns = {
            "rooms": {row["name"] for row in db.execute("PRAGMA table_info(rooms)")},
            "members": {row["name"] for row in db.execute("PRAGMA table_info(members)")},
        }
        for table, column, statement in (
            ("rooms", "owner_hash", "ALTER TABLE rooms ADD COLUMN owner_hash TEXT"),
            ("rooms", "expected_members", "ALTER TABLE rooms ADD COLUMN expected_members INTEGER"),
            ("rooms", "confirmed_start_slot", "ALTER TABLE rooms ADD COLUMN confirmed_start_slot INTEGER"),
            ("members", "owner_hash", "ALTER TABLE members ADD COLUMN owner_hash TEXT"),
        ):
            if column not in columns[table]:
                db.execute(statement)


init_db()


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    # Never leak internals (stack traces, paths) to the client.
    logger.exception("Unhandled request error", exc_info=exc)
    return JSONResponse(status_code=500, content={"detail": "server error"})


class RoomCreate(BaseModel):
    title: str = Field(min_length=1, max_length=50)
    expected_members: int | None = Field(default=None, ge=1, le=MAX_EXPECTED_MEMBERS, strict=True)

    @field_validator("title")
    @classmethod
    def strip_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title must not be blank")
        return v


class TimetableSave(BaseModel):
    name: str = Field(min_length=1, max_length=20)
    busy_slots: list[StrictInt] = Field(max_length=TOTAL_SLOTS)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        if not re.fullmatch(r"[\w가-힣 .\-]{1,20}", v):
            raise ValueError("name contains invalid characters")
        return v

    @field_validator("busy_slots")
    @classmethod
    def validate_slots(cls, v: list[int]) -> list[int]:
        for s in v:
            if not (0 <= s < TOTAL_SLOTS):
                raise ValueError("slot index out of range")
        return sorted(set(v))


class MeetingConfirm(BaseModel):
    start_slot: int = Field(ge=0, lt=TOTAL_SLOTS, strict=True)

    @field_validator("start_slot")
    @classmethod
    def validate_start_slot(cls, value: int) -> int:
        if value % SLOTS_PER_DAY > SLOTS_PER_DAY - MIN_MEETING_SLOTS:
            raise ValueError("meeting must fit within one weekday")
        return value


def get_browser_hash(request: Request) -> str | None:
    token = request.cookies.get(IDENTITY_COOKIE, "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        return None
    return hashlib.sha256(token.encode()).hexdigest()


def ensure_browser_identity(request: Request, response: Response) -> str:
    response.headers["Cache-Control"] = "no-store"
    token_hash = get_browser_hash(request)
    if token_hash:
        return token_hash
    token = secrets.token_urlsafe(IDENTITY_BYTES)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    response.set_cookie(
        IDENTITY_COOKIE, token, max_age=IDENTITY_COOKIE_MAX_AGE,
        httponly=True, samesite="strict", secure=request.url.scheme == "https",
    )
    return token_hash


def meeting_is_available(room: sqlite3.Row, slot_sets: list[set[int]], start_slot: int) -> bool:
    if not slot_sets or len(slot_sets) < (room["expected_members"] or 1):
        return False
    meeting_slots = set(range(start_slot, start_slot + MIN_MEETING_SLOTS))
    return all(not meeting_slots.intersection(busy) for busy in slot_sets)


def compute_recommendations(member_slot_sets: list[set[int]]) -> dict:
    """Intersect free time across members and rank contiguous blocks."""
    busy_union = set().union(*member_slot_sets) if member_slot_sets else set()
    free = [s for s in range(TOTAL_SLOTS) if s not in busy_union]
    free_set = set(free)

    blocks = []
    for day in range(DAYS):
        start = None
        for idx in range(SLOTS_PER_DAY + 1):
            slot = day * SLOTS_PER_DAY + idx
            if idx < SLOTS_PER_DAY and slot in free_set:
                if start is None:
                    start = idx
            elif start is not None:
                length = idx - start
                if length >= MIN_MEETING_SLOTS:
                    blocks.append({"day": day, "start_idx": start, "length": length})
                start = None

    blocks.sort(key=lambda b: (-b["length"], b["day"], b["start_idx"]))
    top = []
    for b in blocks[:3]:
        start_min = b["start_idx"] * 30
        end_min = (b["start_idx"] + b["length"]) * 30
        top.append(
            {
                "day": b["day"],
                "start": f"{9 + start_min // 60:02d}:{start_min % 60:02d}",
                "end": f"{9 + end_min // 60:02d}:{end_min % 60:02d}",
                "minutes": b["length"] * 30,
            }
        )
    return {"free_slots": free, "recommendations": top}


@app.post("/api/rooms")
def create_room(body: RoomCreate, request: Request, response: Response):
    room_id = secrets.token_urlsafe(8)  # unguessable room token
    with get_db() as db:
        owner_hash = ensure_browser_identity(request, response)
        db.execute(
            "INSERT INTO rooms (id, title, owner_hash, expected_members) VALUES (?, ?, ?, ?)",
            (room_id, body.title, owner_hash, body.expected_members),
        )
    return {"room_id": room_id}


@app.get("/api/rooms/{room_id}")
def get_room(room_id: str, request: Request, response: Response):
    with get_db() as db:
        # Keep room metadata and member schedules in the same snapshot.
        db.execute("BEGIN")
        room = db.execute(
            "SELECT id, title, owner_hash, expected_members, confirmed_start_slot FROM rooms WHERE id = ?",
            (room_id,),
        ).fetchone()
        if room is None:
            raise HTTPException(status_code=404, detail="room not found")
        browser_hash = ensure_browser_identity(request, response)
        rows = db.execute(
            "SELECT name, busy_slots, owner_hash FROM members WHERE room_id = ? ORDER BY updated_at",
            (room_id,),
        ).fetchall()

    members = []
    slot_sets = []
    for r in rows:
        slots = [int(x) for x in r["busy_slots"].split(",") if x]
        members.append({
            "name": r["name"], "busy_slots": slots,
            "editable": r["owner_hash"] == browser_hash,
        })
        slot_sets.append(set(slots))

    result = compute_recommendations(slot_sets) if slot_sets else {
        "free_slots": [],
        "recommendations": [],
    }
    confirmed_meeting = None
    if room["confirmed_start_slot"] is not None:
        confirmed_meeting = {
            "start_slot": room["confirmed_start_slot"],
            "minutes": MIN_MEETING_SLOTS * SLOT_MINUTES,
            "is_valid": meeting_is_available(room, slot_sets, room["confirmed_start_slot"]),
        }
    return {
        "room_id": room["id"],
        "title": room["title"],
        "members": members,
        "expected_members": room["expected_members"],
        "is_owner": room["owner_hash"] == browser_hash,
        "confirmed_meeting": confirmed_meeting,
        **result,
    }


@app.put("/api/rooms/{room_id}/timetable")
def save_timetable(room_id: str, body: TimetableSave, request: Request):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        room = db.execute(
            "SELECT id FROM rooms WHERE id = ?", (room_id,)
        ).fetchone()
        if room is None:
            raise HTTPException(status_code=404, detail="room not found")
        browser_hash = get_browser_hash(request)
        if browser_hash is None:
            raise HTTPException(status_code=403, detail="편집 권한을 확인할 수 없어요. 방 페이지를 다시 열어주세요.")
        cursor = db.execute(
            """
            INSERT INTO members (room_id, name, busy_slots, owner_hash, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(room_id, name)
            DO UPDATE SET busy_slots = excluded.busy_slots,
                          updated_at = CURRENT_TIMESTAMP
            WHERE members.owner_hash = excluded.owner_hash
            """,
            (room_id, body.name, ",".join(map(str, body.busy_slots)), browser_hash),
        )
        if cursor.rowcount == 0:
            raise HTTPException(
                status_code=403,
                detail="이 닉네임은 처음 저장한 브라우저에서만 수정할 수 있어요. 기존 시간표에 권한이 없다면 다른 닉네임을 사용해주세요.",
            )
    return {"ok": True}


@app.put("/api/rooms/{room_id}/meeting")
def confirm_meeting(room_id: str, body: MeetingConfirm, request: Request):
    with get_db() as db:
        # Serialize validation and confirmation with timetable writes.
        db.execute("BEGIN IMMEDIATE")
        room = db.execute(
            "SELECT owner_hash, expected_members FROM rooms WHERE id = ?", (room_id,)
        ).fetchone()
        if room is None:
            raise HTTPException(status_code=404, detail="room not found")
        browser_hash = get_browser_hash(request)
        if browser_hash is None or room["owner_hash"] != browser_hash:
            raise HTTPException(status_code=403, detail="회의는 방을 만든 브라우저에서만 확정할 수 있어요.")
        rows = db.execute("SELECT busy_slots FROM members WHERE room_id = ?", (room_id,)).fetchall()
        slot_sets = [{int(value) for value in row["busy_slots"].split(",") if value} for row in rows]
        if len(slot_sets) < (room["expected_members"] or 1):
            raise HTTPException(status_code=409, detail="아직 필요한 인원의 시간표가 모두 저장되지 않았어요.")
        if not meeting_is_available(room, slot_sets, body.start_slot):
            raise HTTPException(status_code=409, detail="이 시간에는 참석할 수 없는 팀원이 있어요. 다른 공강을 선택해주세요.")
        db.execute("UPDATE rooms SET confirmed_start_slot = ? WHERE id = ?", (body.start_slot, room_id))
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/r/{room_id}")
def room_page(room_id: str):
    return FileResponse(STATIC_DIR / "room.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
