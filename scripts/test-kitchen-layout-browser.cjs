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
    const items = [];
    for (const [name, variants] of [
      ['Manchurian', ['Half', 'Full']],
      [
        'Soya Chaap Gravy Butter Masala with a long kitchen dish name',
        ['Half', 'Full'],
      ],
    ])
      items.push(
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
        }),
      );
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
    const baseline = process.env.KITCHEN_LAYOUT_BASELINE === '1';
    const stage = baseline ? 'before' : 'after';
    const note =
      'Extra spicy, no onion\nKeep gravy thick. ' +
      'Do not add capsicum. '.repeat(12);
    const line = (variantId, quantity = 1, instruction = '') => ({
      variantId,
      quantity,
      instruction,
    });
    const half = items[0].variants[0].id,
      full = items[0].variants[1].id;
    const counter = (lines, serviceType = 'DINE_IN', reference = 'Table 4') =>
      ownerCall('/orders/counter', {
        requestId: randomUUID(),
        lines,
        serviceType,
        reference,
      });
    const short = await counter([line(half)]);
    const long = await counter(
      Array.from({ length: 10 }, (_, i) =>
        line(
          i % 2 ? full : half,
          i === 0 ? 4 : 1,
          i === 0 ? note : `Line ${i + 1}: no onion`,
        ),
      ),
      'DINE_IN',
      'Table 9 — family near front window',
    );
    const parcel = await counter(
      [line(full, 2, 'Extra spicy, no onion')],
      'TAKEAWAY',
      'Pickup Ravi',
    );
    await ownerCall(`/bills/${parcel.billId}/payments`, {
      requestId: randomUUID(),
      method: 'CASH',
      amount: parcel.grandTotal,
    });
    const platform = await ownerCall('/platform-orders', {
      requestId: randomUUID(),
      source: 'ZOMATO',
      externalReference: '121',
      preparationMode: 'REDUCED',
      lines: [line(full, 1, 'Pack separately')],
    });
    const a = await device('cook'),
      b = await device('multi');
    const selector = (id) => `[data-order-id="${id}"]`;
    for (const c of [a, b]) {
      await c.read("location.hash='/kitchen'");
      await c.wait(
        "document.querySelectorAll('.kds-order-grid .kds-card').length===4",
      );
    }
    const dimensions = [];
    for (const [width, height] of [
      [360, 800],
      [390, 844],
      [430, 932],
      [768, 1024],
      [1024, 768],
      [1280, 800],
      [1440, 900],
      [1600, 900],
      [390, 420],
    ]) {
      await a.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await a.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await a.read(
        'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
      );
      const measure = await a.read(
        `(()=>{const cards=[...document.querySelectorAll('.kds-order-grid .kds-card')];return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth, cards:cards.map(e=>({id:e.dataset.orderId,height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top})),targets:[...document.querySelectorAll('.kds-order-grid button,.kds-order-grid input')].filter(e=>e.getClientRects().length).map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})),note:document.querySelector('${selector(long.id)} .kds-instruction').textContent}})()`,
      );
      assert.equal(measure.overflow, false);
      assert.equal(measure.note, note.trim());
      assert.deepEqual(
        measure.cards.map((c) => c.id),
        [short.id, long.id, parcel.id, platform.id],
      );
      if (!baseline) {
        assert.ok(
          measure.cards[0].height < measure.cards[1].height / 2,
          JSON.stringify(measure),
        );
        assert.ok(measure.cards[2].height < measure.cards[1].height / 2);
        assert.ok(
          measure.targets.every((t) => t.width >= 44 && t.height >= 44),
          JSON.stringify(measure.targets),
        );
        assert.equal(
          await a.read(
            `document.querySelectorAll('${selector(short.id)} input[type=number]').length`,
          ),
          0,
        );
      }
      dimensions.push(measure);
      await a.wait(
        "!document.querySelector('.kds')?.textContent.includes('Offline / server unavailable')",
      );
      await a.send('Page.enable');
      const shot = await a.send('Page.captureScreenshot', {
        captureBeyondViewport: true,
      });
      fs.writeFileSync(
        `/tmp/dukanos-kitchen-compact-${stage}-${width}x${height}.png`,
        Buffer.from(shot.data, 'base64'),
      );
      await a.click('Production View');
      await a.wait("!!document.querySelector('.kds-production')");
      assert.ok(
        (
          await a.read(
            "document.querySelector('.kds-production-sections').textContent",
          )
        ).includes('LESS QUANTITY'),
      );
      if (!baseline) {
        assert.ok(
          await a.read(
            `[...document.querySelectorAll('.kds-production-sources li')].some(e=>e.textContent.includes('Platform #121') && e.textContent.includes('ZOMATO'))`,
          ),
        );
        assert.ok(
          await a.read(
            `[...document.querySelectorAll('.kds-production-sources li')].some(e=>e.textContent.includes('Token #${long.tokenNumber}') && e.querySelector('.kds-instruction')?.textContent===${JSON.stringify(note.trim())})`,
          ),
        );
        assert.ok(
          await a.read(
            `!![...document.querySelectorAll('.kds-production-sources li')].find(e=>e.textContent.includes('Token #${parcel.tokenNumber}') && e.textContent.includes('PARCEL') && e.textContent.includes('Extra spicy, no onion'))`,
          ),
        );
        assert.equal(
          await a.read('document.documentElement.scrollWidth>innerWidth'),
          false,
        );
        const shot = await a.send('Page.captureScreenshot', {
          captureBeyondViewport: true,
        });
        fs.writeFileSync(
          `/tmp/dukanos-kitchen-compact-production-${width}x${height}.png`,
          Buffer.from(shot.data, 'base64'),
        );
      }
      await a.click('Order View');
    }
    fs.writeFileSync(
      `/tmp/dukanos-kitchen-compact-${stage}.json`,
      JSON.stringify(dimensions, null, 2),
    );
    if (!baseline) {
      // Touch actual controls, not programmatic form submission.
      async function tap(c, sel) {
        await c.read(
          `document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`,
        );
        const p = await c.read(
          `(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        await c.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [p],
        });
        await c.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
      }
      const first = selector(long.id) + ' .kds-line';
      await a.fill(first + ' input[type=number]', '1');
      assert.equal(
        (await a.http('/kitchen/orders')).body.pending.find(
          (o) => o.orderId === long.id,
        ).items[0].servedQuantity,
        0,
        'quantity edit must not serve',
      );
      b.hold = true;
      await tap(a, first + ' button[type=submit]');
      await a.wait(
        `document.querySelector('${first}').textContent.includes('3 pending')`,
      );
      // Second staff device attempts the stale quantity before its next read.
      await b.fill(first + ' input[type=number]', '1');
      await tap(b, first + ' button[type=submit]');
      await b.wait(
        "document.body.textContent.includes('Serving quantities changed')",
      );
      b.hold = false;
      for (const id of b.held.splice(0))
        await b.send('Fetch.continueRequest', { requestId: id });
      await b.wait(
        `document.querySelector('${first}').textContent.includes('3 pending')`,
      );
      assert.equal(
        (await a.http('/kitchen/orders')).body.pending.find(
          (o) => o.orderId === long.id,
        ).items[0].servedQuantity,
        1,
      );
      // Correction remains possible, with a reason, while other lines remain pending.
      await tap(a, first + ' button.secondary');
      await a.fill(first + ' input[type=text]', 'Wrong table touched');
      await tap(a, first + ' button[type=submit]');
      await a.wait(
        `document.querySelector('${first}').textContent.includes('4 pending')`,
      );
      await tap(a, first + ' button[type=submit]');
      await a.wait(
        `document.querySelector('${first}').classList.contains('kds-served')`,
      );
      assert.equal(
        await a.read(
          `document.querySelector('${first}').querySelectorAll('button[type=submit]').length`,
        ),
        0,
      );
      assert.ok(
        await a.read(`!!document.querySelector('${first} button.secondary')`),
      );
      await tap(a, selector(short.id) + ' button[type=submit]');
      await a.wait(`!document.querySelector('${selector(short.id)}')`);
      await tap(a, selector(parcel.id) + ' .kds-action');
      await a.wait(`!document.querySelector('${selector(parcel.id)}')`);
      await tap(a, selector(platform.id) + ' .kds-action');
      await a.wait(`!document.querySelector('${selector(platform.id)}')`);
      // Existing clock-based LATE/NEXT indication, using an isolated read response offset.
      await a.read(
        `(()=>{const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(args[0]==='/api/kitchen/orders'){const d=await r.json();d.serverTime=new Date(Date.parse(d.serverTime)+3600000).toISOString();return new Response(JSON.stringify(d),{status:200,headers:{'Content-Type':'application/json'}});}return r;};})()`,
      );
      await a.wait("!!document.querySelector('.kds-late .kds-late-badge')");
      assert.ok(
        await a.read(
          "document.querySelector('.kds-next').textContent.includes('NEXT')",
        ),
      );
      fs.writeFileSync(
        '/tmp/dukanos-kitchen-compact-served-late.png',
        Buffer.from(
          (
            await a.send('Page.captureScreenshot', {
              captureBeyondViewport: true,
            })
          ).data,
          'base64',
        ),
      );
      await a.click('Production View');
      await a.wait("!!document.querySelector('.kds-production')");
      const production = (await a.http('/kitchen/orders')).body.production
        .pending;
      assert.equal(
        production.reduce((sum, g) => sum + g.totalQuantity, 0),
        9,
      );
      assert.ok(
        !production.some((g) =>
          g.sources.some((s) => s.lineId === long.items[0].id),
        ),
      );
    }
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    console.log(
      JSON.stringify({
        stage,
        cardHeights: dimensions.map((d) => ({
          width: d.width,
          heights: d.cards.map((c) => c.height),
        })),
      }),
    );
    console.log(
      'Kitchen compact ' +
        stage +
        ' PASS: isolated mixed-height fixtures, responsive layouts' +
        (baseline
          ? ''
          : ', touch serving/correction, stale second device, handover, production source instructions and late guidance'),
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
