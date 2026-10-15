// Run with: node --test tests/room-create.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../app/static/index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

for (const outcome of ['success', 'http-error', 'network-error']) {
  test('room creation blocks duplicate submissions through ' + outcome, async () => {
    const button = { disabled: false };
    const error = { hidden: true, textContent: '' };
    let submit;
    const form = {
      addEventListener(type, handler) {
        assert.equal(type, 'submit');
        submit = handler;
      },
      querySelector(selector) {
        assert.equal(selector, 'button[type="submit"]');
        return button;
      },
    };
    const elements = {
      'create-form': form,
      error,
      title: { value: '팀플' },
      'expected-members': { value: '2' },
    };
    let resolveRequest;
    let rejectRequest;
    const pending = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const success = { ok: true, json: async () => ({ room_id: 'test-room' }) };
    const requests = [];
    const location = { href: '' };
    vm.runInNewContext(source, {
      document: { getElementById: (id) => elements[id] },
      location,
      fetch: (url, options) => {
        requests.push({ url, options });
        return requests.length === 1 ? pending : Promise.resolve(success);
      },
    });
    const event = { preventDefault() {}, currentTarget: form };

    const first = submit(event);
    assert.equal(button.disabled, true);
    await submit(event);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/rooms');
    assert.deepEqual(JSON.parse(requests[0].options.body), { title: '팀플', expected_members: 2 });

    if (outcome === 'network-error') rejectRequest(new Error('offline'));
    else resolveRequest(outcome === 'success' ? success : { ok: false });
    await first;

    if (outcome === 'success') {
      assert.equal(location.href, '/r/test-room');
      assert.equal(button.disabled, true);
      assert.equal(error.hidden, true);
    } else {
      assert.equal(location.href, '');
      assert.equal(button.disabled, false);
      assert.equal(error.hidden, false);
      assert.equal(error.textContent, '방 생성에 실패했어요. 잠시 후 다시 시도해주세요.');
      await submit(event);
      assert.equal(requests.length, 2);
      assert.equal(location.href, '/r/test-room');
      assert.equal(button.disabled, true);
      assert.equal(error.hidden, true);
    }
  });
}
