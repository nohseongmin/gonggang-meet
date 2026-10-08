# Gonggang Meet

Find meeting times from a team's class schedules. Each member enters their recurring timetable, and the app recommends the three longest shared breaks.

## Screenshots

| Create a room | Availability and recommendations |
|---|---|
| ![Landing page](docs/screenshot-landing.png) | ![Room page](docs/screenshot-room.png) |

## Using the app

1. Create a room with a team name and member count, including yourself.
2. Share the room link, `/r/<random-token>`. No signup is required.
3. Enter a nickname and drag across the timetable to mark classes. The grid covers Monday–Friday, 09:00–21:00.
4. Save and review the response count and three recommended meeting times. Refresh responses to load other members' changes.
5. Once everyone has responded, the room creator can confirm the first 60 minutes of a recommended slot. Later timetable conflicts trigger a warning.
6. Edit a timetable using the same nickname in the browser that first saved it. Other browsers cannot overwrite it.

Recommendations use the schedules submitted so far. [compute_recommendations](app/main.py) combines occupied 30-minute slots, finds shared free blocks lasting at least 60 minutes, and sorts them by length, then by earliest day and time.

## Running locally

```bash
git clone https://github.com/nohseongmin/gonggang-meet.git
cd gonggang-meet
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8377
```

Open `http://127.0.0.1:8377`. SQLite creates `gonggang.db` on first startup.

With Docker:

```bash
docker compose up -d
```

The database is stored in the `gonggang-data` volume. Set `GONGGANG_DB` to change its path.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
node --test tests/*.test.cjs
```

CI checks API behavior, permissions, upgrades of existing databases, and browser error handling on pull requests and main.

## Structure

```text
BLUEPRINT.md          Project scope and design notes
requirements.txt      Python dependencies
app/main.py           FastAPI routes and recommendations
app/static/index.html Room creation
app/static/room.html  Timetable, heatmap, and recommendations
app/static/room.js    Input and rendering
app/static/style.css  Styles
```

## Permissions and data

SQLite queries use parameter binding. Pydantic checks nickname and room-name lengths, allowed characters, and slot ranges; invalid input returns 422. User text is rendered with `textContent`. Room links use `secrets.token_urlsafe`, and exception responses omit internal details.

The app collects nicknames and timetable slots. It does not request email addresses, student numbers, or real names. Editing rights use random tokens in HttpOnly, SameSite cookies; only token hashes are stored in the database.

Clearing browser data or switching devices loses the original editing rights. Anyone with the room link can view schedules and submit a new nickname. Response counts therefore count saved nicknames, not verified identities.

Startup adds columns to existing databases while preserving data. Legacy rooms and schedules remain read-only because their owners cannot be established. Create a new room to use permissions, member counts, and meeting confirmation. Back up production databases before upgrading.

## Status and planned work

- Room creation, timetable input, availability heatmaps, and recommendations are implemented.
- Timetable ownership, response counts, and creator-only meeting confirmation are implemented.
- Deployment and testing with real teams are pending.
- Planned additions include Everytime timetable imports, meeting votes, KakaoTalk share cards, and weekend or evening slots.

See [BLUEPRINT.md](BLUEPRINT.md) for market research and the proposed operating model.

## License

MIT.
