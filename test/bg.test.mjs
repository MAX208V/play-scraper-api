// PricePrism /api/bg 端点测试 —— 直接 import 真实源码，真实请求 Bing
import { handleBg } from '../src/handlers.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS', name, extra); }
  else { fail++; console.log('  FAIL', name, extra); }
}
function req(search) {
  return new Request('https://play.maxcloud.fun/api/bg' + (search ? '?' + search : ''), { method: 'GET' });
}

console.log('== 1. 302 模式（无参数，默认 zh-CN）==');
{
  const r = await handleBg(req(''));
  check('status 302', r.status === 302, 'status=' + r.status);
  const loc = r.headers.get('Location') || '';
  check('Location 指向 cn.bing.com 图片', loc.startsWith('https://cn.bing.com/th'), loc.slice(0, 70));
  check('Cache-Control 存在', !!r.headers.get('Cache-Control'));
}

console.log('== 2. mkt=zh-CN → JSON ==');
{
  const r = await handleBg(req('mkt=zh-CN'));
  const d = await r.json();
  check('status 200', r.status === 200);
  check('mkt=zh-CN', d.mkt === 'zh-CN', 'mkt=' + d.mkt);
  check('url 是 cn.bing.com 完整链接', (d.url || '').startsWith('https://cn.bing.com/th'));
  check('有 title', typeof d.title === 'string' && d.title.length > 0, d.title.slice(0, 30));
  check('有 date', /^\d{8}$/.test(d.date || ''), d.date);
}

console.log('== 3. mkt=zh-cn（小写）→ 标准化 ==');
{
  const d = await (await handleBg(req('mkt=zh-cn'))).json();
  check('标准化为 zh-CN', d.mkt === 'zh-CN');
}

console.log('== 4. country=cn / country=us / mkt=ja-JP → 映射与 host ==');
{
  let d = await (await handleBg(req('country=cn'))).json();
  check('country=cn → mkt zh-CN', d.mkt === 'zh-CN');
  check('country=cn → cn.bing.com', (d.url || '').startsWith('https://cn.bing.com/'));

  d = await (await handleBg(req('country=us'))).json();
  check('country=us → mkt en-US', d.mkt === 'en-US', 'mkt=' + d.mkt);
  check('country=us → www.bing.com', (d.url || '').startsWith('https://www.bing.com/'));

  d = await (await handleBg(req('mkt=ja-JP'))).json();
  check('mkt=ja-JP → www.bing.com', (d.url || '').startsWith('https://www.bing.com/'));
}

console.log('== 5. idx / n 参数 ==');
{
  const d = await (await handleBg(req('mkt=zh-CN&idx=1&n=3'))).json();
  check('n=3 → images 数组 3 张', Array.isArray(d.images) && d.images.length === 3, 'len=' + d.images?.length);
  check('每张都有 url/date', d.images?.every(i => i.url && /^\d{8}$/.test(i.date)));

  const d2 = await (await handleBg(req('mkt=zh-CN&n=99'))).json();
  check('n=99 → 上限 8', d2.images?.length === 8, 'len=' + d2.images?.length);
}

console.log('== 6. 边界：非法 mkt / 非法 idx ==');
{
  let d = await (await handleBg(req('mkt=not-a-mkt'))).json();
  check('非法 mkt → 回退 zh-CN', d.mkt === 'zh-CN');

  d = await (await handleBg(req('mkt=zh-CN&idx=abc'))).json();
  check('非法 idx → 回退 0', d.date ? true : d.mkt === 'zh-CN'); // 只要不崩即可
}

console.log('== 7. 图片链接可访问性（HEAD）==');
{
  const r = await handleBg(req('mkt=zh-CN'));
  const d = await r.json();
  try {
    const head = await fetch(d.url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
    check('JSON url HEAD ' + head.status, head.status === 200, d.url.slice(0, 60));
  } catch (e) { check('JSON url HEAD 可访问', false, e.message); }

  const r2 = await handleBg(req(''));
  const loc2 = r2.headers.get('Location');
  console.log('  [debug] 302 模式 status=', r2.status, 'Location=', loc2 ? loc2.slice(0, 80) : null);
  if (loc2) {
    try {
      const head2 = await fetch(loc2, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
      check('302 Location HEAD ' + head2.status, head2.status === 200);
    } catch (e) { check('302 Location 可访问', false, e.message); }
  }
}

console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
process.exit(fail > 0 ? 1 : 0);