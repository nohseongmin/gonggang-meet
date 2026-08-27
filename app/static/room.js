/* Gonggang-Meet room page: timetable grid + heatmap + recommendations */
(() => {
  const DAYS = ['월', '화', '수', '목', '금'];
  const SLOTS_PER_DAY = 24; // 09:00-21:00, 30-min
  const roomId = decodeURIComponent(location.pathname.split('/r/')[1] || '');

  const grid = document.getElementById('grid');
  const errEl = document.getElementById('error');
  const myBusy = new Set();
  let freeSlots = new Set();
  let memberCount = 0;
  let dragging = false;
  let dragMode = 'add';

  // ---- build grid (safe: no user input in innerHTML) ----
  function buildGrid() {
    grid.textContent = '';
    const thead = document.createElement('tr');
    thead.appendChild(document.createElement('th'));
    DAYS.forEach((d) => {
      const th = document.createElement('th');
      th.textContent = d;
      thead.appendChild(th);
    });
    grid.appendChild(thead);

    for (let idx = 0; idx < SLOTS_PER_DAY; idx++) {
      const tr = document.createElement('tr');
      const timeTd = document.createElement('td');
      timeTd.className = 'time';
      const min = idx * 30;
      timeTd.textContent =
        min % 60 === 0 ? String(9 + min / 60).padStart(2, '0') + ':00' : '';
      tr.appendChild(timeTd);
      for (let day = 0; day < DAYS.length; day++) {
        const td = document.createElement('td');
        td.className = 'slot';
        td.dataset.slot = String(day * SLOTS_PER_DAY + idx);
        tr.appendChild(td);
      }
      grid.appendChild(tr);
    }
  }

  function paint() {
    grid.querySelectorAll('td.slot').forEach((td) => {
      const s = Number(td.dataset.slot);
      td.className = 'slot';
      if (myBusy.has(s)) td.classList.add('busy');
      else if (memberCount > 0 && freeSlots.has(s)) td.classList.add('free');
    });
  }

  // ---- drag painting ----
  grid.addEventListener('pointerdown', (e) => {
    const td = e.target.closest('td.slot');
    if (!td) return;
    e.preventDefault();
    dragging = true;
    const s = Number(td.dataset.slot);
    dragMode = myBusy.has(s) ? 'remove' : 'add';
    toggle(s);
  });
  grid.addEventListener('pointerover', (e) => {
    if (!dragging) return;
    const td = e.target.closest('td.slot');
    if (td) toggle(Number(td.dataset.slot));
  });
  window.addEventListener('pointerup', () => (dragging = false));

  function toggle(s) {
    if (dragMode === 'add') myBusy.add(s);
    else myBusy.delete(s);
    paint();
  }

  // ---- data ----
  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  async function load() {
    errEl.hidden = true;
    const res = await fetch('/api/rooms/' + encodeURIComponent(roomId));
    if (!res.ok) {
      document.getElementById('room-title').textContent = '방을 찾을 수 없어요';
      return;
    }
    const data = await res.json();
    document.getElementById('room-title').textContent = data.title;
    memberCount = data.members.length;
    freeSlots = new Set(data.free_slots);

    const chips = document.getElementById('member-chips');
    chips.textContent = '';
    data.members.forEach((m) => {
      const span = document.createElement('span');
      span.className = 'chip';
      span.textContent = m.name; // textContent: XSS-safe
      chips.appendChild(span);
    });
    if (memberCount === 0) {
      const span = document.createElement('span');
      span.className = 'chip';
      span.textContent = '아직 아무도 시간표를 안 넣었어요';
      chips.appendChild(span);
    }

    const list = document.getElementById('reco-list');
    const empty = document.getElementById('reco-empty');
    list.textContent = '';
    if (data.recommendations.length === 0) {
      empty.textContent =
        memberCount === 0
          ? '팀원들이 시간표를 저장하면 추천이 나타나요.'
          : '전원이 60분 이상 겹치는 공강이 없어요 😢 (범위: 평일 09~21시)';
      empty.hidden = false;
    } else {
      empty.hidden = true;
      data.recommendations.forEach((r, i) => {
        const li = document.createElement('li');
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(i + 1) + '순위';
        li.appendChild(badge);
        li.appendChild(
          document.createTextNode(
            DAYS[r.day] + '요일 ' + r.start + ' ~ ' + r.end + ' (' + r.minutes + '분)'
          )
        );
        list.appendChild(li);
      });
    }
    paint();
  }

  document.getElementById('save').addEventListener('click', async () => {
    errEl.hidden = true;
    const name = document.getElementById('name').value.trim();
    if (!name) return showError('닉네임을 입력해주세요.');
    try {
      const res = await fetch(
        '/api/rooms/' + encodeURIComponent(roomId) + '/timetable',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, busy_slots: [...myBusy] }),
        }
      );
      if (!res.ok) throw new Error();
      await load();
    } catch {
      showError('저장에 실패했어요. 닉네임(20자 이내)과 네트워크를 확인해주세요.');
    }
  });

  document.getElementById('clear').addEventListener('click', () => {
    myBusy.clear();
    paint();
  });

  document.getElementById('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      const ok = document.getElementById('copy-ok');
      ok.hidden = false;
      setTimeout(() => (ok.hidden = true), 1500);
    } catch {
      showError('복사 실패 — 주소창의 링크를 직접 복사해주세요.');
    }
  });

  buildGrid();
  load();
})();
