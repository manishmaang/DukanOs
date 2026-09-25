const root = require('node:path').resolve(__dirname, '..');
const chromeBinary = process.env.CHROME_BINARY;
if (!chromeBinary)
  throw new Error(
    'Set CHROME_BINARY to a local Chromium or Chrome executable.',
  );
const requireProject = require('node:module').createRequire(
  root + '/package.json',
);
requireProject('reflect-metadata');
const { Client } = requireProject('pg');
const { Test } = requireProject('@nestjs/testing');
const express = requireProject('express');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { AppModule } = require(root + '/apps/api/dist/app.module');
const { configureApp } = require(root + '/apps/api/dist/configure-app');
const { UsersService } = require(
  root + '/apps/api/dist/modules/users/users.service',
);
(async () => {
  const original = process.env.DATABASE_URL;
  const admin = new Client({ connectionString: original });
  await admin.connect();
  const schema = 'menu_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(original);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  let app, chrome, ws;
  const profile = fs.mkdtempSync('/tmp/dukanos-chrome-');
  process.env.DUKANOS_DATA_DIR = profile + '/media';
  try {
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
    const users = app.get(UsersService);
    const password = randomUUID() + '!';
    const owner = await users.create({
      username: 'owner',
      name: 'Owner',
      password,
      roles: ['OWNER'],
    });
    for (const role of ['MANAGER', 'CASHIER', 'KITCHEN'])
      await users.create(
        { username: role.toLowerCase(), name: role, password, roles: [role] },
        owner,
      );
    chrome = spawn(
      chromeBinary,
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
      let output = '';
      chrome.stderr.on('data', (d) => {
        output += d;
        const m = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      chrome.on('error', reject);
    });
    const target = (
      await (
        await fetch(
          endpoint
            .replace('ws:', 'http:')
            .replace(/\/devtools\/browser\/.*/, '/json'),
        )
      ).json()
    )[0];
    ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let sequence = 0;
    const pending = new Map();
    const failures = [];
    const external = [];
    const writes = [];
    const orderPayloads = [];
    const command = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      } else if (m.method === 'Fetch.requestPaused') {
        const req = m.params;
        if (
          req.request.url.includes('/api/menu/items') &&
          ['POST', 'PUT'].includes(req.request.method)
        )
          writes.push(req.request.method);
        if (
          req.request.url.endsWith('/api/orders/counter') &&
          req.request.method === 'POST'
        )
          orderPayloads.push(JSON.parse(req.request.postData));
        const local =
          req.request.url.startsWith(origin) ||
          req.request.url.startsWith('data:') ||
          req.request.url.startsWith('blob:');
        if (!local) external.push(req.request.url);
        void command(
          local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          local
            ? { requestId: req.requestId }
            : { requestId: req.requestId, errorReason: 'InternetDisconnected' },
        ).catch((e) => {
          if (!e.message.includes('Invalid InterceptionId'))
            failures.push(e.message);
        });
      } else if (m.method === 'Runtime.exceptionThrown')
        failures.push(m.params.exceptionDetails.text);
    });
    await command('Runtime.enable');
    await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await command('Page.navigate', { url: origin });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(
        'Browser condition timed out: ' +
          expression +
          ' PAGE: ' +
          (await evaluate('document.body.innerText')),
      );
    };
    const login = async (role) => {
      await wait(
        "!document.querySelector('nav') && !!document.querySelector('input[name=username]')",
      );
      await evaluate(
        `(()=>{for(const [name,value] of Object.entries(${JSON.stringify({ username: '', password })})){const input=document.querySelector('input[name='+name+']');input.value=name==='username'?${JSON.stringify(role.toLowerCase())}:value;}document.querySelector('form').requestSubmit();})()`,
      );
      await wait("!!document.querySelector('nav')");
    };
    const http = async (method, path, body) =>
      evaluate(
        `fetch('/api/menu${path}',{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json','X-DukanOS-Request':'1'},body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,body:await r.json()}))`,
      );
    const click = async (text) =>
      evaluate(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Button not found');b.click();})()`,
      );
    const fill = async (selector, value) =>
      evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Input not found: '+${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
      );
    const noteIn = async (selector, value) => {
      await evaluate(
        `(()=>{const scope=document.querySelector(${JSON.stringify(selector)});scope.querySelector('button[aria-label^="Add instruction"],button[aria-label^="Edit instruction"]').click();})()`,
      );
      await fill(selector + ' textarea', value);
      await evaluate(
        `[...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')].find(b=>b.textContent==='Done').click()`,
      );
    };
    const portionNote = async (name, value) => {
      const id = await evaluate(
        `[...document.querySelectorAll('.pos-portions .portion-row')].find(r=>r.querySelector('.portion-name strong').textContent===${JSON.stringify(name)}).dataset.variantId`,
      );
      await noteIn('.pos-portions [data-variant-id="' + id + '"]', value);
    };
    const save = async () => {
      await click(
        await evaluate(
          "document.querySelector('.dish-save button').textContent",
        ),
      );
      await wait(
        "document.querySelector('.dish-save')?.textContent.includes('All changes saved')",
      );
    };

    const sharp = requireProject('sharp');
    const photoPath = profile + '/test-photo.jpg';
    const secondPath = profile + '/replacement.png';
    await sharp({
      create: { width: 1500, height: 1000, channels: 3, background: '#bd8234' },
    })
      .jpeg()
      .toFile(photoPath);
    await sharp({
      create: { width: 700, height: 500, channels: 3, background: '#5c943b' },
    })
      .png()
      .toFile(secondPath);
    const attach = async (path) => {
      const { root: dom } = await command('DOM.getDocument');
      const { nodeId } = await command('DOM.querySelector', {
        nodeId: dom.nodeId,
        selector: 'input[type=file]',
      });
      await command('DOM.setFileInputFiles', { nodeId, files: [path] });
      await wait(
        "document.querySelector('.dish-photo-editor img')?.src.startsWith('blob:')",
      );
    };
    const openMenu = async (name) => {
      await evaluate("location.hash='/menu'");
      await wait("!!document.querySelector('.menu-sidebar')");
      await evaluate(
        `[...document.querySelectorAll('.dish-link')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`,
      );
      await wait(
        `document.querySelector('[name=itemName]')?.value===${JSON.stringify(name)}`,
      );
    };
    const openPOS = async () => {
      await evaluate("location.hash='/pos'");
      await wait("!!document.querySelector('.pos-card')");
    };
    await command('Emulation.setDeviceMetricsOverride', {
      width: 1365,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await login('OWNER');
    const chinese = (await http('POST', '/categories', { name: 'Chinese' }))
      .body;
    const soya = (await http('POST', '/categories', { name: 'Soya Chaap' }))
      .body;
    const dishBody = (name, categoryId) => ({
      name,
      categoryId,
      variants: [
        {
          name: 'Half',
          displayLabel: 'SCG-F',
          channels: [
            { channelCode: 'COUNTER', price: '200', available: true },
            { channelCode: 'SWIGGY', price: '350', available: true },
          ],
        },
        {
          name: 'Full',
          displayLabel: 'SCG-H',
          channels: [{ channelCode: 'COUNTER', price: '250', available: true }],
        },
      ],
    });
    await http('POST', '/items', dishBody('Manchurian', chinese.id));
    let gravy = (
      await http('POST', '/items', dishBody('Soya Chaap Gravy', soya.id))
    ).body;
    await http('PATCH', '/items/' + gravy.id, {
      version: gravy.version,
      active: false,
    });
    await openMenu('Soya Chaap Gravy');
    assert.match(
      await evaluate("document.querySelector('.counter-visibility').innerText"),
      /paused/,
    );
    await evaluate(
      "document.querySelector('.item-availability input').click()",
    );
    await attach(photoPath);
    await save();
    await wait(
      "document.querySelector('.dish-photo-editor img')?.src.includes('/api/menu/images/') && document.querySelector('.dish-photo-editor img').naturalWidth>0",
    );
    const firstPhoto = await evaluate(
      "document.querySelector('.dish-photo-editor img').src",
    );
    await openPOS();
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      2,
    );
    await click('Soya Chaap');
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      1,
    );
    assert.ok(
      await evaluate("document.querySelector('.pos-card img')?.naturalWidth>0"),
    );
    await evaluate("document.querySelector('.pos-card').click()");
    await wait("document.querySelector('dialog').open");
    const portions = await evaluate(
      "document.querySelector('dialog').innerText",
    );
    assert.match(portions, /200/);
    assert.match(portions, /250/);
    assert.doesNotMatch(portions, /350|Swiggy|Zomato/);
    await evaluate("document.querySelector('.pos-close').click()");
    await fill('.pos-search input', 'missing');
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      0,
    );
    await fill('.pos-search input', 'gravy');
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      1,
    );
    await fill('.pos-search input', '');
    await click('All dishes');
    // Refresh a POS which stays mounted: another manager save is noticed by the polling timer.
    const fresh = (
      await http('POST', '/items', dishBody('Fresh dish', chinese.id))
    ).body;
    for (let i = 0; i < 200; i++) {
      if (await evaluate("document.querySelectorAll('.pos-card').length===3"))
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      3,
    );
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.menu-photo-placeholder').length",
      ),
      2,
    );
    await openMenu('Soya Chaap Gravy');
    await attach(secondPath);
    await save();
    await openPOS();
    await wait("document.querySelector('.pos-card img')?.naturalWidth>0");
    assert.notEqual(
      await evaluate("document.querySelector('.pos-card img').src"),
      firstPhoto,
    );
    let shot = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    fs.writeFileSync(
      '/tmp/dukanos-visual-pos-desktop.png',
      Buffer.from(shot.data, 'base64'),
    );
    await command('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.ok(
      await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),
    );
    shot = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    fs.writeFileSync(
      '/tmp/dukanos-visual-pos-tablet.png',
      Buffer.from(shot.data, 'base64'),
    );
    await openMenu('Soya Chaap Gravy');
    await click('Remove photo');
    await save();
    await openPOS();
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.menu-photo-placeholder').length",
      ),
      3,
    );
    await http('PATCH', '/items/' + fresh.id, {
      version: fresh.version,
      active: false,
    });
    await click('Refresh menu');
    await wait("document.querySelectorAll('.pos-card').length===2");
    await evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='Sign out').click()",
    );
    await login('CASHIER');
    await openPOS();
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      2,
    );
    assert.equal(
      (await http('POST', '/items', dishBody('Denied', chinese.id))).status,
      403,
    );
    // Independent browser context: separate cookie jar and no cross-context BroadcastChannel.
    const connect = async (address) => {
      const socket = new globalThis.WebSocket(address);
      await new Promise((r) =>
        socket.addEventListener('open', r, { once: true }),
      );
      let id = 0;
      const waiting = new Map();
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const key = ++id;
          waiting.set(key, { resolve, reject });
          socket.send(JSON.stringify({ id: key, method, params }));
        });
      socket.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id) {
          const p = waiting.get(m.id);
          waiting.delete(m.id);
          if (m.error) p.reject(Error(JSON.stringify(m.error)));
          else p.resolve(m.result);
        } else if (m.method === 'Fetch.requestPaused') {
          const local = m.params.request.url.startsWith(origin);
          if (!local) external.push(m.params.request.url);
          void send(
            local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
            local
              ? { requestId: m.params.requestId }
              : {
                  requestId: m.params.requestId,
                  errorReason: 'InternetDisconnected',
                },
          );
        }
      });
      return { socket, send };
    };
    const browser = await connect(endpoint);
    let second;
    let contextId;
    try {
      contextId = (await browser.send('Target.createBrowserContext'))
        .browserContextId;
      const id = (
        await browser.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: contextId,
        })
      ).targetId;
      second = await connect(
        endpoint.replace(/\/devtools\/browser\/.*/, '/devtools/page/' + id),
      );
      const send = second.send;
      const read = async (expression) => {
        const result = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails)
          throw Error('Second browser evaluation failed');
        return result.result.value;
      };
      const waitSecond = async (expression) => {
        for (let i = 0; i < 100; i++) {
          if (await read(expression)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw Error(
          'Second browser state did not propagate: ' +
            expression +
            ' PAGE: ' +
            (await read('document.body.innerText')),
        );
      };
      await send('Runtime.enable');
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await send('Page.navigate', { url: origin });
      await waitSecond("!!document.querySelector('input[name=username]')");
      await read(
        `(()=>{for(const [name,value] of Object.entries(${JSON.stringify({ username: 'manager', password })})){document.querySelector('input[name='+name+']').value=value;}document.querySelector('form').requestSubmit();})()`,
      );
      await waitSecond("!!document.querySelector('nav')");
      await send('Page.navigate', { url: origin + '/#/pos' });
      await waitSecond("document.querySelectorAll('.pos-card').length===2");
      await send('Page.bringToFront');
      await evaluate(
        "[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes('Manchurian')).click()",
      );
      await wait("document.querySelector('dialog').open");
      await click('Mark dish sold out');
      await wait(
        "!document.querySelector('.pos-item-availability').disabled && document.querySelector('.pos-item-availability').textContent==='Make dish available'",
      );
      await waitSecond(
        "[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes('Manchurian')).textContent.includes('Sold out')",
      );
      assert.equal(
        await evaluate("document.querySelectorAll('.pos-card').length"),
        2,
      );
      await click('Make dish available');
      await wait(
        "!document.querySelector('.pos-item-availability').disabled && document.querySelector('.pos-item-availability').textContent==='Mark dish sold out'",
      );
      await evaluate(
        'document.querySelector(\'button[aria-label="Half: Mark sold out"]\').click()',
      );
      await wait(
        '!!document.querySelector(\'button[aria-label="Half: Make available"]\')',
      );
      assert.ok(
        await evaluate(
          '!!document.querySelector(\'button[aria-label="Full: Mark sold out"]\')',
        ),
      );
      await waitSecond(
        "[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes('Manchurian')).textContent.includes('Some portions sold out')",
      );
      await evaluate(
        'document.querySelector(\'button[aria-label="Half: Make available"]\').click()',
      );
      await wait(
        '!!document.querySelector(\'button[aria-label="Half: Mark sold out"]\')',
      );
      assert.equal(
        (await http('GET', '?channel=SWIGGY')).body.categories
          .flatMap((c) => c.items)
          .find((i) => i.name === 'Manchurian').variants[0].price,
        '350.00',
      );
      await evaluate("document.querySelector('.pos-close').click()");
      console.log(
        'Browser PASS: cashier whole-dish/variant Counter toggles, sold-out restoration and independent manager browser propagation within polling window.',
      );
      // Real cashier interaction: portion, quantity, note, cart edits and confirmation.
      await click('Soya Chaap');
      await evaluate("document.querySelector('.pos-card').click()");
      assert.equal(
        await evaluate("document.querySelector('.portion-add').disabled"),
        true,
      );
      await evaluate(
        `document.querySelector('button[aria-label="Increase Half quantity"]').click()`,
      );
      await evaluate(
        `document.querySelector('button[aria-label="Increase Full quantity"]').click()`,
      );
      await portionNote('Full', 'No onion');
      assert.equal(
        await evaluate("document.querySelector('.portion-add').textContent"),
        'Add 2 items · ₹450',
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.portion-row.selected').length",
        ),
        2,
      );
      assert.ok(
        !(
          await evaluate("document.querySelector('dialog').textContent")
        ).includes('SCG-'),
      );
      await evaluate("document.querySelector('.portion-add').click()");
      await wait("document.querySelectorAll('.cart-line').length===2");
      assert.equal(
        await evaluate("document.querySelectorAll('.cart-dish').length"),
        1,
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.order-cart textarea').length",
        ),
        0,
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.cart-line')].map(r=>r.querySelector('.instruction-text')?.textContent??'')",
        ),
        ['', 'Note: No onion'],
      );
      const firstLineId = await evaluate(
        "document.querySelector('.cart-line').dataset.lineId",
      );
      const halfCart = '[data-line-id="' + firstLineId + '"]';
      await noteIn(halfCart, 'Nothing spicy');
      await noteIn(halfCart, 'Less spicy');
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.cart-line')[1].querySelector('.instruction-text').textContent",
        ),
        'Note: No onion',
      );
      await evaluate(
        `document.querySelector(${JSON.stringify(halfCart)}).querySelector('button[aria-label^="Remove instruction"]').click()`,
      );
      assert.equal(
        await evaluate(
          `document.querySelector(${JSON.stringify(halfCart)}).querySelector('textarea,.instruction-text')===null`,
        ),
        true,
      );

      await click('All dishes');
      const openManchurian = async () => {
        await evaluate(
          "[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes('Manchurian')).click()",
        );
        await evaluate(
          `document.querySelector('button[aria-label="Increase Half quantity"]').click()`,
        );
        await evaluate("document.querySelector('.portion-add').click()");
      };
      await openManchurian();
      await evaluate(
        `document.querySelectorAll('.cart-line')[2].querySelector('button[aria-label="Increase Half quantity"]').click()`,
      );
      await evaluate(
        "document.querySelectorAll('.cart-line')[2].querySelector('.cart-remove').click()",
      );
      await openManchurian();
      assert.ok(
        (
          await evaluate("document.querySelector('.order-cart').textContent")
        ).includes('650'),
      );
      await evaluate(
        "(()=>{const b=document.querySelector('.confirm-order');b.click();b.click();})()",
      );
      await wait(
        "!!document.querySelector('.payment-review .payment-choices')",
      );
      await click('Pay Later');
      await wait(
        "document.querySelector('.order-token')?.textContent==='TOKEN #1'",
      );
      const orderRead = async () =>
        evaluate("fetch('/api/orders?status=QUEUED').then(r=>r.json())");
      let placed = (await orderRead()).orders;
      assert.equal(placed.length, 1);
      assert.equal(placed[0].status, 'QUEUED');
      assert.equal(placed[0].items[0].quantity, 1);
      assert.equal(placed[0].items[0].instruction, '');
      assert.equal(placed[0].items[1].variantName, 'Full');
      assert.equal(placed[0].items[1].quantity, 1);
      assert.equal(placed[0].items[1].instruction, 'No onion');
      assert.equal(placed[0].items[0].unitPrice, '200.00');
      assert.equal(placed[0].grandTotal, '650.00');
      assert.deepEqual(
        orderPayloads[0].lines.map((l) => l.instruction),
        ['', 'No onion', ''],
      );
      await click('New Order');
      await openManchurian();
      await click('Confirm Order');
      await wait(
        "!!document.querySelector('.payment-review .payment-choices')",
      );
      await click('Pay Later');
      await wait(
        "document.querySelector('.order-token')?.textContent==='TOKEN #2'",
      );
      assert.equal((await orderRead()).orders.length, 2);
      await click('New Order');
      await openManchurian();
      // A second authenticated manager changes availability after selection.
      const toggled = await read(
        "(async()=>{const menu=await fetch('/api/menu/counter').then(r=>r.json());const item=menu.categories.flatMap(c=>c.items).find(i=>i.name==='Manchurian');return fetch('/api/menu/counter/items/'+item.id+'/availability',{method:'PATCH',headers:{'Content-Type':'application/json','X-DukanOS-Request':'1'},body:JSON.stringify({version:item.version,available:false})}).then(r=>r.status);})()",
      );
      assert.equal(toggled, 200);
      await click('Confirm Order');
      await wait(
        "document.querySelector('.order-cart [role=alert]')?.textContent.includes('no longer available')",
      );
      assert.equal((await orderRead()).orders.length, 2);
      await click('Back to order');
      await read(
        "(async()=>{const menu=await fetch('/api/menu/counter').then(r=>r.json());const item=menu.categories.flatMap(c=>c.items).find(i=>i.name==='Manchurian');await fetch('/api/menu/counter/items/'+item.id+'/availability',{method:'PATCH',headers:{'Content-Type':'application/json','X-DukanOS-Request':'1'},body:JSON.stringify({version:item.version,available:true})});})()",
      );
      await evaluate(
        "(()=>{Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});const original=window.fetch;let drop=true;window.fetch=async(...args)=>{const result=await original(...args);if(drop&&args[0]==='/api/orders/counter'){drop=false;throw new TypeError('simulated lost response');}return result;};})()",
      );
      await click('Confirm Order');
      await wait(
        "!!document.querySelector('.payment-review .payment-choices')",
      );
      await click('Pay Later');
      await wait(
        "document.querySelector('.confirm-order')?.textContent==='Retry confirmation'",
      );
      assert.equal((await orderRead()).orders.length, 3);
      await command('Page.reload');
      await wait(
        "document.querySelector('.confirm-order')?.textContent==='Retry confirmation'",
      );
      await click('Retry confirmation');
      await wait(
        "document.querySelector('.order-token')?.textContent==='TOKEN #3'",
      );
      assert.equal((await orderRead()).orders.length, 3);
      console.log(
        'Browser PASS: HTTP-LAN-compatible request UUID, lost confirmation response, page reload and safe retry recover token #3 without duplication.',
      );
      await click('New Order');
      await evaluate(
        "[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes('Manchurian')).click()",
      );
      await evaluate(
        `document.querySelector('.pos-portions button[aria-label="Increase Half quantity"]').click()`,
      );
      await evaluate(
        `document.querySelector('.pos-portions button[aria-label="Increase Full quantity"]').click()`,
      );
      await portionNote('Half', 'Nothing spicy');
      await portionNote('Full', 'Extra spicy');
      await evaluate("document.querySelector('.portion-add').click()");
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.cart-line .instruction-text')].map(e=>e.textContent)",
        ),
        ['Note: Nothing spicy', 'Note: Extra spicy'],
      );
      await click('Confirm Order');
      await wait(
        "!!document.querySelector('.payment-review .payment-choices')",
      );
      await click('Pay Later');
      await wait(
        "document.querySelector('.order-token')?.textContent==='TOKEN #4'",
      );
      const independent = (await orderRead()).orders.find(
        (o) => o.tokenNumber === 4,
      );
      assert.deepEqual(
        orderPayloads.at(-1).lines.map((l) => l.instruction),
        ['Nothing spicy', 'Extra spicy'],
      );
      assert.deepEqual(
        independent.items.map((l) => [l.variantName, l.instruction]),
        [
          ['Half', 'Nothing spicy'],
          ['Full', 'Extra spicy'],
        ],
      );
      const stored = (
        await admin.query(
          `SELECT variant_name_snapshot,instruction FROM "${schema}".order_items WHERE order_id=$1 ORDER BY position`,
          [independent.id],
        )
      ).rows;
      assert.deepEqual(stored, [
        { variant_name_snapshot: 'Half', instruction: 'Nothing spicy' },
        { variant_name_snapshot: 'Full', instruction: 'Extra spicy' },
      ]);
      await click('New Order');
      console.log(
        'Browser PASS: independent Manchurian Half/Full instructions in actual payload, confirmed API and PostgreSQL; Soya Full-only note leaves Half clean; cart add/edit/remove note changes only its line.',
      );
      const longName =
        'Family Special Vegetable Noodles with Seasonal Greens and Fresh Herbs for Sharing';
      const createFixture = async (body) =>
        read(
          `fetch('/api/menu/items',{method:'POST',headers:{'Content-Type':'application/json','X-DukanOS-Request':'1'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,body:await r.json()}))`,
        );
      const many = await createFixture({
        name: longName,
        categoryId: chinese.id,
        variants: ['Regular', 'Half', 'Full', 'Large'].map((name, i) => ({
          name,
          channels: [
            {
              channelCode: 'COUNTER',
              price: ['80.50', '120', '180', '240'][i],
              available: true,
            },
          ],
        })),
      });
      assert.equal(many.status, 201);
      const single = await createFixture({
        name: 'Spring Roll',
        categoryId: chinese.id,
        variants: [
          {
            name: 'Standard',
            channels: [
              { channelCode: 'COUNTER', price: '120', available: true },
            ],
          },
        ],
      });
      assert.equal(single.status, 201);
      await click('Refresh menu');
      await wait("document.querySelectorAll('.pos-card').length===4");
      const openDish = async (name) =>
        evaluate(
          `[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`,
        );
      const increment = async (name) =>
        evaluate(
          `document.querySelector('button[aria-label="Increase ${name} quantity"]').click()`,
        );
      await command('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await openDish(longName);
      await increment('Regular');
      await increment('Half');
      await increment('Full');
      assert.equal(
        await evaluate("document.querySelector('.portion-add').textContent"),
        'Add 3 items · ₹380.5',
      );
      const layout = await evaluate(
        "(()=>{const d=document.querySelector('dialog'),b=document.querySelector('.portion-content'),a=document.querySelector('.portion-add');return {width:d.getBoundingClientRect().width,height:d.getBoundingClientRect().height,bodyHeight:b.clientHeight,bodyScroll:b.scrollHeight,footerBottom:a.getBoundingClientRect().bottom,viewport:innerHeight,overflow:d.scrollWidth>d.clientWidth};})()",
      );
      assert.equal(layout.width, 1040);
      assert.ok(
        layout.bodyScroll <= layout.bodyHeight + 1,
        JSON.stringify(layout),
      );
      assert.ok(layout.footerBottom < layout.viewport);
      assert.equal(layout.overflow, false);
      let selectionShot = await command('Page.captureScreenshot', {
        format: 'png',
      });
      fs.writeFileSync(
        '/tmp/dukanos-multi-portion-desktop.png',
        Buffer.from(selectionShot.data, 'base64'),
      );
      await command('Emulation.setDeviceMetricsOverride', {
        width: 1366,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.ok(
        await evaluate(
          "(()=>{const b=document.querySelector('.portion-content');return b.scrollHeight<=b.clientHeight+1 && document.querySelector('.portion-add').getBoundingClientRect().bottom<innerHeight;})()",
        ),
        'Four default portion controls must fit a 1366×768 desktop',
      );
      await command('Emulation.setDeviceMetricsOverride', {
        width: 768,
        height: 1024,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.ok(
        await evaluate(
          "(()=>{const d=document.querySelector('dialog'),a=document.querySelector('.portion-add');return d.scrollWidth<=d.clientWidth && a.getBoundingClientRect().bottom<innerHeight && document.querySelector('.portion-content').scrollHeight<=document.querySelector('.portion-content').clientHeight+1;})()",
        ),
      );
      selectionShot = await command('Page.captureScreenshot', {
        format: 'png',
      });
      fs.writeFileSync(
        '/tmp/dukanos-multi-portion-tablet.png',
        Buffer.from(selectionShot.data, 'base64'),
      );
      await portionNote('Regular', 'Extra spicy');
      await portionNote('Half', 'No onion');
      await portionNote('Full', 'Extra spicy');
      await evaluate("document.querySelector('.portion-add').click()");
      assert.equal(
        await evaluate("document.querySelectorAll('.cart-line').length"),
        3,
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.cart-line .instruction-text')].map(e=>e.textContent)",
        ),
        ['Note: Extra spicy', 'Note: No onion', 'Note: Extra spicy'],
      );
      await openDish('Spring Roll');
      assert.equal(
        await evaluate("document.querySelectorAll('.portion-row').length"),
        1,
      );
      await increment('Standard');
      await evaluate("document.querySelector('.portion-add').click()");
      assert.equal(
        await evaluate("document.querySelectorAll('.cart-line').length"),
        4,
      );
      await openDish(longName);
      await increment('Full');
      await evaluate("document.querySelector('.pos-close').click()");
      assert.equal(
        await evaluate("document.querySelectorAll('.cart-line').length"),
        4,
      );
      await openDish(longName);
      assert.equal(
        await evaluate("document.querySelector('.portion-add').disabled"),
        true,
      );
      await increment('Full');
      await portionNote('Full', 'No vegetables');
      await evaluate("document.querySelector('.portion-add').click()");
      assert.equal(
        await evaluate("document.querySelectorAll('.cart-line').length"),
        5,
      );
      await openDish(longName);
      await increment('Half');
      await evaluate(
        `document.querySelector('button[aria-label="Half: Mark sold out"]').click()`,
      );
      await wait(
        `!!document.querySelector('button[aria-label="Half: Make available"]')`,
      );
      assert.equal(
        await evaluate(
          `document.querySelector('button[aria-label="Increase Half quantity"]').disabled`,
        ),
        true,
      );
      assert.equal(
        await evaluate("document.querySelector('.portion-add').disabled"),
        true,
      );
      await increment('Regular');
      await evaluate("document.querySelector('.portion-add').click()");
      assert.equal(
        await evaluate("document.querySelectorAll('.cart-line').length"),
        6,
      );
      console.log(
        'Browser PASS: four-portion long-name desktop/tablet dialog fits, three selected together with exact total, zero/sold-out excluded, independent per-portion notes, single portion, prior cart preserved, close discards selection and differently customized lines stay separate.',
      );
      for (let i = 0; i < 6; i++) {
        await openDish('Spring Roll');
        await increment('Standard');
        await portionNote('Standard', 'Separate preparation ' + i);
        await evaluate("document.querySelector('.portion-add').click()");
      }
      assert.equal(
        await evaluate("document.querySelectorAll('.cart-line').length"),
        12,
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.order-cart textarea').length",
        ),
        0,
      );
      await command('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate('window.scrollTo(0,0)');
      const cartLayout = await evaluate(
        "(()=>{const c=document.querySelector('.order-cart'),i=document.querySelector('.cart-items'),b=document.querySelector('.confirm-order');return {width:c.getBoundingClientRect().width,scroll:i.scrollHeight>i.clientHeight,buttonBottom:b.getBoundingClientRect().bottom,viewport:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};})()",
      );
      assert.ok(cartLayout.width >= 430, JSON.stringify(cartLayout));
      assert.ok(cartLayout.scroll);
      assert.ok(
        cartLayout.buttonBottom <= cartLayout.viewport,
        JSON.stringify(cartLayout),
      );
      assert.equal(cartLayout.overflow, false);
      let cartShot = await command('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(
        '/tmp/dukanos-compact-cart-desktop.png',
        Buffer.from(cartShot.data, 'base64'),
      );
      await command('Emulation.setDeviceMetricsOverride', {
        width: 768,
        height: 1024,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate("document.querySelector('.mobile-order-trigger').click()");
      await wait("!!document.querySelector('.cart-dialog:modal')");
      assert.ok(
        await evaluate(
          "document.querySelector('.confirm-order').getBoundingClientRect().bottom<=innerHeight && document.documentElement.scrollWidth<=innerWidth",
        ),
      );
      cartShot = await command('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(
        '/tmp/dukanos-compact-cart-tablet.png',
        Buffer.from(cartShot.data, 'base64'),
      );
      console.log(
        'Browser PASS: 12 independent cart lines grouped by dish; desktop cart exceeds 430px, item area scrolls independently and confirmation remains visible on desktop/tablet.',
      );
      const finalShot = await command('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      });
      fs.writeFileSync(
        '/tmp/dukanos-orders-browser.png',
        Buffer.from(finalShot.data, 'base64'),
      );
      console.log(
        'Browser PASS: CASHIER Soya Half ×1 + Full ×1 in one Add, independent optional notes, second dish quantity/remove/re-add, double click creates one QUEUED order, authoritative snapshots, next token and another-session sold-out rejection.',
      );
    } finally {
      second?.socket.close();
      if (contextId)
        await browser.send('Target.disposeBrowserContext', {
          browserContextId: contextId,
        });
      browser.socket.close();
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(external, []);
    console.log(
      'Browser PASS: owner paused-item diagnostics/reactivation, upload/replace/remove, image rendering/placeholders, Counter-only portions, search/category filtering, fresh item while POS stays open, inactive filtering, Manchurian preserved, cashier configuration denial, desktop/tablet and zero external requests. Isolated fixtures; real menu unchanged.',
    );
  } finally {
    if (ws) ws.close();
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
