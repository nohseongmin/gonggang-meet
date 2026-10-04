/* Gonggang-Meet room page: timetable grid + free-time highlight + recommendations */
(() => {
  const DAYS = ['월', '화', '수', '목', '금'];
  const SLOTS_PER_DAY = 24; // 09:00-21:00, 30-min
  const roomId = decodeURIComponent(location.pathname.split('/r/')[1] || '');

  const grid = document.getElementById('grid');
  const errEl = document.getElementById('error');
  const nameInput = document.getElementById('name');
  const myBusy = new Set();
  let freeSlots = new Set();
  let memberCount = 0;
  let members = [];
  let canConfirm = false;
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
    const member = members.find((m) => m.name === nameInput.value.trim());
    if (member && !member.editable) return showError('이 시간표는 처음 저장한 브라우저에서만 수정할 수 있어요. 다른 닉네임을 사용해주세요.');
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

  // 같은 브라우저가 소유한 시간표만 편집 대상으로 불러온다.
  function loadMyBusyFor(name) {
    const found = members.find((m) => m.name === name);
    if (!found) return; // 저장된 적 없는 닉네임이면 지금 칠하고 있는 내용을 건드리지 않는다.
    if (!found.editable) return showError('이 닉네임의 편집 권한이 없어요. 다른 닉네임을 사용해주세요.');
    myBusy.clear();
    found.busy_slots.forEach((s) => myBusy.add(s));
    paint();
  }
  nameInput.addEventListener('change', () => loadMyBusyFor(nameInput.value.trim()));

  async function load() {
    errEl.hidden = true;
    const res = await fetch('/api/rooms/' + encodeURIComponent(roomId));
    if (!res.ok) {
      if (res.status === 404) {
        document.getElementById('room-title').textContent = '방을 찾을 수 없어요';
      } else {
        showError('방 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.');
      }
      return;
    }
    const data = await res.json();
    document.getElementById('room-title').textContent = data.title;
    memberCount = data.members.length;
    members = data.members;
    freeSlots = new Set(data.free_slots);
    const responseCount = document.getElementById('response-count');
    const allResponded = !data.expected_members || memberCount >= data.expected_members;
    responseCount.textContent = data.expected_members
      ? '시간표 응답 ' + memberCount + ' / ' + data.expected_members + '명' + (allResponded ? ' · 모두 응답했어요.' : ' · 아직 응답하지 않은 팀원이 있어요.')
      : '시간표 응답 ' + memberCount + '명 · 이 방은 전체 팀 인원이 설정되지 않았어요.';
    canConfirm = data.is_owner && allResponded && memberCount > 0;
    const confirmed = document.getElementById('confirmed-meeting');
    const meeting = data.confirmed_meeting;
    confirmed.className = meeting && !meeting.is_valid ? 'error' : '';
    confirmed.textContent = meeting
      ? (meeting.is_valid ? '확정된 회의: ' : '시간표가 바뀌어 다시 확인해야 해요: ') + slotLabel(meeting.start_slot) + '부터 ' + meeting.minutes + '분'
      : (data.is_owner ? '팀원 응답이 모이면 추천 시간의 처음 60분을 확정할 수 있어요.' : '방을 만든 사람이 회의 시간을 확정할 수 있어요.');
    if (!nameInput.value.trim()) {
      const mine = members.find((m) => m.editable);
      if (mine) {
        nameInput.value = mine.name;
        loadMyBusyFor(mine.name);
      }
    }

    const chips = document.getElementById('member-chips');
    chips.textContent = '';
    data.members.forEach((m) => {
      const span = document.createElement('span');
      span.className = 'chip';
      span.textContent = m.name + (m.editable ? ' (내 시간표)' : ''); // textContent: XSS-safe
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
        if (data.is_owner) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary';
          button.textContent = '처음 60분 확정';
          button.disabled = !canConfirm;
          const [hour, minute] = r.start.split(':').map(Number);
          const startSlot = r.day * SLOTS_PER_DAY + (hour - 9) * 2 + minute / 30;
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              const res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/meeting', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ start_slot: startSlot }),
              });
              if (!res.ok) {
                const problem = await res.json();
                showError(typeof problem.detail === 'string' ? problem.detail : '회의를 확정하지 못했어요. 응답을 새로고침해주세요.');
                return;
              }
              await load();
            } catch {
              showError('회의 확정에 실패했어요. 네트워크를 확인해주세요.');
            } finally {
              button.disabled = !canConfirm;
            }
          });
          li.appendChild(button);
        }
        list.appendChild(li);
      });
    }
    paint();
  }

  function slotLabel(slot) {
    const minutes = (slot % SLOTS_PER_DAY) * 30;
    return DAYS[Math.floor(slot / SLOTS_PER_DAY)] + '요일 ' + String(9 + Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  }

  document.getElementById('save').addEventListener('click', async () => {
    errEl.hidden = true;
    const name = document.getElementById('name').value.trim();
    if (!name) return showError('닉네임을 입력해주세요.');
    const saveButton = document.getElementById('save');
    saveButton.disabled = true;
    try {
      const res = await fetch(
        '/api/rooms/' + encodeURIComponent(roomId) + '/timetable',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, busy_slots: [...myBusy] }),
        }
      );
      if (!res.ok) {
        const problem = await res.json();
        showError(typeof problem.detail === 'string' ? problem.detail : '닉네임은 20자 이내의 문자, 숫자, 공백, ., -, _만 사용할 수 있어요.');
        return;
      }
      await load();
    } catch {
      showError('저장에 실패했어요. 닉네임은 20자 이내의 문자, 숫자, 공백, ., -, _만 사용할 수 있어요. 네트워크도 확인해주세요.');
    } finally {
      saveButton.disabled = false;
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

  document.getElementById('refresh').addEventListener('click', () => {
    load().catch(() => showError('응답을 불러오지 못했어요. 네트워크를 확인해주세요.'));
  });

  buildGrid();
  load().catch(() => showError('방 정보를 불러오지 못했어요. 네트워크를 확인하고 새로고침해주세요.'));
})();
