// PricePrism /api/bg 端点测试 —— 直接 import 真实源码，真实请求 Bing
import { handleBg } from '../src/handlers.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS', name, extra); }
  else { fail++; console.log('  FAIL', name, extra); }
}
function req(search, ua = '') {
  return new Request('https://play.maxcloud.fun/api/bg' + (search ? '?' + search : ''),
    { method: 'GET', headers: ua ? { 'User-Agent': ua } : {} });
}
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

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
  check('有 res 字段', typeof d.res === 'string' && d.res.length > 0, 'res=' + d.res);
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
  check('每张都有 url/date/res', d.images?.every(i => i.url && /^\d{8}$/.test(i.date) && i.res));

  const d2 = await (await handleBg(req('mkt=zh-CN&n=99'))).json();
  check('n=99 → 上限 8', d2.images?.length === 8, 'len=' + d2.images?.length);
}

console.log('== 6. 边界：非法 mkt / 非法 idx ==');
{
  let d = await (await handleBg(req('mkt=not-a-mkt'))).json();
  check('非法 mkt → 回退 zh-CN', d.mkt === 'zh-CN');

  d = await (await handleBg(req('mkt=zh-CN&idx=abc'))).json();
  check('非法 idx → 回退 0 不报错', d.mkt === 'zh-CN');
}

console.log('== 7. 分辨率：UA 判断 ==');
{
  let r = await handleBg(req('', UA_ANDROID));
  check('Android Mobile → 302 竖屏 1080x1920', (r.headers.get('Location') || '').includes('_1080x1920'), r.headers.get('Location')?.slice(30, 80));

  r = await handleBg(req('', UA_IPHONE));
  check('iPhone → 302 竖屏 1080x1920', (r.headers.get('Location') || '').includes('_1080x1920'));

  r = await handleBg(req('', UA_WINDOWS));
  check('Windows → 302 横屏 1920x1080', (r.headers.get('Location') || '').includes('_1920x1080'), r.headers.get('Location')?.slice(30, 80));

  r = await handleBg(req(''));
  check('无 UA → 横屏 1920x1080', (r.headers.get('Location') || '').includes('_1920x1080'));

  let d = await (await handleBg(req('mkt=zh-CN', UA_IPAD))).json();
  check('iPad → 横屏 1920x1080', d.res === '1920x1080', 'res=' + d.res);
}

console.log('== 8. 分辨率：w/h 实际尺寸 ==');
{
  let d = await (await handleBg(req('w=3840&h=2160'))).json();
  check('4K 横屏 → UHD', d.res === 'UHD' && (d.url || '').includes('_UHD'), 'res=' + d.res);

  d = await (await handleBg(req('w=1080&h=1920'))).json();
  check('竖屏目标 → 1080x1920', d.res === '1080x1920' && (d.url || '').includes('_1080x1920'));

  d = await (await handleBg(req('w=2560&h=1440'))).json();
  check('2K 无候选 → 面积差最小 1920x1080', d.res === '1920x1080', 'res=' + d.res);

  d = await (await handleBg(req('w=1170&h=2532'))).json();
  check('iPhone 物理尺寸 → 竖屏 1080x1920', d.res === '1080x1920');

  d = await (await handleBg(req('w=1920&h=1080'))).json();
  check('FHD 横屏 → 1920x1080', d.res === '1920x1080');
}

console.log('== 9. 分辨率：res 预设 ==');
{
  let d = await (await handleBg(req('res=uhd'))).json();
  check('res=uhd → UHD', d.res === 'UHD');

  d = await (await handleBg(req('res=720p'))).json();
  check('res=720p → 1280x720', d.res === '1280x720' && (d.url || '').includes('_1280x720'));

  d = await (await handleBg(req('res=phone'))).json();
  check('res=phone → 1080x1920', d.res === '1080x1920');

  d = await (await handleBg(req('res=bogus'))).json();
  check('res 非法 → 回退 UA(无UA横屏 1920x1080)', d.res === '1920x1080');

  d = await (await handleBg(req('res=bogus', UA_ANDROID))).json();
  check('res 非法 + 安卓UA → 回退 1080x1920', d.res === '1080x1920', 'res=' + d.res);
}

console.log('== 10. 替换后图片链接可访问性（HEAD）==');
{
  for (const [name, search, ua] of [
    ['竖屏 1080x1920', 'mkt=zh-CN&w=1080&h=1920', ''],
    ['UHD 4K', 'mkt=zh-CN&res=uhd', ''],
    ['Android UA 302', '', UA_ANDROID],
  ]) {
    const r = await handleBg(req(search, ua));
    const target = r.status === 302 ? r.headers.get('Location') : (await r.json()).url;
    try {
      const head = await fetch(target, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
      check(`${name} HEAD ${head.status}`, head.status === 200, target.slice(0, 70));
    } catch (e) { check(`${name} 可访问`, false, e.message); }
  }
}

console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
process.exit(fail > 0 ? 1 : 0);