// headless Chrome + CDP：截图 / 在页面里求值
// 用法: node cdp.mjs <url> <out.png> [evalFile.js] [w] [h]
//   evalFile 里写一段表达式（IIFE 也行），结果会 JSON 打印出来；有 await 会自动 await
// 环境变量: CDP_INIT=<js>  页面加载后、求值前先执行一次（例如写 localStorage）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, out, evalFile, wArg, hArg] = process.argv.slice(2);
const W = Number(wArg) || 430;
const H = Number(hArg) || 900;
const PORT = 9300 + Math.floor(Math.random() * 300);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    '--force-device-scale-factor=2',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

let id = 0;
const pending = new Map();
function send(ws, method, params = {}) {
  id += 1;
  const msgId = id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    setTimeout(() => {
      if (pending.has(msgId)) {
        pending.delete(msgId);
        reject(new Error(`timeout: ${method}`));
      }
    }, Number(process.env.CDP_TIMEOUT_MS || 30000));
  });
}

try {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 2,
    mobile: true,
  });

  const errors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description || 'exception');
    }
  });

  await send(ws, 'Page.navigate', { url });
  await sleep(1200);

  const evaluate = async (expression) => {
    const res = await send(ws, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'eval failed');
    }
    return res.result.value;
  };

  const init = process.env.CDP_INIT;
  if (init) await evaluate(init);

  if (evalFile) {
    const expr = fs.readFileSync(evalFile, 'utf8');
    const value = await evaluate(expr);
    console.log(JSON.stringify(value, null, 2));
  }

  if (out) {
    await sleep(300);
    const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`saved ${out}`);
  }
  if (errors.length) console.log('CONSOLE ERRORS:', JSON.stringify(errors));
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* profile cleanup is best effort */
  }
}
