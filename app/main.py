"""Gonggang-Meet: find shared free slots for university team meetings."""
import re
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR.parent / "gonggang.db"
STATIC_DIR = BASE_DIR / "static"

# Grid constants: Mon-Fri (5 days), 09:00-21:00 in 30-min slots (24 per day)
DAYS = 5
SLOTS_PER_DAY = 24
TOTAL_SLOTS = DAYS * SLOTS_PER_DAY
MIN_MEETING_SLOTS = 2  # 60 minutes

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


init_db()


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    # Never leak internals (stack traces, paths) to the client.
    return JSONResponse(status_code=500, content={"detail": "server error"})


class RoomCreate(BaseModel):
    title: str = Field(min_length=1, max_length=50)

    @field_validator("title")
    @classmethod
    def strip_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title must not be blank")
        return v


class TimetableSave(BaseModel):
    name: str = Field(min_length=1, max_length=20)
    busy_slots: list[int] = Field(max_length=TOTAL_SLOTS)

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
def create_room(body: RoomCreate):
    room_id = secrets.token_urlsafe(8)  # unguessable room token
    with get_db() as db:
        db.execute(
            "INSERT INTO rooms (id, title) VALUES (?, ?)", (room_id, body.title)
        )
    return {"room_id": room_id}


@app.get("/api/rooms/{room_id}")
def get_room(room_id: str):
    with get_db() as db:
        room = db.execute(
            "SELECT id, title FROM rooms WHERE id = ?", (room_id,)
        ).fetchone()
        if room is None:
            raise HTTPException(status_code=404, detail="room not found")
        rows = db.execute(
            "SELECT name, busy_slots FROM members WHERE room_id = ? ORDER BY updated_at",
            (room_id,),
        ).fetchall()

    members = []
    slot_sets = []
    for r in rows:
        slots = [int(x) for x in r["busy_slots"].split(",") if x]
        members.append({"name": r["name"], "busy_slots": slots})
        slot_sets.append(set(slots))

    result = compute_recommendations(slot_sets) if slot_sets else {
        "free_slots": [],
        "recommendations": [],
    }
    return {
        "room_id": room["id"],
        "title": room["title"],
        "members": members,
        **result,
    }


@app.put("/api/rooms/{room_id}/timetable")
def save_timetable(room_id: str, body: TimetableSave):
    with get_db() as db:
        room = db.execute(
            "SELECT id FROM rooms WHERE id = ?", (room_id,)
        ).fetchone()
        if room is None:
            raise HTTPException(status_code=404, detail="room not found")
        db.execute(
            """
            INSERT INTO members (room_id, name, busy_slots, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(room_id, name)
            DO UPDATE SET busy_slots = excluded.busy_slots,
                          updated_at = CURRENT_TIMESTAMP
            """,
            (room_id, body.name, ",".join(map(str, body.busy_slots))),
        )
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/r/{room_id}")
def room_page(room_id: str):
    return FileResponse(STATIC_DIR / "room.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
