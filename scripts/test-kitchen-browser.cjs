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
  const schema = 'kitchen_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const profile = fs.mkdtempSync('/tmp/dukanos-kitchen-');
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
      multi: ['CASHIER', 'KITCHEN'],
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
        const kitchen = r.request.url.endsWith('/api/kitchen/orders');
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
      a = await device('cook'),
      b = await device('multi');
    assert.ok(
      !(
        await cashier.read("document.querySelector('nav').textContent")
      ).includes('Kitchen'),
    );
    await a.read("location.hash='/kitchen'");
    await b.read("location.hash='/kitchen'");
    await a.wait(
      "document.querySelector('.kds')?.textContent.includes('No orders waiting')",
    );
    await b.wait("!!document.querySelector('.kds-columns')");
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
        `document.querySelector('.order-token')?.textContent==='TOKEN #${token}'`,
      );
    }
    await add('Manchurian', 'Half', 1, 'Nothing spicy');
    await add('Soya Chaap Gravy', 'Full', 1);
    await confirm(1);
    await a.wait("document.querySelectorAll('.kds-card').length===1");
    await a.wait("!!document.querySelector('.kds-new')");
    await cashier.click('New Order');
    await add('Soya Chaap Gravy', 'Full', 2, 'Extra spicy');
    await confirm(2);
    await cashier.click('New Order');
    await add('Manchurian', 'Half', 2);
    await confirm(3);
    await a.wait("document.querySelectorAll('.kds-card').length===3");
    await b.wait("document.querySelectorAll('.kds-card').length===3");
    assert.deepEqual(
      await a.read(
        "[...document.querySelectorAll('.kds-token')].map(e=>e.textContent)",
      ),
      ['#1', '#2', '#3'],
    );
    assert.equal(
      await a.read(
        "document.querySelectorAll('.kds-action:not(:disabled)').length",
      ),
      1,
    );
    assert.equal(
      await a.read("document.querySelectorAll('.kds-instruction').length"),
      2,
    );
    assert.doesNotMatch(
      await a.read("document.querySelector('.kds').innerText"),
      /₹|subtotal|tax|payment/i,
    );
    const before = (await a.http('/kitchen/orders')).body,
      ids = before.queued.map((o) => o.orderId);
    assert.equal(
      (await b.http('/kitchen/orders/' + ids[1] + '/start', 'POST')).body.code,
      'OLDER_ORDER_WAITING',
    );
    await a.click('Production View');
    assert.ok(
      await a.read(
        'document.querySelector(\'[aria-label="In preparation"]\').getBoundingClientRect().height<90',
      ),
    );
    assert.deepEqual(
      await a.read(
        "[...document.querySelectorAll('.kds-production-total strong')].map(e=>e.textContent)",
      ),
      ['×3', '×3'],
    );
    assert.ok(
      (await a.read("document.querySelector('.kds').textContent")).includes(
        'Nothing spicy',
      ),
    );
    assert.ok(
      (await a.read("document.querySelector('.kds').textContent")).includes(
        'Extra spicy',
      ),
    );
    let shot = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      '/tmp/dukanos-kitchen-production.png',
      Buffer.from(shot.data, 'base64'),
    );
    await a.click('Order View');
    // Keep B's old read outstanding to model a stale tablet, while mutations still work.
    b.hold = true;
    await a.click('Start Order');
    await a.wait(
      `document.querySelector('.kds-preparing [data-order-id="${ids[0]}"]')!==null`,
    );
    await b.click('Start Order');
    await b.wait(
      "document.querySelector('[role=status]')?.textContent.includes('already updated')",
    );
    b.hold = false;
    for (const requestId of b.held)
      await b.send('Fetch.continueRequest', { requestId });
    b.held = [];
    await b.wait(
      `document.querySelector('.kds-preparing [data-order-id="${ids[0]}"]')!==null`,
    );
    await a.click('Production View');
    assert.deepEqual(
      await a.read(
        "[...document.querySelectorAll('.kds-column')].map(c=>[...c.querySelectorAll('.kds-production-total strong')].map(e=>e.textContent))",
      ),
      [
        ['×2', '×2'],
        ['×1', '×1'],
      ],
    );
    await a.click('Order View');
    await a.click('Start Order');
    await a.wait(
      "document.querySelectorAll('.kds-preparing .kds-card').length===2",
    );
    b.fail = true;
    await b.wait(
      "document.querySelector('[role=alert]')?.textContent.includes('paused')",
    );
    await a.read(
      `document.querySelector('[data-order-id="${ids[0]}"] button').click()`,
    );
    await a.wait(`!document.querySelector('[data-order-id="${ids[0]}"]')`);
    b.fail = false;
    await b.read("window.dispatchEvent(new Event('online'))");
    await b.wait(
      `!!document.querySelector('.kds-columns')&&!document.querySelector('[data-order-id="${ids[0]}"]')`,
    );
    const after = (await a.http('/kitchen/orders')).body;
    assert.equal(after.preparing[0].orderId, ids[1]);
    assert.equal(after.queued[0].orderId, ids[2]);
    assert.deepEqual(
      after.production.preparing.map((g) => g.totalQuantity),
      [2],
    );
    const history = await admin.query(
      `SELECT order_id,to_status,count(*)::int AS n FROM "${schema}".order_status_history GROUP BY order_id,to_status`,
    );
    assert.ok(history.rows.every((h) => h.n === 1));
    shot = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      '/tmp/dukanos-kitchen-orders.png',
      Buffer.from(shot.data, 'base64'),
    );
    await a.send('Emulation.setDeviceMetricsOverride', {
      width: 768,
      height: 1024,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.ok(await a.read('document.documentElement.scrollWidth<=innerWidth'));
    assert.ok(
      await a.read(
        "[...document.querySelectorAll('.kds-action')].every(b=>b.getBoundingClientRect().height>=48)",
      ),
    );
    shot = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      '/tmp/dukanos-kitchen-tablet.png',
      Buffer.from(shot.data, 'base64'),
    );
    await b.read("location.hash='/pos'");
    await b.wait("!!document.querySelector('.pos-card')");
    await b.read("location.hash='/kitchen'");
    await b.wait("!!document.querySelector('.kds-columns')");
    assert.equal(
      (await cashier.http('/kitchen/orders/' + ids[2] + '/start', 'POST'))
        .status,
      403,
    );
    // Independent portions of one dish remain separate in Kitchen as well as POS.
    await cashier.click('New Order');
    await add('Manchurian', 'Half', 1, 'Nothing spicy');
    await add('Manchurian', 'Full', 1, 'Extra spicy');
    await confirm(4);
    await a.wait(
      "[...document.querySelectorAll('.kds-token')].some(e=>e.textContent==='#4')",
    );
    const notes = await a.read(
      "(()=>{const card=[...document.querySelectorAll('.kds-card')].find(e=>e.querySelector('.kds-token').textContent==='#4');return {groups:card.querySelectorAll('.kds-dish').length,lines:[...card.querySelectorAll('.kds-line')].map(e=>({portion:e.querySelector('p').textContent,note:e.querySelector('.kds-instruction')?.textContent}))};})()",
    );
    assert.equal(notes.groups, 1);
    assert.deepEqual(notes.lines, [
      { portion: 'Half ×1', note: 'Nothing spicy' },
      { portion: 'Full ×1', note: 'Extra spicy' },
    ]);

    // Pure Kitchen staff changes the existing Counter source of truth.
    await cashier.click('New Order');
    await add('Soya Chaap Gravy', 'Full', 1);
    await a.click('Availability');
    await a.wait(
      "document.querySelector('.kds-availability')?.open && document.querySelectorAll('.availability-dish').length===2",
    );
    await a.fill('.kds-availability input', 'Soya Chaap');
    await a.wait("document.querySelectorAll('.availability-dish').length===1");
    const availabilityButton = (variant, action) =>
      `document.querySelector('button[aria-label="Soya Chaap Gravy / ${variant}: ${action}"]')`;
    await a.read(availabilityButton('Full', 'Mark sold out') + '.click()');
    await a.wait(availabilityButton('Full', 'Make available') + '!==null');
    shot = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      '/tmp/dukanos-kitchen-availability.png',
      Buffer.from(shot.data, 'base64'),
    );
    await cashier.wait(
      "[...document.querySelectorAll('.pos-card')].find(e=>e.textContent.includes('Soya Chaap Gravy')).textContent.includes('Some portions sold out')",
    );
    await cashier.click('Confirm Order');
    await cashier.wait(
      "document.querySelector('.order-cart').textContent.includes('no longer available')",
    );
    await cashier.read(
      "[...document.querySelectorAll('.pos-card')].find(e=>e.textContent.includes('Soya Chaap Gravy')).click()",
    );
    await cashier.wait(
      'document.querySelector(\'button[aria-label="Increase Full quantity"]\').disabled',
    );
    assert.equal(
      await cashier.read(
        'document.querySelector(\'button[aria-label="Increase Half quantity"]\').disabled',
      ),
      false,
    );
    await a.read(availabilityButton('Full', 'Make available') + '.click()');
    await a.wait(availabilityButton('Full', 'Mark sold out') + '!==null');
    await cashier.wait(
      '!document.querySelector(\'button[aria-label="Increase Full quantity"]\').disabled',
    );
    await cashier.read("document.querySelector('.pos-close').click()");
    await a.click('Mark whole dish sold out');
    await a.wait("document.querySelectorAll('.availability-sold').length===2");
    await a.click('Make whole dish available');
    await a.wait("document.querySelectorAll('.availability-sold').length===0");
    await a.click('Close');

    // Extra isolated fixtures exercise density and instruction splitting.
    const fixtureMenu = [];
    for (const name of ['Veg Noodles', 'Biryani', 'French Fries', 'Rice']) {
      const dish = await ownerCall('/menu/items', {
        categoryId: category.id,
        name,
        variants: [
          {
            name: 'Full',
            channels: [
              { channelCode: 'COUNTER', price: '100', available: true },
            ],
          },
        ],
      });
      fixtureMenu.push(dish);
    }
    for (const [quantity, instruction] of [
      [2, ''],
      [1, 'Extra spicy'],
      [2, ' Extra   spicy '],
      [1, 'No onion'],
    ])
      await ownerCall('/orders/counter', {
        requestId: randomUUID(),
        lines: [
          { variantId: fixtureMenu[0].variants[0].id, quantity, instruction },
        ],
      });
    for (const dish of fixtureMenu.slice(1))
      await ownerCall('/orders/counter', {
        requestId: randomUUID(),
        lines: [{ variantId: dish.variants[0].id, quantity: 1 }],
      });
    await a.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await a.wait(
      "document.querySelectorAll('.kds-order-grid .kds-card').length>=9",
    );
    const orderColumns = await a.read(
      "getComputedStyle(document.querySelector('.kds-order-grid')).gridTemplateColumns.split(' ').length",
    );
    assert.equal(orderColumns, 3);
    assert.equal(
      await a.read("document.querySelectorAll('.kds-date').length"),
      0,
    );
    await a.click('Production View');
    await a.wait(
      "[...document.querySelectorAll('.kds-production h3')].some(e=>e.textContent==='Veg Noodles')",
    );
    assert.doesNotMatch(
      await a.read("document.querySelector('.kds').innerText"),
      /#\d|Source tokens/,
    );
    const split = await a.read(
      "(()=>{const card=[...document.querySelectorAll('.kds-production')].find(e=>e.querySelector('h3').textContent==='Veg Noodles');return {total:card.querySelector('.kds-production-total strong').textContent,parts:[...card.querySelectorAll('.kds-breakdown li')].map(e=>[e.querySelector('span').textContent,e.querySelector('strong').textContent])};})()",
    );
    assert.deepEqual(split, {
      total: '×6',
      parts: [
        ['Normal', '×2'],
        ['Extra spicy', '×3'],
        ['No onion', '×1'],
      ],
    });
    assert.equal(
      await a.read(
        "getComputedStyle(document.querySelector('.kds-production-grid')).gridTemplateColumns.split(' ').length",
      ),
      4,
    );
    const trace = (await a.http('/kitchen/orders')).body.production.queued.find(
      (g) => g.itemName === 'Veg Noodles',
    );
    assert.equal(trace.sources.length, 4);
    assert.ok(trace.sources.every((s) => s.orderId && s.tokenNumber));
    shot = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      '/tmp/dukanos-kitchen-compact-production.png',
      Buffer.from(shot.data, 'base64'),
    );
    await a.send('Emulation.setDeviceMetricsOverride', {
      width: 768,
      height: 1024,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(
      await a.read(
        "getComputedStyle(document.querySelector('.kds-production-grid')).gridTemplateColumns.split(' ').length",
      ),
      2,
    );
    assert.ok(await a.read('document.documentElement.scrollWidth<=innerWidth'));
    shot = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      '/tmp/dukanos-kitchen-compact-tablet.png',
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
        "getComputedStyle(document.querySelector('.kds-production-grid')).gridTemplateColumns.split(' ').length",
      ),
      1,
    );

    // Create old confirmed fixtures normally through insert guards, never disable
    // immutability or rewrite a real order. All data belongs to this test schema.
    const fixtureSql = new Client({
      connectionString: process.env.DATABASE_URL,
    });
    await fixtureSql.connect();
    const lateIds = [];
    try {
      for (let i = 0; i < 2; i++) {
        const id = randomUUID();
        lateIds.push(id);
        await fixtureSql.query('BEGIN');
        const token = (
          await fixtureSql.query(
            'UPDATE order_daily_tokens SET last_token=last_token+1 WHERE business_date=$1 RETURNING last_token',
            [before.queued[0].businessDate],
          )
        ).rows[0].last_token;
        const queuedAt = new Date(Date.now() - (20 - i) * 60000).toISOString();
        await fixtureSql.query(
          `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||jsonb_build_object('id',$2::text,'request_id',$3::text,'status','QUEUED','queued_at',$5::text,'token_number',$4::int))).* FROM orders o WHERE id=$1`,
          [ids[0], id, randomUUID(), token, queuedAt],
        );
        await fixtureSql.query(
          `INSERT INTO order_items SELECT (jsonb_populate_record(NULL::order_items,to_jsonb(i)||jsonb_build_object('id',gen_random_uuid(),'order_id',$2::text))).* FROM order_items i WHERE order_id=$1`,
          [ids[0], id],
        );
        await fixtureSql.query(
          "INSERT INTO order_status_history VALUES($1,$2,'DRAFT','QUEUED',(SELECT confirmed_by FROM orders WHERE id=$2),$3,'Old test fixture')",
          [randomUUID(), id, queuedAt],
        );
        await fixtureSql.query('COMMIT');
      }
    } finally {
      await fixtureSql.end();
    }
    await a.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await a.click('Order View');
    await a.wait("document.querySelectorAll('.kds-late').length===2");
    assert.equal(
      (await b.http('/kitchen/orders/' + lateIds[1] + '/start', 'POST')).body
        .code,
      'OLDER_ORDER_WAITING',
    );
    await a.click('Start Order');
    await a.wait(
      `!!document.querySelector('.kds-preparing [data-order-id="${lateIds[0]}"].kds-late')`,
    );
    assert.ok(
      await a.read(
        `document.querySelector('[data-order-id="${lateIds[0]}"] .kds-age').textContent.includes('<1 min')`,
      ),
    );
    await a.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    assert.ok(
      await a.read(
        "[...document.querySelectorAll('.kds-late-badge')].every(e=>getComputedStyle(e).animationName==='none')",
      ),
    );
    assert.equal(
      await a.read(
        "getComputedStyle(document.querySelector('.kds-late')).borderTopColor",
      ),
      'rgb(179, 46, 34)',
    );
    shot = await a.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    fs.writeFileSync(
      '/tmp/dukanos-kitchen-compact-orders.png',
      Buffer.from(shot.data, 'base64'),
    );
    console.log(
      'Browser PASS: compact 3-column orders / 4-column production, 2-column tablet / 1-column narrow production, no Production tokens, Normal 2 + Extra spicy 3 + No onion 1, old queued/preparing LATE without animation, FIFO preserved, pure Kitchen variant/whole-dish availability, POS propagation and existing-cart rejection.',
    );
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    console.log(
      'Browser PASS: 3 orders created through CASHIER POS, FIFO/NEXT, production 3+3 with source instructions, START/READY, two independent devices, stale duplicate conflict, failed connection recovery, multi-role workspace switching and tablet touch layout. External traffic blocked; isolated schema only.',
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
