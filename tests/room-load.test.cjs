// Run with: node --test tests/room-load.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../app/static/room.js'), 'utf8');

for (const status of [404, 500, 503]) {
  test('room load handles HTTP ' + status, async () => {
    const elements = new Map();
    const element = () => ({
      textContent: '',
      hidden: true,
      dataset: {},
      appendChild() {},
      addEventListener() {},
    });
    const document = {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
    };
    document.getElementById('room-title').textContent = '불러오는 중…';

    vm.runInNewContext(source, {
      document,
      location: { pathname: '/r/test-room' },
      window: { addEventListener() {} },
      fetch: async () => ({ ok: false, status }),
    });
    await new Promise(setImmediate);

    if (status === 404) {
      assert.equal(elements.get('room-title').textContent, '방을 찾을 수 없어요');
      assert.equal(elements.get('error').hidden, true);
    } else {
      assert.notEqual(elements.get('room-title').textContent, '방을 찾을 수 없어요');
      assert.equal(elements.get('error').hidden, false);
      assert.equal(elements.get('error').textContent,
        '방 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.');
    }
  });
}

for (const outcome of ['success', 'http-error', 'network-error', 'delayed-json', 'delayed-json-error']) {
  test('room load ignores an older ' + outcome + ' after refresh', async () => {
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
    const room = (title, expectedMembers) => ({
      title,
      members: [],
      free_slots: [],
      recommendations: [],
      expected_members: expectedMembers,
      is_owner: false,
      confirmed_meeting: null,
    });
    let resolveOlder;
    let rejectOlder;
    const older = new Promise((resolve, reject) => {
      resolveOlder = resolve;
      rejectOlder = reject;
    });
    const isDelayedJson = outcome.startsWith('delayed-json');
    let requestCount = 0;
    vm.runInNewContext(source, {
      document,
      location: { pathname: '/r/test-room' },
      window: { addEventListener() {} },
      fetch: async () => {
        requestCount++;
        if (requestCount === 1) {
          return isDelayedJson ? { ok: true, json: () => older } : older;
        }
        return { ok: true, json: async () => room('최신 방', 2) };
      },
    });
    await new Promise(setImmediate);

    elements.get('refresh').handlers.click();
    await new Promise(setImmediate);

    if (outcome === 'network-error' || outcome === 'delayed-json-error') {
      rejectOlder(new Error('offline'));
    } else if (isDelayedJson) {
      resolveOlder(room('이전 방', 1));
    } else {
      resolveOlder(outcome === 'success'
        ? { ok: true, json: async () => room('이전 방', 1) }
        : { ok: false, status: 404 });
    }
    await new Promise(setImmediate);

    assert.equal(requestCount, 2);
    assert.equal(elements.get('room-title').textContent, '최신 방');
    assert.equal(elements.get('response-count').textContent,
      '시간표 응답 0 / 2명 · 아직 응답하지 않은 팀원이 있어요.');
    assert.equal(elements.get('error').hidden, true);
  });
}

for (const operation of ['timetable', 'meeting']) {
  for (const outcome of ['success', 'refresh-network-error', 'refresh-json-error', 'write-network-error', 'write-http-error']) {
    test(operation + ' distinguishes write failures from refresh failures: ' + outcome, async () => {
      const elements = new Map();
      const buttons = [];
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
        createElement(tag) {
          const node = element();
          if (tag === 'button') buttons.push(node);
          return node;
        },
        createTextNode: (text) => ({ textContent: text }),
      };
      const room = {
        title: '팀플',
        members: [{ name: '가람', busy_slots: [], editable: true }],
        free_slots: [],
        recommendations: [{ day: 0, start: '09:00', end: '10:00', minutes: 60 }],
        expected_members: 1,
        is_owner: true,
        confirmed_meeting: null,
      };
      const writes = [];
      let reads = 0;
      vm.runInNewContext(source, {
        document,
        location: { pathname: '/r/test-room' },
        window: { addEventListener() {} },
        fetch: async (url, options) => {
          if (options) {
            writes.push({ url, options });
            if (outcome === 'write-network-error') throw new Error('offline');
            return { ok: outcome !== 'write-http-error', json: async () => ({ detail: '권한이 없어요.' }) };
          }
          reads++;
          if (reads > 1 && outcome === 'refresh-network-error') throw new Error('offline');
          return { ok: true, json: async () => {
            if (reads > 1 && outcome === 'refresh-json-error') throw new SyntaxError('invalid JSON');
            return room;
          } };
        },
      });
      await new Promise(setImmediate);
      const button = operation === 'timetable' ? elements.get('save') : buttons[0];

      await button.handlers.click();

      assert.equal(writes.length, 1);
      assert.equal(writes[0].url, '/api/rooms/test-room/' + operation);
      assert.equal(writes[0].options.method, 'PUT');
      assert.equal(reads, outcome.startsWith('write-') ? 1 : 2);
      assert.equal(button.disabled, false);
      const error = elements.get('error');
      assert.equal(error.hidden, outcome === 'success');
      if (outcome.startsWith('refresh-')) {
        assert.equal(error.textContent, (operation === 'timetable' ? '시간표는 저장했지만' : '회의는 확정했지만')
          + ' 응답을 불러오지 못했어요. 응답을 새로고침해주세요.');
      } else if (outcome === 'write-http-error') {
        assert.equal(error.textContent, '권한이 없어요.');
      } else if (outcome === 'write-network-error') {
        assert.match(error.textContent, operation === 'timetable' ? /^저장에 실패/ : /^회의 확정에 실패/);
      }
    });
  }
}
