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
  const schema = 'platform_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const profile = fs.mkdtempSync('/tmp/dukanos-platform-');
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
            price: channelCode === 'COUNTER' ? '100' : null,
            available: true,
            ...(channelCode === 'COUNTER'
              ? {}
              : {
                  normalAmount: '300',
                  reducedAmount: '250',
                  servingUnit: 'g',
                }),
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
      c.handlers.push((m) => {
        if (m.method === 'Page.javascriptDialogOpening')
          void c.send('Page.handleJavaScriptDialog', { accept: true });
      });
      await c.send('Page.enable');
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
    const editor = await device('owner');
    const cashier = await device('cashier'),
      cook = await device('cook'),
      dispatcher = await device('dispatcher');
    const widths = [
      [390, 844],
      [768, 1024],
      [1024, 768],
      [1440, 900],
    ];
    async function layout(c, width, height) {
      await c.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(
        await c.read('document.documentElement.scrollWidth<=innerWidth+1'),
        'No horizontal overflow',
      );
    }
    async function tap(c, text) {
      const box = await c.read(
        `(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&b.getBoundingClientRect().height>0);if(!e)throw Error('Missing '+${JSON.stringify(text)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`,
      );
      assert.ok(box.w >= 44 && box.h >= 44, 'Touch target ' + text);
      await c.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: box.x, y: box.y }],
      });
      await c.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    }
    async function fillLabel(c, label, value) {
      await c.fill(`[aria-label="${label}"]`, value);
    }
    // Exercise the actual single-save serving editor at every device class.
    for (const [width, height] of widths) {
      await layout(editor, width, height);
      await editor.read("location.hash='/menu'");
      await editor.wait("!!document.querySelector('.menu-sidebar')");
      await editor.read(
        "[...document.querySelectorAll('.dish-link')].find(b=>b.textContent.includes('Soya Chaap Gravy')).click()",
      );
      await editor.wait(
        "document.querySelector('[name=itemName]')?.value==='Soya Chaap Gravy'",
      );
      await editor.read(
        "document.querySelectorAll('.serving-editor').forEach(d=>d.open=true)",
      );
      await fillLabel(editor, 'Half Zomato Normal size', String(width));
      await fillLabel(editor, 'Half Zomato Reduced size', '200');
      await tap(editor, 'Save Changes');
      await editor.wait(
        "document.querySelector('.dish-save')?.textContent.includes('All changes saved')",
      );
      const saved = await editor.http('/platform-orders/menu?source=ZOMATO');
      const item = saved.body.categories
        .flatMap((c) => c.items)
        .find((i) => i.name === 'Soya Chaap Gravy');
      assert.equal(
        item.variants.find((v) => v.name === 'Half').normal.amount,
        width.toFixed(2),
      );
      assert.ok(
        await editor.read('document.documentElement.scrollWidth<=innerWidth+1'),
      );
      await editor.read(
        "document.querySelectorAll('.serving-editor').forEach(d=>d.open=true); document.querySelector('.serving-editor').scrollIntoView({block:'center'})",
      );
      fs.writeFileSync(
        `/tmp/dukanos-platform-menu-${width}.png`,
        Buffer.from(
          (await editor.send('Page.captureScreenshot')).data,
          'base64',
        ),
      );
      await editor.read("location.hash='/pos'");
      await editor.wait("!!document.querySelector('.pos-sources')");
    }
    let count = 0;
    for (const [width, height] of widths) {
      for (const c of [cashier, cook, dispatcher])
        await layout(c, width, height);
      await cashier.read("location.hash='/pos'");
      await cashier.wait("!!document.querySelector('.pos-sources')");
      await tap(cashier, 'Zomato');
      await cashier.wait(
        "document.querySelectorAll('.pos-dish-card').length===2",
      );
      await cashier.read(
        "[...document.querySelectorAll('.pos-dish-card')].find(b=>b.textContent.includes('Manchurian')).click()",
      );
      await cashier.wait(
        "document.querySelector('.platform-dish-dialog')?.open",
      );
      assert.equal(
        await cashier.read(
          'document.querySelector(\'[aria-label="Half serving"]\').value',
        ),
        'NORMAL',
      );
      await fillLabel(cashier, 'Half quantity', '2');
      await fillLabel(cashier, 'Half instruction', 'Extra spicy');
      await cashier.read(
        `(()=>{const s=document.querySelector('[aria-label="Half serving"]');s.value='REDUCED';s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      );
      await tap(cashier, 'Add to Order');
      if (width < 900)
        await cashier.read(
          "document.querySelector('.mobile-order-trigger').click()",
        );
      await cashier.wait("!!document.querySelector('.platform-cart input')");
      await cashier.fill('.platform-cart input', 'Z-' + width);
      await cashier.read(
        "(()=>{const s=document.querySelector('.platform-cart select');s.value='APPLIED';s.dispatchEvent(new Event('change',{bubbles:true}))})()",
      );
      assert.equal(
        await cashier.read(
          "[...document.querySelectorAll('.pos-sources button')].find(b=>b.textContent==='Counter').disabled",
        ),
        true,
      );
      await tap(cashier, 'Review platform order');
      assert.ok(
        (
          await cashier.read(
            "document.querySelector('.platform-cart').innerText",
          )
        ).includes('250 g each'),
      );
      assert.ok(
        !(
          await cashier.read(
            "document.querySelector('.platform-cart').innerText",
          )
        ).includes('Pay Later'),
      );
      fs.writeFileSync(
        `/tmp/dukanos-platform-pos-${width}.png`,
        Buffer.from(
          (await cashier.send('Page.captureScreenshot')).data,
          'base64',
        ),
      );
      await tap(cashier, 'Submit to Kitchen');
      await cashier.wait(
        "document.querySelector('.platform-cart')?.innerText.includes('TOKEN #')",
      );
      const lookup = await cashier.http('/platform-orders?search=Z-' + width);
      assert.equal(lookup.status, 200);
      const order = lookup.body.orders[0];
      assert.equal(order.status, 'QUEUED');
      assert.equal(order.items[0].quantity, 2);
      await cook.read("location.hash='/kitchen'");
      await cook.wait(
        `!!document.querySelector('[data-order-id="${order.id}"]')`,
      );
      const card = await cook.read(
        `document.querySelector('[data-order-id="${order.id}"]').innerText`,
      );
      assert.ok(
        card.includes('ZOMATO') &&
          card.includes('250 g each') &&
          card.includes('Extra spicy'),
      );
      await tap(cook, 'Production View');
      await cook.wait("!!document.querySelector('.kds-production')");
      const production = await cook.read(
        "document.querySelector('.kds-production').innerText",
      );
      assert.ok(
        production.includes('HALF MANCHURIAN') &&
          production.includes('REDUCED'),
      );
      assert.ok(!production.includes('#'));
      fs.writeFileSync(
        `/tmp/dukanos-platform-production-${width}.png`,
        Buffer.from((await cook.send('Page.captureScreenshot')).data, 'base64'),
      );
      await tap(cook, 'Order View');
      await tap(cook, 'Start Order');
      await cook.wait(
        `document.querySelector('[data-order-id="${order.id}"]')?.innerText.includes('Mark Ready')`,
      );
      await tap(cook, 'Mark Ready');
      await dispatcher.read("location.hash='/dispatch'");
      await dispatcher.wait(
        `!!document.querySelector('[data-order-id="${order.id}"]')`,
      );
      const dispatch = await dispatcher.read(
        `document.querySelector('[data-order-id="${order.id}"]').innerText`,
      );
      assert.ok(
        dispatch.includes('Z-' + width) && dispatch.includes('250 g each'),
      );
      assert.ok(!dispatch.includes('DUE'));
      fs.writeFileSync(
        `/tmp/dukanos-platform-dispatch-${width}.png`,
        Buffer.from(
          (await dispatcher.send('Page.captureScreenshot')).data,
          'base64',
        ),
      );
      await tap(dispatcher, 'Handed Over');
      await dispatcher.wait(
        `!document.querySelector('[data-order-id="${order.id}"]')`,
      );
      await tap(cashier, 'New Order');
      await tap(cashier, 'Track platform orders');
      await cashier.wait("!!document.querySelector('.platform-track-card')");
      await cashier.read(
        `[...document.querySelectorAll('.platform-track-card')].find(b=>b.innerText.includes('Z-${width}')).click()`,
      );
      await cashier.wait(
        "document.querySelector('.platform-tracking article')?.innerText.includes('COMPLETED')",
      );
      assert.ok(
        (
          await cashier.read(
            "document.querySelector('.platform-tracking article').innerText",
          )
        ).includes('Dispatch handed order over'),
      );
      const platformMenu = (
        await cashier.http('/platform-orders/menu?source=SWIGGY')
      ).body;
      const variant = platformMenu.categories[0].items[0].variants[0];
      const cancelled = await ownerCall('/platform-orders', {
        requestId: randomUUID(),
        source: 'SWIGGY',
        externalReference: 'CANCEL-' + width,
        discountClassification: 'NONE',
        lines: [
          { variantId: variant.id, quantity: 1, serving: variant.normal },
        ],
      });
      await tap(cashier, 'Refresh orders');
      await cashier.wait(
        `document.querySelector('.platform-tracking')?.innerText.includes('CANCEL-${width}')`,
      );
      await cashier.read(
        `[...document.querySelectorAll('.platform-track-card')].find(b=>b.innerText.includes('CANCEL-${width}')).click()`,
      );
      await cashier.wait(
        "!!document.querySelector('.platform-tracking textarea')",
      );
      await cashier.fill(
        '.platform-tracking textarea',
        'Customer cancelled on the platform',
      );
      await tap(cashier, 'Record platform cancellation');
      await cashier.wait(
        "document.querySelector('.platform-tracking article')?.innerText.includes('CANCELLED')",
      );
      assert.equal(
        (await cashier.http('/platform-orders/' + cancelled.id)).body.status,
        'CANCELLED',
      );
      await tap(cashier, 'Back to entry');
      await tap(cashier, 'Counter');
      count++;
    }
    for (const [w, h] of [
      [360, 800],
      [430, 932],
      [1280, 800],
      [1600, 900],
      [390, 420],
    ]) {
      await layout(cashier, w, h);
      await tap(cashier, 'Swiggy');
      await cashier.wait(
        "document.querySelectorAll('.pos-dish-card').length===2",
      );
      await cashier.read("document.querySelector('.pos-dish-card').click()");
      await cashier.wait(
        "document.querySelector('.platform-dish-dialog')?.open",
      );
      assert.ok(
        await cashier.read(
          'document.documentElement.scrollWidth<=innerWidth+1',
        ),
      );
      await tap(cashier, 'Close');
      await tap(cashier, 'Counter');
    }
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    console.log(
      `Platform browser PASS: ${count} complete responsive Menu configuration/cashier/Kitchen/Production/Dispatch/tracking/cancellation touch workflows; 5 additional boundaries; external traffic blocked.`,
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
