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
      [
        'Soya Chaap Gravy Butter Masala with a long kitchen dish name',
        ['Half', 'Full'],
      ],
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
        '--headless=new',
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
          !local ||
            (kitchen && c.fail) ||
            (c.failCheckout &&
              r.request.url.endsWith('/api/orders/counter') &&
              r.request.method === 'POST')
            ? 'Fetch.failRequest'
            : 'Fetch.continueRequest',
          !local ||
            (kitchen && c.fail) ||
            (c.failCheckout &&
              r.request.url.endsWith('/api/orders/counter') &&
              r.request.method === 'POST')
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
          `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.querySelector('strong')?.textContent===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click();})()`,
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
        "!!document.querySelector('.payment-review .payment-choices')",
      );
      await cashier.click('Pay Later');
      await cashier.wait(
        `document.querySelector('.order-confirmed')?.textContent.includes('Token #${token}')`,
      );
      assert.equal(
        await cashier.read("document.querySelectorAll('.cart-line').length"),
        0,
      );
      assert.equal(
        await cashier.read(
          "[...document.querySelectorAll('.pos-card')].some(b=>b.disabled)",
        ),
        false,
      );
    }
    await add('Manchurian', 'Half', 3, 'Extra spicy');
    await add('Soya Chaap Gravy', 'Full', 1, 'No onion');
    await cashier.fill(
      '[aria-label="Table / Reference"]',
      'Table 4 — family near the front window',
    );
    await confirm(1);
    await add('Manchurian', 'Full', 1);
    await confirm(2);
    assert.equal(cashier.payloads.length, 2);
    assert.ok(cashier.payloads.every((p) => !p.billId));
    await a.wait("document.querySelectorAll('.kds-card').length===2");
    assert.ok(
      !(await a.read("document.querySelector('nav').textContent")).includes(
        'Dispatch',
      ),
    );
    assert.ok(
      !(await a.read("document.querySelector('.kds').textContent")).includes(
        'Start Order',
      ),
    );
    assert.ok(
      (await a.read("document.querySelector('.kds').textContent")).includes(
        'DINE IN',
      ),
    );
    await a.fill('.kds-serve-controls input', '1');
    await a.click('Serve');
    await a.wait(
      "document.querySelector('.kds-line')?.textContent.includes('2 pending')",
    );
    await b.wait(
      "document.querySelector('.kds-line')?.textContent.includes('2 pending')",
    );
    await a.click('Production View');
    await a.wait("!!document.querySelector('.kds-production')");
    assert.ok(
      (
        await a.read(
          "document.querySelector('.kds-production-sections').textContent",
        )
      ).includes('Token #1'),
    );
    assert.ok(
      (
        await a.read(
          "document.querySelector('.kds-production-sections').textContent",
        )
      ).includes('DINE IN'),
    );
    await a.click('Order View');
    await a.click('Serve');
    await a.wait("!!document.querySelector('.kds-served')");
    assert.ok(
      (
        await a.read("document.querySelector('.kds-served').textContent")
      ).includes('SERVED'),
    );
    await a.read("location.hash='/dispatch'");
    await a.wait("location.hash==='#/kitchen'");
    // Cart grows with practical sizes, long instructions and portion combinations.
    for (let n = 1; n <= 20; n++) {
      await add(
        n % 2 ? 'Manchurian' : 'Soya Chaap Gravy',
        n % 2 ? 'Half' : 'Full',
        1,
        `Line ${n}: Extra spicy, no onion, keep gravy thick. `.repeat(4),
      );
      if ([1, 3, 10, 20].includes(n))
        assert.equal(
          await cashier.read("document.querySelectorAll('.cart-line').length"),
          n,
        );
    }
    const sizes = [
      [360, 800],
      [390, 844],
      [430, 932],
      [768, 1024],
      [1024, 768],
      [1280, 800],
      [1440, 900],
      [1600, 900],
      [390, 420],
    ];
    for (const [width, height] of sizes) {
      await cashier.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      if (width < 900) await cashier.click('View Order');
      await cashier.wait("document.querySelector('.cart-dialog').open");
      assert.ok(
        await cashier.read(
          'document.documentElement.scrollWidth<=innerWidth+1',
        ),
        `${width}: horizontal overflow`,
      );
      assert.ok(
        await cashier.read(
          "(()=>{const e=document.querySelector('.cart-items');return e.scrollHeight<=e.clientHeight+1 && !['auto','scroll'].includes(getComputedStyle(e).overflowY);})()",
        ),
        `${width}: cart list scroll`,
      );
      assert.ok(
        await cashier.read(
          "document.querySelectorAll('.cart-line').length===20",
        ),
      );
      if (width >= 900)
        assert.ok(
          await cashier.read(
            "document.querySelector('.order-cart').getBoundingClientRect().height>innerHeight",
          ),
          'desktop cart grows',
        );
      const shot = await cashier.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      });
      fs.writeFileSync(
        `/tmp/dukanos-workflow-cart-${width}x${height}.png`,
        Buffer.from(shot.data, 'base64'),
      );
      if (width < 900) await cashier.click('Back to dishes');
      await a.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.ok(
        await a.read('document.documentElement.scrollWidth<=innerWidth+1'),
        'Kitchen horizontal overflow',
      );
      for (const mode of ['Order View', 'Production View']) {
        await a.click(mode);
        const image = await a.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
        });
        fs.writeFileSync(
          `/tmp/dukanos-workflow-kitchen-${mode.split(' ')[0]}-${width}x${height}.png`,
          Buffer.from(image.data, 'base64'),
        );
      }
      await a.click('Order View');
    }
    await cashier.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cashier.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cashier.click('View Order');
    await cashier.read(
      "document.querySelector('.cart-dialog').scrollTop=document.querySelector('.cart-dialog').scrollHeight",
    );
    await confirm(3);
    assert.equal(
      await cashier.read("document.querySelector('.cart-dialog').open"),
      false,
    );
    await cashier.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await add('Manchurian', 'Half', 1);
    cashier.failCheckout = true;
    await cashier.click('Confirm Order');
    await cashier.wait(
      "!!document.querySelector('.payment-review .payment-choices')",
    );
    await cashier.click('Pay Later');
    await cashier.wait(
      "document.body.textContent.includes('Retry confirmation')",
    );
    assert.equal(
      await cashier.read("document.querySelectorAll('.cart-line').length"),
      1,
    );
    const failed = cashier.payloads.at(-1);
    cashier.failCheckout = false;
    await cashier.click('Retry confirmation');
    await cashier.wait(
      "document.querySelector('.order-confirmed')?.textContent.includes('Token #4')",
    );
    assert.deepEqual(cashier.payloads.at(-1), failed);
    await cashier.send('Emulation.setDeviceMetricsOverride', {
      width: 720,
      height: 450,
      deviceScaleFactor: 2,
      mobile: false,
    });
    assert.ok(
      await cashier.read('document.documentElement.scrollWidth<=innerWidth+1'),
      '200% equivalent viewport',
    );
    assert.ok(
      (await cashier.read('document.body.textContent')).includes(
        'View Bill / Payment',
      ),
    );
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    console.log(
      'PASS: continuous independent POS orders; 1/3/10/20 lines; partial serving across devices; served styling; token/service production breakdown; Dispatch redirect; nine viewport sizes, no nested cart scrolling; external requests blocked.',
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
