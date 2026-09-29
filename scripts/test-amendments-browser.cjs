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
  const schema = 'amendment_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const profile = fs.mkdtempSync('/tmp/dukanos-amendments-');
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
      multi: ['CASHIER', 'KITCHEN', 'DISPATCH'],
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
      c.mutations = [];
      c.handlers.push((m) => {
        if (m.method === 'Runtime.exceptionThrown')
          failures.push(m.params.exceptionDetails.text);
        if (m.method !== 'Fetch.requestPaused') return;
        if (m.params.request.method !== 'GET')
          c.mutations.push(m.params.request.url);
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
        const kitchen = r.request.url.includes('/api/');
        if (kitchen && c.hold) {
          c.held.push(r.requestId);
          return;
        }
        void c
          .send(
            !local || (kitchen && c.fail)
              ? 'Fetch.failRequest'
              : 'Fetch.continueRequest',
            !local || (kitchen && c.fail)
              ? { requestId: r.requestId, errorReason: 'InternetDisconnected' }
              : { requestId: r.requestId },
          )
          .catch((e) => {
            if (!e.message.includes('Invalid InterceptionId'))
              failures.push(e.message);
          });
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
      await c.send('Page.enable');
      await c.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__tones=[];window.__contexts=0;
          const NativeAudio=window.AudioContext;
          window.AudioContext=class extends NativeAudio {
            constructor(...args){super(...args);window.__contexts++;}
            resume(){if(window.__blockAudio)return Promise.reject(new Error('Simulated activation block'));return super.resume();}
            createOscillator(){const node=super.createOscillator();const start=node.start.bind(node);node.start=(...args)=>{window.__tones.push({frequency:node.frequency.value,at:performance.now()});return start(...args)};return node;}
          };`,
      });
      await c.send('Page.navigate', { url: origin });
      await c.wait("!!document.querySelector('input[name=username]')");
      await c.read(
        `(()=>{document.querySelector('[name=username]').value=${JSON.stringify(username)};document.querySelector('[name=password]').value=${JSON.stringify(password)};document.querySelector('form').requestSubmit();})()`,
      );
      await c.wait("!!document.querySelector('nav')");
      return c;
    }
    let c = await device('multi');
    const primary = c;
    const cookB = await device('cook');
    await admin.query(`SET search_path TO "${schema}"`);
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
        if (label === 'cash-refund')
          await c.read(
            "document.querySelector('.bill-refund').scrollIntoView({block:'start'})",
          );
        else if (label === 'payment-keyboard')
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
          `/tmp/dukanos-amendments-${label}-${width}.png`,
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
      payment = 'later',
      quantity = 1,
    ) {
      for (const name of two ? ['Manchurian', 'Noodles'] : [dish]) {
        await c.wait(
          `[...document.querySelectorAll('.pos-card')].some(e=>e.textContent.includes(${JSON.stringify(name)}))`,
        );
        await c.read(
          `(()=>{document.querySelectorAll('[data-bill-dish]').forEach(e=>e.removeAttribute('data-bill-dish'));const card=[...document.querySelectorAll('.pos-card')].find(e=>e.textContent.includes(${JSON.stringify(name)}));card.dataset.billDish='1';})()`,
        );
        await tap('[data-bill-dish]');
        await c.wait("!!document.querySelector('.pos-portions[open]')");
        await tap(
          `.pos-portions button[aria-label="Increase ${name === 'Manchurian' ? 'Half' : 'Full'} quantity"]`,
        );
        for (let n = 1; n < quantity; n++)
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
      await c.wait(
        "!!document.querySelector('.payment-review .payment-choices')",
      );
      if (payment === 'split') {
        await button('Partial / Split');
        await c.fill('[aria-label="Confirmation UPI"]', '150');
        await inspect(
          'confirmation-split',
          width,
          await c.read('innerHeight'),
          true,
        );
        await button('Confirm split payment');
      } else if (payment === 'cash' || payment === 'upi') {
        const text = await c.read(
          `[...document.querySelectorAll('.payment-choices button')].find(b=>b.textContent.startsWith('${payment === 'cash' ? 'Cash' : 'UPI'} ₹')).textContent`,
        );
        if (payment === 'cash' && width === 390)
          await c.read(
            "(()=>{const original=window.fetch;let drop=true;window.fetch=async(...args)=>{const r=await original(...args);if(drop&&args[0]==='/api/orders/counter'){drop=false;throw new TypeError('simulated lost confirmation payment response');}return r;};})()",
          );
        await button(text);
        if (payment === 'cash' && width === 390) {
          await c.wait(
            "document.querySelector('.confirm-order')?.textContent==='Retry confirmation'",
          );
          await c.send('Page.reload');
          await c.wait(
            "document.querySelector('.confirm-order')?.textContent==='Retry confirmation'",
          );
          await tap('.mobile-order-trigger');
          await button('Retry confirmation');
        }
      } else await button('Pay Later');
      await c.wait("!!document.querySelector('.order-token')");
      const orders = (await c.http('/orders')).body.orders;
      return orders.at(-1);
    }
    async function complete(order) {
      await prepare(order);
      const r = await fetch(
        origin + `/api/dispatch/orders/${order.id}/complete`,
        {
          method: 'POST',
          headers: { Cookie: cookie, 'X-DukanOS-Request': '1' },
        },
      );
      assert.equal(r.status, 200);
    }
    async function navigate(client, hash, selector) {
      await client.send('Page.navigate', {
        url: origin + '/?testNavigation=' + randomUUID() + '#' + hash,
      });
      await client.wait(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      );
    }

    // Dedicated fixture pricing, never restaurant data.
    await admin.query(
      "UPDATE variant_channel_settings SET price=120 WHERE variant_id IN (SELECT v.id FROM item_variants v JOIN menu_items i ON i.id=v.menu_item_id WHERE i.name='Noodles') AND channel_code='COUNTER'",
    );
    await ownerCall('/menu/items', {
      categoryId: category.id,
      name: 'Pasta',
      variants: [
        {
          name: 'Full',
          channels: [{ channelCode: 'COUNTER', price: '170', available: true }],
        },
      ],
    });
    const widths = [
      [390, 844],
      [768, 1024],
      [1024, 768],
      [1440, 900],
    ];
    const chosen = process.env.AMEND_BROWSER_WIDTH;
    if (chosen) assert.ok(widths.some(([w]) => String(w) === chosen));
    async function replacement(name) {
      await button('Change queued round');
      await c.wait("!!document.querySelector('.amendment-line')");
      await button('Replace dish / portion');
      await c.wait("!!document.querySelector('.replacement-grid article')");
      await c.read(
        `(()=>{const card=[...document.querySelectorAll('.replacement-grid article')].find(e=>e.querySelector('strong').textContent===${JSON.stringify(name)});card.querySelector('button').dataset.replacementChoice='1'})()`,
      );
      await tap('[data-replacement-choice]');
      await button('Review Change');
      await c.wait("!!document.querySelector('.amendment-preview')");
    }
    async function commitChange() {
      await button('Confirm Change');
      await c.wait("!document.querySelector('.amendment-dialog[open]')");
    }
    for (const [width, height] of widths.filter(
      ([w]) => !chosen || String(w) === chosen,
    )) {
      c = primary;
      await resize(width, height);
      await go('/pos', '.pos-card');
      const o = await addRound(
        width,
        'DINE_IN',
        'Amend ' + width,
        false,
        'Noodles',
        'cash',
      );
      await button('View Bill / Payment');
      await c.wait("!!document.querySelector('.bill-rounds')");
      await replacement('Pasta');
      await inspect('more-expensive-preview', width, height, true);
      assert.ok(
        await c.read(
          "document.querySelector('.amendment-preview').textContent.includes('Amount due ₹50')",
        ),
      );
      if (width === 390) {
        await c.read(
          "(()=>{const original=window.fetch;let drop=true;window.fetch=async(...args)=>{const result=await original(...args);if(drop&&String(args[0]).endsWith('/amendments')&&args[1]?.method==='POST'){drop=false;throw new TypeError('simulated lost amendment response');}return result;};})()",
        );
        await button('Confirm Change');
        await c.wait(
          "document.querySelector('.amendment-dialog').textContent.includes('Retry change')",
        );
        await c.send('Page.reload');
        await c.wait(
          "document.querySelector('.amendment-dialog[open]')?.textContent.includes('Retry change')",
        );
        await button('Retry change');
        await c.wait("!document.querySelector('.amendment-dialog[open]')");
        assert.equal(
          (await c.http('/orders/' + o.id + '/amendments')).body.length,
          1,
        );
      } else await commitChange();
      await c.wait(
        "document.querySelector('.bill-payment-status').textContent==='PARTIALLY PAID'",
      );
      await navigate(cookB, '/kitchen', '.kds');
      await cookB.wait(
        `document.querySelector('[data-order-id="${o.id}"]')?.textContent.includes('Pasta')`,
      );
      await cookB.click('Production View');
      await cookB.wait(
        "[...document.querySelectorAll('.kds-production h3')].some(e=>e.textContent==='FULL PASTA')",
      );
      await c.fill('[aria-label="Payment amount"]', '50');
      await select('[aria-label="Payment method"]', 'UPI');
      await button('Record Payment');
      await c.wait(
        "document.querySelector('.bill-payment-status').textContent==='PAID'",
      );
      await tap('.round-amendment summary');
      await c.wait(
        "document.querySelector('.round-amendment details').textContent.includes('Before: Noodles')",
      );
      const financial = (await c.http('/bills/' + o.billId)).body;
      assert.equal(financial.payments.length, 2);
      assert.equal(financial.orders[0].tokenNumber, o.tokenNumber);
      assert.equal(financial.orders[0].items[0].itemName, 'Pasta');
      await complete(o);
      await button('Back to POS');
      const cheaper = await addRound(
        width,
        'TAKEAWAY',
        'Refund ' + width,
        false,
        'Pasta',
        'upi',
      );
      await button('View Bill / Payment');
      await c.wait("!!document.querySelector('.bill-rounds')");
      await replacement('Noodles');
      assert.ok(
        await c.read(
          "document.querySelector('.amendment-preview').textContent.includes('CASH REFUND DUE ₹50')",
        ),
      );
      await commitChange();
      await c.wait("!!document.querySelector('.bill-refund')");
      assert.equal(
        await c.read("document.querySelector('.bill-refund select')===null"),
        true,
      );
      await inspect('cash-refund', width, height, true);
      await prepare(cheaper);
      await go('/dispatch', '.dispatch');
      await c.wait(
        `!!document.querySelector('[data-order-id="${cheaper.id}"]')`,
      );
      assert.ok(
        await c.read(
          `document.querySelector('[data-order-id="${cheaper.id}"]').textContent.includes('REFUND 50.00 AT COUNTER')||document.querySelector('[data-order-id="${cheaper.id}"]').textContent.includes('REFUND ₹50')`,
        ),
      );
      assert.equal(
        await c.read(
          `document.querySelector('[data-order-id="${cheaper.id}"] .dispatch-action').disabled`,
        ),
        true,
      );
      await navigate(c, '/pos?bill=' + cheaper.billId, '.bill-refund');
      await c.fill('[aria-label="Cash refund amount"]', '30');
      if (width === 390)
        await c.read(
          "(()=>{const original=window.fetch;let drop=true;window.fetch=async(...args)=>{const result=await original(...args);if(drop&&String(args[0]).endsWith('/refunds')&&args[1]?.method==='POST'){drop=false;throw new TypeError('simulated lost refund response');}return result;};})()",
        );
      await button('Confirm Cash Refund');
      if (width === 390) {
        await c.wait(
          "document.body?.textContent.includes('Retry cash refund')",
        );
        await c.send('Page.reload');
        await c.wait(
          "document.body?.textContent.includes('Retry cash refund')",
        );
        await button('Retry cash refund');
      }
      await c.wait(
        "document.querySelector('.bill-refund h2')?.textContent.includes('₹20') && !!document.querySelector('[aria-label=\"Cash refund amount\"]')",
      );
      await c.fill('[aria-label="Cash refund amount"]', '20');
      await c.read(
        "(()=>{const b=document.querySelector('.bill-refund button');b.click();b.click();})()",
      );
      await c.wait(
        "document.querySelector('.bill-payment-status').textContent==='PAID'",
      );
      const b = (await c.http('/bills/' + cheaper.billId)).body;
      assert.equal(b.payments.filter((p) => p.type === 'REFUND').length, 2);
      assert.equal(b.netPaid, '120.00');
      const handed = await c.http(
        '/dispatch/orders/' + cheaper.id + '/complete',
        'POST',
      );
      assert.equal(handed.status, 200);
      await button('Back to POS');
      const note = await addRound(
        width,
        'DINE_IN',
        'Note ' + width,
        false,
        'Noodles',
        'later',
        3,
      );
      await button('View Bill / Payment');
      await c.wait("!!document.querySelector('.bill-rounds')");
      await button('Change queued round');
      await c.wait("!!document.querySelector('.amendment-line textarea')");
      await c.fill('.amendment-line input', '2');
      await c.fill('.amendment-line textarea', 'No onion');
      await button('Review Change');
      await c.wait("!!document.querySelector('.amendment-preview')");
      await commitChange();
      await c.wait(
        "document.querySelector('.bill-rounds').textContent.includes('Full ×2')&&document.querySelector('.bill-rounds').textContent.includes('No onion')",
      );
      await button('Change queued round');
      await c.wait("!!document.querySelector('.amendment-line textarea')");
      await c.fill('.amendment-line textarea', 'No capsicum');
      await button('Review Change');
      await c.wait("!!document.querySelector('.amendment-preview')");
      await callStart(note);
      await button('Confirm Change');
      await c.wait(
        "document.querySelector('.amendment-dialog').textContent.includes('Preparation has started')",
      );
      await inspect('preparation-race', width, height, true);
      await button('Close change');
      await ownerReady(note);
      await c.http('/dispatch/orders/' + note.id + '/complete', 'POST');
      await button('Back to POS');
      console.log(
        `Amendments PASS ${width}x${height}: higher replacement/UPI, lower replacement/partial CASH refund, same token and effective Kitchen, Takeaway gate, START race.`,
      );
    }
    async function callStart(o) {
      const r = await fetch(origin + `/api/kitchen/orders/${o.id}/start`, {
        method: 'POST',
        headers: { Cookie: cookie, 'X-DukanOS-Request': '1' },
      });
      assert.equal(r.status, 200);
    }
    async function ownerReady(o) {
      const r = await fetch(origin + `/api/kitchen/orders/${o.id}/ready`, {
        method: 'POST',
        headers: { Cookie: cookie, 'X-DukanOS-Request': '1' },
      });
      assert.equal(r.status, 200);
    }
    c = primary;
    await resize(1440, 900);
    await go('/pos', '.pos-card');
    const sample = await addRound(
      1440,
      'DINE_IN',
      'Boundary',
      false,
      'Noodles',
      'later',
    );
    await button('View Bill / Payment');
    await c.wait("!!document.querySelector('.bill-rounds')");
    await replacement('Pasta');
    for (const [w, h] of sizes) {
      await resize(w, h);
      await inspect('amendment-boundary', w, h, true);
    }
    await resize(390, 420);
    await inspect('amendment-keyboard', 390, 420, true);
    await button('Close change');
    assert.ok(sample.id);
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    console.log(
      'Amendment browser PASS: isolated fixtures, touch workflows and eight responsive sizes, external traffic blocked.',
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
