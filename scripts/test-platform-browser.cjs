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
    const widths = process.env.PLATFORM_BOUNDARIES_ONLY
      ? []
      : [
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
    // Shared selector is compared against Counter at every primary device size.
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
      assert.equal(
        await editor.read(
          "document.querySelectorAll('.serving-editor').length",
        ),
        0,
      );
      await fillLabel(editor, 'Half Swiggy price', '');
      await tap(editor, 'Save Changes');
      await editor.wait(
        "document.querySelector('.dish-save')?.textContent.includes('All changes saved')",
      );
      await editor.read("location.hash='/pos'");
      await editor.wait("!!document.querySelector('.pos-card')");
      await editor.read(
        "[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes('Manchurian')).click()",
      );
      await editor.wait("document.querySelector('.pos-portions')?.open");
      assert.ok(
        (
          await editor.read("document.querySelector('.pos-portions').innerText")
        ).includes('₹100'),
      );
      fs.writeFileSync(
        `/tmp/dukanos-platform-counter-modal-${width}.png`,
        Buffer.from(
          (await editor.send('Page.captureScreenshot')).data,
          'base64',
        ),
      );
      await editor.read(
        'document.querySelector(\'[aria-label="Close dish selection"]\').click()',
      );
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
      await cashier.wait("document.querySelector('.pos-portions')?.open");
      assert.doesNotMatch(
        await cashier.read("document.querySelector('.pos-portions').innerText"),
        /₹|Serving size|QUANTITY|each/,
      );
      for (const variant of ['Half', 'Half', 'Full'])
        await cashier.read(
          `document.querySelector('[aria-label="Increase ${variant} quantity"]').click()`,
        );
      await cashier.read(
        'document.querySelector(\'[aria-label="Add instruction for Manchurian / Half"]\').click()',
      );
      await fillLabel(
        cashier,
        'Instruction for Manchurian / Half',
        'Extra spicy',
      );
      await tap(cashier, 'Done');
      fs.writeFileSync(
        `/tmp/dukanos-platform-modal-${width}.png`,
        Buffer.from(
          (await cashier.send('Page.captureScreenshot')).data,
          'base64',
        ),
      );
      await tap(cashier, 'Add 3 items');
      if (width < 900)
        await cashier.read(
          "document.querySelector('.mobile-order-trigger').click()",
        );
      assert.equal(
        await cashier.read(
          "[...document.querySelectorAll('.pos-sources button')].find(b=>b.textContent==='Counter').disabled",
        ),
        true,
      );
      await tap(cashier, 'Review platform order');
      await cashier.wait(
        '!!document.querySelector(\'[aria-label="External platform order ID"]\')',
      );
      await fillLabel(cashier, 'External platform order ID', 'Z-' + width);
      assert.equal(
        await cashier.read(
          "document.querySelector('.preparation-choice [aria-pressed=true]').textContent",
        ),
        'NORMAL QUANTITY',
      );
      await tap(cashier, 'LESS QUANTITY');
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
      if (width === 390)
        await cashier.read(
          `(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/platform-orders')&&args[1]?.method==='POST'){window.fetch=original;throw new TypeError('Simulated lost response after commit');}return response;};})()`,
        );
      await tap(cashier, 'Submit to Kitchen');
      if (width === 390) {
        await cashier.wait(
          "[...document.querySelectorAll('.platform-cart button')].some(b=>b.textContent==='Retry submission' && !b.disabled)",
        );
        const committed = await cashier.http(
          '/platform-orders?search=Z-' + width,
        );
        assert.equal(committed.body.orders.length, 1);
        await cashier.read('location.reload()');
        await cashier.wait("!!document.querySelector('.pos-sources')");
        await tap(cashier, 'Zomato');
        await cashier.read(
          "document.querySelector('.mobile-order-trigger').click()",
        );
        await cashier.wait(
          "[...document.querySelectorAll('.platform-cart button')].some(b=>b.textContent==='Retry submission' && !b.disabled)",
        );
        await cashier.read(
          "(()=>{const b=[...document.querySelectorAll('.platform-cart button')].find(b=>b.textContent==='Retry submission');b.click();b.click();})()",
        );
      }
      await cashier.wait(
        "document.querySelector('.platform-cart')?.innerText.includes('TOKEN #')",
      );
      const lookup = await cashier.http('/platform-orders?search=Z-' + width);
      assert.equal(lookup.status, 200);
      const order = lookup.body.orders[0];
      assert.equal(order.status, 'QUEUED');
      assert.equal(lookup.body.orders.length, 1);
      assert.equal(order.items[0].quantity, 2);
      assert.equal(order.items[1].quantity, 1);
      assert.equal(order.items[1].instruction, '');
      assert.equal(order.preparationMode, 'REDUCED');
      assert.ok(
        order.items.every(
          (i) => i.serving.amount === null && i.serving.unit === null,
        ),
      );
      await cook.read("location.hash='/kitchen'");
      await cook.wait(
        `!!document.querySelector('[data-order-id="${order.id}"]')`,
      );
      const card = await cook.read(
        `document.querySelector('[data-order-id="${order.id}"]').innerText`,
      );
      assert.ok(
        card.includes('ZOMATO') &&
          card.includes('LESS QUANTITY') &&
          card.includes('Extra spicy'),
      );
      await tap(cook, 'Production View');
      await cook.wait("!!document.querySelector('.kds-production')");
      const production = await cook.read(
        "document.querySelector('.kds-production').innerText",
      );
      assert.ok(
        production.includes('HALF MANCHURIAN') &&
          production.includes('LESS QUANTITY'),
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
        dispatch.includes('Z-' + width) && dispatch.includes('LESS QUANTITY'),
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
        preparationMode: 'NORMAL',
        lines: [{ variantId: variant.id, quantity: 1 }],
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
      await tap(cashier, 'Swiggy');
      await cashier.wait("!!document.querySelector('.pos-dish-card')");
      await cashier.read("document.querySelector('.pos-dish-card').click()");
      await cashier.wait("document.querySelector('.pos-portions')?.open");
      await cashier.read(
        'document.querySelector(\'[aria-label="Increase Half quantity"]\').click()',
      );
      await tap(cashier, 'Add 1 item');
      if (width < 900)
        await cashier.read(
          "document.querySelector('.mobile-order-trigger').click()",
        );
      await tap(cashier, 'Review platform order');
      await fillLabel(cashier, 'External platform order ID', 'S-' + width);
      const mode = width < 1000 ? 'NORMAL' : 'REDUCED';
      assert.equal(
        await cashier.read(
          "document.querySelector('.preparation-choice [aria-pressed=true]').textContent",
        ),
        'NORMAL QUANTITY',
      );
      if (mode === 'REDUCED') await tap(cashier, 'LESS QUANTITY');
      await tap(cashier, 'Submit to Kitchen');
      await cashier.wait(
        "document.querySelector('.platform-cart')?.innerText.includes('TOKEN #')",
      );
      const swiggy = (await cashier.http('/platform-orders?search=S-' + width))
        .body.orders[0];
      assert.equal(swiggy.preparationMode, mode);
      await ownerCall(`/platform-orders/${swiggy.id}/cancel`, {
        reason: 'Browser fixture complete',
      });
      await tap(cashier, 'New Order');
      await tap(cashier, 'Counter');
      count++;
    }
    await cashier.read("location.hash='/pos'");
    await cashier.wait("!!document.querySelector('.pos-sources')");
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
      await cashier.wait("document.querySelector('.pos-portions')?.open");
      await cashier.read(
        'document.querySelector(\'[aria-label="Increase Half quantity"]\').click()',
      );
      await cashier.read(
        'document.querySelector(\'.portion-row [aria-label^="Add instruction"]\').click()',
      );
      await cashier.fill('.pos-portions textarea', 'No onion and extra spicy');
      await tap(cashier, 'Done');
      const footer = await cashier.read(
        "(()=>{const e=document.querySelector('.portion-add'),r=e.getBoundingClientRect();return {enabled:!e.disabled,visible:r.top>=0&&r.bottom<=innerHeight,height:r.height,top:r.top,bottom:r.bottom};})()",
      );
      if (!(footer.enabled && footer.visible && footer.height >= 44))
        fs.writeFileSync(
          '/tmp/dukanos-platform-footer-failure.png',
          Buffer.from(
            (await cashier.send('Page.captureScreenshot')).data,
            'base64',
          ),
        );
      assert.ok(
        footer.enabled && footer.visible && footer.height >= 44,
        JSON.stringify({ w, h, ...footer }),
      );
      if (h === 420)
        fs.writeFileSync(
          '/tmp/dukanos-platform-short-modal.png',
          Buffer.from(
            (await cashier.send('Page.captureScreenshot')).data,
            'base64',
          ),
        );
      assert.ok(
        await cashier.read(
          'document.documentElement.scrollWidth<=innerWidth+1',
        ),
      );
      await cashier.read(
        'document.querySelector(\'[aria-label="Close dish selection"]\').click()',
      );
      await tap(cashier, 'Counter');
    }
    assert.deepEqual(
      cashier.payloads,
      [],
      'Platform workflow never calls Counter confirmation',
    );
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    console.log(
      `Platform browser PASS: ${count} complete responsive Menu without measurements/shared selector/cashier/Kitchen/Production/Dispatch/tracking/cancellation touch workflows, Swiggy Normal/Less entry, committed response loss/reload/double retry; 5 additional boundaries; external traffic blocked.`,
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
  console.error(e.stack);
  process.exitCode = 1;
});
