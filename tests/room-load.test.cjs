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
