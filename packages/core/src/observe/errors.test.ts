import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorFingerprint, groupErrors, parseErrorText, parseSpanError } from './errors.ts';

test('errors are read from the stack traces each runtime prints, keeping the own top frame', () => {
  assert.deepEqual(parseErrorText('java.lang.IllegalStateException: pool exhausted after 30000ms\n\tat java.base/java.util.Objects.requireNonNull(Objects.java:233)\n\tat com.shop.orders.Pool.take(Pool.java:88)\n\tat com.shop.orders.Api.create(Api.java:41)'),
    { type: 'java.lang.IllegalStateException', message: 'pool exhausted after 30000ms', frame: 'Pool.java com.shop.orders.Pool.take' });
  assert.deepEqual(parseErrorText('Traceback (most recent call last):\n  File "/usr/lib/python3/site-packages/flask/app.py", line 1, in wsgi\n  File "/srv/app/cart.py", line 77, in total\nKeyError: \'sku-1182\''),
    { type: 'KeyError', message: "'sku-1182'", frame: '/srv/app/cart.py total' });
  assert.deepEqual(parseErrorText('panic: runtime error: invalid memory address or nil pointer dereference\n\ngoroutine 1 [running]:\nmain.(*Server).handle(0x0)\n\t/app/server.go:120 +0x1d\nmain.main()\n\t/app/main.go:9'),
    { type: 'panic', message: 'runtime error: invalid memory address or nil pointer dereference', frame: '/app/server.go main.(*Server).handle' });
  assert.deepEqual(parseErrorText("TypeError: Cannot read properties of undefined (reading 'id')\n    at Object.<anonymous> (/app/node_modules/express/router.js:10:3)\n    at handler (/app/src/orders.js:44:19)"),
    { type: 'TypeError', message: "Cannot read properties of undefined (reading 'id')", frame: '/app/src/orders.js handler' });
  assert.deepEqual(parseErrorText('time=2026-10-18T10:00:00Z level=error msg="payment provider timeout after 5s" order=4411'), { type: 'error', message: 'payment provider timeout after 5s', frame: null });
  assert.equal(parseErrorText('GET /health 200 3ms'), null);
});

test('one group per type, own frame and masked message; the service keeps teams apart', () => {
  const e = (msg: string) => ({ type: 'java.lang.IllegalStateException', message: msg, frame: 'Pool.java Pool.take' });
  assert.equal(errorFingerprint('orders', e('pool exhausted after 30000ms')), errorFingerprint('orders', e('pool exhausted after 31000ms')));
  assert.notEqual(errorFingerprint('orders', e('pool exhausted after 30000ms')), errorFingerprint('billing', e('pool exhausted after 30000ms')));
  const g = groupErrors([
    { service: 'orders', error: e('pool exhausted after 1ms'), at: 2, example: 'x', source: 'logs' },
    { service: 'orders', error: e('pool exhausted after 2ms'), at: 1, example: 'y', source: 'logs' },
    { service: 'orders', error: { type: 'KeyError', message: "'a'", frame: null }, at: 5, example: 'z', source: 'traces', traceId: 't1' },
  ]);
  assert.deepEqual(g.map((x) => [x.error.type, x.count, x.first, x.last]), [['java.lang.IllegalStateException', 2, 1, 2], ['KeyError', 1, 5, 5]]);
  assert.deepEqual(parseSpanError({ type: 'TimeoutError', message: 'deadline exceeded' }), { type: 'TimeoutError', message: 'deadline exceeded', frame: null });
  assert.equal(parseSpanError({}), null);
});
