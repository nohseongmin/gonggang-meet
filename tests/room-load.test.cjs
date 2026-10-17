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
