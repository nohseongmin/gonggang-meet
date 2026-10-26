// Run with: node --test tests/room-drag.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../app/static/room.js'), 'utf8');

for (const eventType of ['pointerup', 'pointercancel', 'blur']) {
  test('timetable drag ignores non-primary buttons, stops after ' + eventType + ' and can restart', async () => {
    const elements = new Map();
    const element = () => ({
      textContent: '',
      hidden: true,
      value: '',
      dataset: {},
      handlers: {},
      appendChild() {},
      querySelectorAll() { return []; },
      addEventListener(type, handler) { this.handlers[type] = handler; },
    });
    const document = {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
    };
    const windowHandlers = {};
    const requests = [];
    const room = {
      title: '팀플', members: [], free_slots: [], recommendations: [],
      expected_members: 1, is_owner: false, confirmed_meeting: null,
    };
    vm.runInNewContext(source, {
      document,
      location: { pathname: '/r/test-room' },
      window: { addEventListener(type, handler) { windowHandlers[type] = handler; } },
      fetch: async (url, options) => {
        if (options) requests.push({ url, options });
        return { ok: true, json: async () => room };
      },
    });
    await new Promise(setImmediate);
    elements.get('name').value = '가람';
    const grid = elements.get('grid');
    const pointer = (slot) => ({
      button: 0,
      target: { closest: () => ({ dataset: { slot: String(slot) } }) },
      preventDefault() {},
    });

    for (const [button, slot] of [[1, 5], [2, 7]]) {
      grid.handlers.pointerdown({ ...pointer(slot), button });
      grid.handlers.pointerover(pointer(slot + 1));
      windowHandlers.pointerup();
    }

    grid.handlers.pointerdown(pointer(0));
    grid.handlers.pointerover(pointer(1));
    windowHandlers[eventType]?.();
    grid.handlers.pointerover(pointer(2));
    grid.handlers.pointerdown(pointer(3));
    windowHandlers.pointerup();
    grid.handlers.pointerover(pointer(4));
    await elements.get('save').handlers.click();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/rooms/test-room/timetable');
    assert.equal(requests[0].options.method, 'PUT');
    assert.deepEqual(JSON.parse(requests[0].options.body), { name: '가람', busy_slots: [0, 1, 3] });
    assert.equal(elements.get('error').hidden, true);
  });
}
