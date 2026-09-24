// Real Chromium + isolated PostgreSQL fixture. No changes to restaurant data.
require('reflect-metadata');
process.env.ORDER_TAX_RATE = '0';
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
  const schema = 'bills_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const profile = fs.mkdtempSync('/tmp/dukanos-bills-');
  process.env.DUKANOS_DATA_DIR = profile + '/media';
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
      ['Noodles', ['Full']],
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
    const c = await device('multi');
    const sizes = [
      [360, 800],
      [390, 844],
      [430, 932],
      [768, 1024],
      [1024, 768],
      [1280, 800],
      [1440, 900],
      [1600, 900],
    ];
    await c.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    await c.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    async function resize(width, height) {
      await c.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await c.read(
        'new Promise(resolve=>{setTimeout(resolve,150);requestAnimationFrame(()=>requestAnimationFrame(resolve))})',
      );
      await c.wait(
        "Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--usable-height')) - (visualViewport?.height ?? innerHeight)) < 1",
      );
    }
    async function tap(selector) {
      await c.read(
        `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',inline:'nearest'})`,
      );
      await c.read(
        'new Promise(resolve=>{setTimeout(resolve,150);requestAnimationFrame(()=>requestAnimationFrame(resolve))})',
      );
      const point = await c.read(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing touch target: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const top=document.elementFromPoint(x,y);if(!top||!(e===top||e.contains(top)))throw Error('Obscured touch target: '+${JSON.stringify(selector)}+' text='+e.textContent+' top='+top?.outerHTML.slice(0,180)+' bounds='+JSON.stringify({x,y,w:innerWidth,h:innerHeight}));if(r.width<43||r.height<43)throw Error('Small touch target: '+${JSON.stringify(selector)});return {x,y};})()`,
      );
      await c.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [point],
      });
      await c.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    }
    async function button(text) {
      await c.read(
        `(()=>{document.querySelectorAll('[data-touch-target]').forEach(e=>e.removeAttribute('data-touch-target'));const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getClientRects().length&&!e.closest('details:not([open])'));if(!e)throw Error('Missing button '+${JSON.stringify(text)});e.dataset.touchTarget='1';})()`,
      );
      await tap('[data-touch-target]');
    }
    async function go(route, selector) {
      const narrow = await c.read('innerWidth<900');
      if (narrow) {
        // Native OS select choice: dispatch the same change event after selecting an available option.
        await c.read(
          `(()=>{const e=document.querySelector('select[aria-label="Workspace"]');e.value=${JSON.stringify(route)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
      } else await tap(`nav[aria-label="Workspaces"] a[href="#${route}"]`);
      await c.wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    }
    const report = [];
    async function inspect(label, width, height, screenshot = false) {
      const result = await c.read(
        `(()=>{const modal=document.querySelector('dialog:modal');const root=modal||document;const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';return {pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,smallTargets:[...root.querySelectorAll('button,summary,input,select,nav[aria-label="Workspaces"] a')].filter(visible).filter(e=>!e.disabled).filter(e=>{const r=(e.type==='checkbox'?e.closest('label'):e).getBoundingClientRect();return r.height<43||r.width<43}).map(e=>e.getAttribute('aria-label')||e.textContent.trim().slice(0,40)||e.name),overflow:modal?modal.scrollWidth>modal.clientWidth+1:false,modalBounds:modal?(()=>{const r=modal.getBoundingClientRect();return r.top>=-1&&r.bottom<=innerHeight+1&&r.left>=-1&&r.right<=innerWidth+1})():true}})()`,
      );
      assert.ok(
        result.pageWidth <= result.viewport + 1,
        `${label} ${width}: page overflow ${result.pageWidth}`,
      );
      assert.deepEqual(
        result.smallTargets,
        [],
        `${label} ${width}: small targets`,
      );
      assert.equal(
        result.overflow,
        false,
        `${label} ${width}: dialog overflow`,
      );
      assert.ok(
        result.modalBounds,
        `${label} ${width}: dialog outside viewport`,
      );
      console.log(`Checked ${label} ${width}x${height}`);
      report.push({ label, width, height, ...result });
      if (screenshot) {
        if (label === 'payment-keyboard')
          await c.read(
            "document.querySelector('.bill-payment').scrollIntoView({block:'start'})",
          );
        else if (label === 'menu-prices')
          await c.read(
            "document.querySelector('.dish-prices').scrollIntoView({block:'start'})",
          );
        else if (label === 'staff-reset')
          await c.read(
            "document.querySelector('details[data-reset=current]').scrollIntoView({block:'start'})",
          );
        else await c.read('window.scrollTo(0,0)');
        const shot = await c.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        });
        fs.writeFileSync(
          `/tmp/dukanos-bills-${label}-${width}.png`,
          Buffer.from(shot.data, 'base64'),
        );
      }
    }

    const select = async (selector, value) =>
      c.read(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    async function prepare(order) {
      for (const action of ['start', 'ready']) {
        const r = await fetch(
          origin + `/api/kitchen/orders/${order.id}/${action}`,
          {
            method: 'POST',
            headers: { Cookie: cookie, 'X-DukanOS-Request': '1' },
          },
        );
        assert.equal(r.status, 200, await r.text());
      }
    }
    async function addRound(
      width,
      service,
      reference,
      two = false,
      dish = 'Manchurian',
    ) {
      for (const name of two ? ['Manchurian', 'Noodles'] : [dish]) {
        await c.read(
          `(()=>{document.querySelectorAll('[data-bill-dish]').forEach(e=>e.removeAttribute('data-bill-dish'));const card=[...document.querySelectorAll('.pos-card')].find(e=>e.textContent.includes(${JSON.stringify(name)}));card.dataset.billDish='1';})()`,
        );
        await tap('[data-bill-dish]');
        await c.wait("!!document.querySelector('.pos-portions[open]')");
        await tap(
          `.pos-portions button[aria-label="Increase ${name === 'Manchurian' ? 'Half' : 'Full'} quantity"]`,
        );
        await tap('.portion-add');
        await c.wait("!document.querySelector('.pos-portions')");
      }
      if (width < 900) await tap('.mobile-order-trigger');
      if (service) {
        await select('[aria-label="Service type"]', service);
        await c.fill('[aria-label="Table / Reference"]', reference);
      }
      await tap('.confirm-order');
      await c.wait("!!document.querySelector('.order-token')");
      const orders = (await c.http('/orders')).body.orders;
      return orders.at(-1);
    }
    async function openBill(reference) {
      await button('Open Bills');
      await c.wait('!!document.querySelector(\'[aria-label="Find bill"]\')');
      await c.fill('[aria-label="Find bill"]', reference);
      await c.wait("document.querySelectorAll('.bill-card').length===1");
      await button('Open bill');
      await c.wait("!!document.querySelector('.bill-totals')");
    }
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1024, 768],
      [1440, 900],
    ]) {
      await resize(width, height);
      await go('/pos', '.pos-card');
      const reference = 'Table 4 ' + width;
      const first = await addRound(width, 'DINE_IN', reference, true);
      await button('New Order');
      await prepare(first);
      await go('/dispatch', '.dispatch-card');
      assert.ok(
        await c.read(
          "document.querySelector('.dispatch-card').textContent.includes('DUE')",
        ),
      );
      await button('Handed Over');
      await c.wait("!document.querySelector('.dispatch-card')");
      await go('/pos', '.pos-card');
      await openBill(reference);
      await inspect('open-dine-bill', width, height, true);
      await button('Add Items');
      await c.wait("!document.querySelector('.bills-workspace')");
      const second = await addRound(
        width,
        undefined,
        undefined,
        false,
        'Soya Chaap Gravy',
      );
      assert.deepEqual(
        first.items.map((i) => i.itemName),
        ['Manchurian', 'Noodles'],
      );
      assert.equal(second.items[0].itemName, 'Soya Chaap Gravy');
      assert.equal(second.billId, first.billId);
      assert.notEqual(first.tokenNumber, second.tokenNumber);
      await button('New Order');
      await prepare(second);
      await go('/dispatch', '.dispatch-card');
      await button('Handed Over');
      await c.wait("!document.querySelector('.dispatch-card')");
      await go('/pos', '.pos-card');
      await openBill(reference);
      assert.equal(
        (await c.http('/bills/' + first.billId)).body.billTotal,
        '300.00',
      );
      await c.fill('[aria-label="Payment amount"]', '100');
      await select('[aria-label="Payment method"]', 'UPI');
      if (width === 390) {
        await resize(width, 420);
        await inspect('payment-keyboard', width, 420, true);
        await resize(width, height);
        await c.read(
          "(()=>{const original=window.fetch;let drop=true;window.fetch=async(...args)=>{const result=await original(...args);if(drop&&String(args[0]).endsWith('/payments')&&args[1]?.method==='POST'){drop=false;throw new TypeError('simulated lost payment response');}return result;};})()",
        );
      }
      await button('Record Payment');
      if (width === 390) {
        await c.wait("document.body?.textContent.includes('Retry payment')");
        assert.equal(
          (await c.http('/bills/' + first.billId)).body.payments.length,
          1,
        );
        await c.send('Page.reload');
        await c.wait("document.body?.textContent.includes('Retry payment')");
        await button('Retry payment');
      }
      await c.wait(
        "document.querySelector('.bill-payment-status')?.textContent==='PARTIALLY PAID'",
      );
      assert.equal(
        (await c.http('/bills/' + first.billId)).body.payments.length,
        1,
      );
      await c.wait(
        '!!document.querySelector(\'[aria-label="Payment amount"]\')',
      );
      await c.fill('[aria-label="Payment amount"]', '200');
      await select('[aria-label="Payment method"]', 'CASH');
      // Same intended collection, two immediate taps/click events.
      await c.read(
        "(()=>{const e=document.querySelector('.bill-payment button');e.click();e.click();})()",
      );
      await c.wait(
        "document.querySelector('.bill-payment-status')?.textContent==='PAID'",
      );
      const paid = (await c.http('/bills/' + first.billId)).body;
      assert.equal(paid.netPaid, '300.00');
      assert.equal(paid.payments.length, 2);
      assert.equal(paid.status, 'OPEN');
      await inspect('settled-dine-bill', width, height, true);
      await button('Close Bill');
      await c.wait(
        "document.querySelector('.bills-workspace')?.textContent.includes('CLOSED')",
      );
      await button('Back to POS');
      const takeaway = await addRound(width, 'TAKEAWAY', 'Takeaway ' + width);
      await button('New Order');
      await prepare(takeaway);
      await go('/dispatch', '.dispatch-card');
      assert.equal(
        await c.read("document.querySelector('.dispatch-action').disabled"),
        true,
      );
      await inspect('takeaway-payment-required', width, height, true);
      const denied = await c.http(
        `/dispatch/orders/${takeaway.id}/complete`,
        'POST',
      );
      assert.equal(denied.status, 409);
      assert.equal(denied.body.code, 'PAYMENT_REQUIRED');
      if (width === 390) {
        const pure = await device('dispatcher');
        await pure.read("location.hash='/dispatch'");
        await pure.wait("!!document.querySelector('.dispatch-card')");
        assert.equal(
          await pure.read("!!document.querySelector('.bill-collect-link')"),
          false,
        );
        assert.equal(
          await pure.read(
            "document.querySelector('.dispatch-action').disabled",
          ),
          true,
        );
        assert.equal(
          (await pure.http('/bills/' + takeaway.billId)).status,
          403,
        );
        await c.send('Page.bringToFront');
      }
      await tap('.bill-collect-link');
      await c.wait("!!document.querySelector('.bill-payment')");
      await c.fill('[aria-label="Payment amount"]', '100');
      await select('[aria-label="Payment method"]', 'UPI');
      await button('Record Payment');
      await c.wait(
        "document.querySelector('.bill-payment-status')?.textContent==='PAID'",
      );
      await go('/dispatch', '.dispatch-card');
      await button('Handed Over');
      await c.wait("!document.querySelector('.dispatch-card')");
      await go('/pos', '.pos-card');
      await openBill('Takeaway ' + width);
      await button('Close Bill');
      await c.wait(
        "document.querySelector('.bills-workspace')?.textContent.includes('CLOSED')",
      );
      await button('Back to POS');
      console.log(
        `Bills workflow PASS ${width}x${height}: unpaid Dine In serving, additional token, partial UPI/Cash, close; Takeaway gate, multi-role collection/handover.`,
      );
    }
    // Long-reference and all boundary viewport layouts, with no extra feature behavior.
    await go('/pos', '.pos-card');
    await addRound(1440, 'DINE_IN', 'Window table ' + 'L'.repeat(65));
    await button('View Bill / Payment');
    await c.wait("!!document.querySelector('.bill-totals')");
    for (const [width, height] of sizes) {
      await resize(width, height);
      await inspect('long-bill', width, height, true);
    }
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    fs.writeFileSync(
      '/tmp/dukanos-bills-results.json',
      JSON.stringify(report, null, 2),
    );
    console.log(
      'Bills browser PASS: responsive touch scenarios, payment retry after reload, double submission, pure Dispatch restriction, eight sizes, external traffic blocked.',
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
