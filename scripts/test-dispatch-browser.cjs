// Real Chromium + isolated PostgreSQL fixture. No changes to restaurant data.
require('reflect-metadata');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const express = require('express');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { AppModule } = require('../apps/api/dist/app.module');
const { configureApp } = require('../apps/api/dist/configure-app');
const {
  UsersService,
} = require('../apps/api/dist/modules/users/users.service');
const root = require('node:path').resolve(__dirname, '..');
(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const schema = 'dispatch_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const profile = fs.mkdtempSync('/tmp/dukanos-dispatch-');
  let app, chrome, browser;
  const clients = [];
  const external = [],
    failures = [];
  try {
    assert.ok(
      process.env.CHROME_BINARY,
      'Set CHROME_BINARY to a local Chromium executable',
    );
    const migrated = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(migrated.status, 0, migrated.stderr);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    app.use(express.static(root + '/apps/web/dist'));
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const users = app.get(UsersService),
      password = randomUUID() + '!';
    const owner = await users.create({
      username: 'owner',
      name: 'Owner',
      password,
      roles: ['OWNER'],
    });
    for (const [username, roles] of Object.entries({
      cashier: ['CASHIER'],
      cook: ['KITCHEN'],
      multi: ['CASHIER', 'DISPATCH'],
      dispatcher: ['DISPATCH'],
    }))
      await users.create({ username, name: username, password, roles }, owner);
    const login = await fetch(origin + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DukanOS-Request': '1' },
      body: JSON.stringify({ username: 'owner', password }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    async function ownerCall(path, body) {
      const r = await fetch(origin + '/api' + path, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'X-DukanOS-Request': '1',
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 201);
      return r.json();
    }
    const category = await ownerCall('/menu/categories', {
      name: 'Kitchen dishes',
    });
    for (const [name, variants] of [
      ['Manchurian', ['Half', 'Full']],
      ['Soya Chaap Gravy', ['Half', 'Full']],
    ])
      await ownerCall('/menu/items', {
        categoryId: category.id,
        name,
        variants: variants.map((name) => ({
          name,
          channels: ['COUNTER', 'ZOMATO', 'SWIGGY'].map((channelCode) => ({
            channelCode,
            price: '100',
            available: true,
          })),
        })),
      });
    chrome = spawn(
      process.env.CHROME_BINARY,
      [
        '--no-sandbox',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        '--disable-background-networking',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const endpoint = await new Promise((resolve, reject) => {
      let out = '';
      chrome.stderr.on('data', (d) => {
        out += d;
        const m = out.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      chrome.on('error', reject);
    });
    async function connect(address) {
      const socket = new globalThis.WebSocket(address);
      await new Promise((r) =>
        socket.addEventListener('open', r, { once: true }),
      );
      let sequence = 0;
      const pending = new Map();
      const handlers = [];
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      socket.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (m.error) p.reject(Error(JSON.stringify(m.error)));
          else p.resolve(m.result);
        } else for (const h of handlers) h(m);
      });
      return { socket, send, handlers };
    }
    browser = await connect(endpoint);
    async function device(username) {
      const ctx = (await browser.send('Target.createBrowserContext'))
        .browserContextId;
      const target = (
        await browser.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: ctx,
        })
      ).targetId;
      const c = await connect(
        endpoint.replace(/\/devtools\/browser\/.*/, '/devtools/page/' + target),
      );
      clients.push(c);
      c.hold = false;
      c.fail = false;
      c.held = [];
      c.payloads = [];
      c.handlers.push((m) => {
        if (m.method === 'Runtime.exceptionThrown')
          failures.push(m.params.exceptionDetails.text);
        if (m.method !== 'Fetch.requestPaused') return;
        const r = m.params,
          local =
            r.request.url.startsWith(origin) ||
            r.request.url.startsWith('data:');
        if (!local) external.push(r.request.url);
        if (
          r.request.url.endsWith('/api/orders/counter') &&
          r.request.method === 'POST'
        )
          c.payloads.push(JSON.parse(r.request.postData));
        const kitchen = r.request.url.endsWith('/api/dispatch/orders');
        if (kitchen && c.hold) {
          c.held.push(r.requestId);
          return;
        }
        void c.send(
          !local || (kitchen && c.fail)
            ? 'Fetch.failRequest'
            : 'Fetch.continueRequest',
          !local || (kitchen && c.fail)
            ? { requestId: r.requestId, errorReason: 'InternetDisconnected' }
            : { requestId: r.requestId },
        );
      });
      c.read = async (expression) => {
        const r = await c.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
        return r.result.value;
      };
      c.wait = async (expression) => {
        for (let i = 0; i < 150; i++) {
          if (await c.read(expression)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw Error(
          'Timed out: ' +
            expression +
            ' PAGE: ' +
            (await c.read('document.body.innerText')),
        );
      };
      c.click = async (text) => {
        await c.read(
          `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click();})()`,
        );
      };
      c.fill = async (selector, value) =>
        c.read(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
      c.http = async (path, method = 'GET') =>
        c.read(
          `fetch('/api'+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'X-DukanOS-Request':'1'}}).then(async r=>({status:r.status,body:await r.json()}))`,
        );
      await c.send('Runtime.enable');
      await c.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await c.send('Page.navigate', { url: origin });
      await c.wait("!!document.querySelector('input[name=username]')");
      await c.read(
        `(()=>{document.querySelector('[name=username]').value=${JSON.stringify(username)};document.querySelector('[name=password]').value=${JSON.stringify(password)};document.querySelector('form').requestSubmit();})()`,
      );
      await c.wait("!!document.querySelector('nav')");
      return c;
    }
    const cashier = await device('cashier'),
      cook = await device('cook'),
      a = await device('dispatcher'),
      b = await device('multi');
    for (const c of [a, b]) {
      await c.read("location.hash='/dispatch'");
      await c.wait(
        "document.querySelector('.dispatch')?.textContent.includes('No orders waiting')",
      );
    }
    await cook.read("location.hash='/kitchen'");
    await cook.wait("!!document.querySelector('.kds-columns')");
    assert.ok(
      !(
        await cashier.read("document.querySelector('nav').textContent")
      ).includes('Dispatch'),
    );
    assert.ok(
      !(await cook.read("document.querySelector('nav').textContent")).includes(
        'Dispatch',
      ),
    );
    await cashier.read("location.hash='/pos'");
    await cashier.wait("document.querySelectorAll('.pos-card').length===2");
    async function add(name, portion, quantity, note) {
      await cashier.read(
        `[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`,
      );
      await cashier.wait("!!document.querySelector('.portion-add')");
      for (let i = 0; i < quantity; i++)
        await cashier.read(
          `document.querySelector('button[aria-label="Increase ${portion} quantity"]').click()`,
        );
      if (note) {
        await cashier.read(
          `[...document.querySelectorAll('.portion-row')].find(r=>r.querySelector('.portion-name strong').textContent===${JSON.stringify(portion)}).querySelector('button[aria-label^="Add instruction"]').click()`,
        );
        await cashier.fill('dialog textarea', note);
      }
      await cashier.read("document.querySelector('.portion-add').click()");
    }
    async function confirm(token) {
      await cashier.click('Confirm Order');
      await cashier.wait(
        "!!document.querySelector('.payment-review .payment-choices')",
      );
      await cashier.click('Pay Later');
      await cashier.wait(
        `document.querySelector('.order-token')?.textContent==='TOKEN #${token}'`,
      );
    }

    await add('Manchurian', 'Half', 1, 'No onion');
    await add('Manchurian', 'Full', 2, 'Extra spicy');
    await confirm(1);
    await cashier.click('New Order');
    await add('Soya Chaap Gravy', 'Full', 2);
    await confirm(2);
    await cashier.click('New Order');
    await add('Manchurian', 'Half', 3);
    await confirm(3);
    await cook.wait("document.querySelectorAll('.kds-card').length===3");
    const ids = (await cook.http('/kitchen/orders')).body.queued.map(
      (o) => o.orderId,
    );
    for (const id of ids) {
      await cook.read(
        `document.querySelector('[data-order-id="${id}"] button').click()`,
      );
      await cook.wait(
        `!!document.querySelector('.kds-preparing [data-order-id="${id}"]')`,
      );
    }
    assert.equal((await a.http('/dispatch/orders')).body.orders.length, 0);
    // Finish cooking in a different order from tokens; Dispatch must follow READY age.
    for (const id of [ids[1], ids[0], ids[2]]) {
      await cook.read(
        `document.querySelector('[data-order-id="${id}"] button').click()`,
      );
      await cook.wait(`!document.querySelector('[data-order-id="${id}"]')`);
    }
    for (const c of [a, b])
      await c.wait("document.querySelectorAll('.dispatch-card').length===3");
    assert.deepEqual(
      await a.read(
        "[...document.querySelectorAll('.dispatch-card')].map(e=>e.dataset.orderId)",
      ),
      [ids[1], ids[0], ids[2]],
    );
    assert.ok(await a.read("!!document.querySelector('.dispatch-new-label')"));
    assert.equal(
      await a.read("document.querySelectorAll('.dispatch-note').length"),
      2,
    );
    assert.equal(
      await a.read(
        `document.querySelector('[data-order-id="${ids[0]}"] .dispatch-dish').querySelectorAll('.dispatch-line').length`,
      ),
      2,
    );
    assert.equal(
      await a.read("document.querySelectorAll('.dispatch-dish h3').length"),
      3,
    );
    assert.doesNotMatch(
      await a.read("document.querySelector('.dispatch').innerText"),
      /subtotal|Start Order|Production|[0-9a-f]{8}-/i,
    );
    assert.ok(
      await a.read(
        "[...document.querySelectorAll('.dispatch-action')].every(e=>e.getBoundingClientRect().height>=48)",
      ),
    );
    assert.equal(
      await a.read(
        "getComputedStyle(document.querySelector('.dispatch-grid')).gridTemplateColumns.split(' ').length",
      ),
      3,
    );
    let shot = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      '/tmp/dukanos-dispatch-desktop.png',
      Buffer.from(shot.data, 'base64'),
    );
    await a.send('Emulation.setDeviceMetricsOverride', {
      width: 768,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(
      await a.read(
        "getComputedStyle(document.querySelector('.dispatch-grid')).gridTemplateColumns.split(' ').length",
      ),
      2,
    );
    shot = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      '/tmp/dukanos-dispatch-tablet.png',
      Buffer.from(shot.data, 'base64'),
    );
    await a.send('Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(
      await a.read(
        "getComputedStyle(document.querySelector('.dispatch-grid')).gridTemplateColumns.split(' ').length",
      ),
      1,
    );
    assert.ok(await a.read('document.documentElement.scrollWidth<=innerWidth'));
    // First handover disappears and is persisted.
    await a.read(
      `document.querySelector('[data-order-id="${ids[0]}"] button').click()`,
    );
    await a.wait(`!document.querySelector('[data-order-id="${ids[0]}"]')`);
    await b.wait("document.querySelectorAll('.dispatch-card').length===2");
    assert.equal(
      (await cashier.http('/orders/' + ids[0])).body.status,
      'COMPLETED',
    );
    assert.equal(
      (await cashier.http('/dispatch/orders/' + ids[1] + '/complete', 'POST'))
        .status,
      403,
    );
    assert.equal(
      (await cook.http('/dispatch/orders/' + ids[1] + '/complete', 'POST'))
        .status,
      403,
    );
    // Hold B's queue fetch to model stale state, but allow the command through.
    b.hold = true;
    await a.read(
      `document.querySelector('[data-order-id="${ids[1]}"] button').click()`,
    );
    await a.wait(`!document.querySelector('[data-order-id="${ids[1]}"]')`);
    await b.read(
      `document.querySelector('[data-order-id="${ids[1]}"] button').click()`,
    );
    await b.wait(
      "document.querySelector('[role=status]')?.textContent.includes('already updated')",
    );
    b.hold = false;
    for (const requestId of b.held)
      await b.send('Fetch.continueRequest', { requestId });
    b.held = [];
    await b.wait(`!document.querySelector('[data-order-id="${ids[1]}"]')`);
    b.fail = true;
    await b.wait(
      "document.querySelector('[role=alert]')?.textContent.includes('paused')",
    );
    assert.equal(
      await b.read("document.querySelectorAll('.dispatch-action').length"),
      0,
    );
    b.fail = false;
    await b.read("window.dispatchEvent(new Event('online'))");
    await b.wait("document.querySelectorAll('.dispatch-card').length===1");
    await b.read("location.hash='/pos'");
    await b.wait("document.querySelectorAll('.pos-card').length===2");
    await b.read("location.hash='/dispatch'");
    await b.wait("document.querySelectorAll('.dispatch-card').length===1");
    await b.click('Handed Over');
    await b.wait(
      "document.querySelector('.dispatch')?.textContent.includes('No orders waiting')",
    );
    await b.send('Page.reload');
    await b.wait(
      "document.querySelector('.dispatch')?.textContent.includes('No orders waiting')",
    );
    const history = await admin.query(
      `SELECT order_id,to_status,count(*)::int AS n FROM "${schema}".order_status_history GROUP BY order_id,to_status`,
    );
    assert.equal(history.rows.length, 12);
    assert.ok(history.rows.every((h) => h.n === 1));
    // An old order with a recent READY transition checks READY age, not total order age.
    await admin.query(`SET search_path TO "${schema}"`);
    const old = randomUUID();
    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||jsonb_build_object('id',$2::text,'request_id',$3::text,'status','QUEUED','business_date','2000-01-01','queued_at','2000-01-01T10:00:00Z','token_number',1))).* FROM orders o WHERE id=$1`,
      [ids[0], old, randomUUID()],
    );
    await admin.query(
      `INSERT INTO order_items SELECT (jsonb_populate_record(NULL::order_items,to_jsonb(i)||jsonb_build_object('id',gen_random_uuid(),'order_id',$2::text))).* FROM order_items i WHERE order_id=$1`,
      [ids[0], old],
    );
    const creator = (
      await admin.query('SELECT confirmed_by FROM orders WHERE id=$1', [old])
    ).rows[0].confirmed_by;
    for (const [from, to, time] of [
      ['DRAFT', 'QUEUED', "'2000-01-01T10:00:00Z'"],
      ['QUEUED', 'PREPARING', "'2000-01-01T10:01:00Z'"],
      ['PREPARING', 'READY', "clock_timestamp()-interval '6 minutes'"],
    ]) {
      await admin.query(
        `INSERT INTO order_status_history VALUES($1,$2,$3,$4,$5,${time},'Historical dispatch fixture')`,
        [randomUUID(), old, from, to, creator],
      );
      if (to === 'QUEUED') await admin.query('COMMIT');
    }
    await a.wait("!!document.querySelector('.dispatch-late')");
    assert.match(
      await a.read("document.querySelector('.dispatch-age').textContent"),
      /LATE · Ready 6 min/,
    );
    assert.equal(
      await a.read("document.querySelector('.dispatch-card time').textContent"),
      '2000-01-01',
    );
    await a.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    assert.equal(
      await a.read(
        "getComputedStyle(document.querySelector('.dispatch-late')).animationName",
      ),
      'none',
    );
    await a.click('Handed Over');
    await a.wait(
      "document.querySelector('.dispatch')?.textContent.includes('No orders waiting')",
    );
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    console.log(
      'Browser PASS: three CASHIER POS orders, Kitchen START/READY, oldest-ready Dispatch ordering, notes/portion grouping, handover, duplicate-device conflict/refetch, recovery/reload, CASHIER/KITCHEN denial, DISPATCH and multi-role handover, desktop/tablet/narrow grid, historical READY age and static late attention. External requests blocked; isolated schema only.',
    );
  } finally {
    for (const c of clients) c.socket.close();
    browser?.socket.close();
    if (chrome) {
      chrome.kill();
      await new Promise((r) => chrome.once('exit', r));
    }
    if (app) await app.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
