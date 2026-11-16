import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const evidence=path.resolve(process.env.EVIDENCE_DIR||path.join(root,'docs'));
await mkdir(evidence,{recursive:true});
const results=[],errors=[];
let server,browser;
async function check(name,operation){await operation();results.push(name);console.log('PASS '+name);}
async function ready(p){await p.locator('#app-content').waitFor({state:'visible'});await p.locator('[data-time]').first().waitFor();}
async function noOverflow(p){assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');}
try{
  let url=process.env.DEMO_URL;
  if(!url){
    const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'};
    server=createServer(async(req,res)=>{try{
      const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);
      if(!pathname.startsWith('/studio-booking-demo/'))throw Error();
      const relative=pathname.slice('/studio-booking-demo/'.length)||'index.html';
      const file=path.resolve(root,'public',relative);
      if(!file.startsWith(path.join(root,'public')+path.sep))throw Error();
      res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));
    }catch{res.statusCode=404;res.end('not found');}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    url=`http://127.0.0.1:${server.address().port}/studio-booking-demo/?demo=1`;
  }
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow'});
  const p=await context.newPage();
  p.on('pageerror',e=>errors.push(e.message));
  const apiCalls=[];p.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))apiCalls.push(r.url());});
  await p.goto(url);await ready(p);
  await check('Desktop, repository subpath and clear browser-only notice',async()=>{
    await noOverflow(p);assert.match(await p.locator('#storage-explanation').innerText(),/не синхронизируются/);
    await p.screenshot({path:path.join(evidence,'preview-desktop.png'),fullPage:true});
  });
  await check('Service/staff compatibility and stale slot selection cleared',async()=>{
    await p.locator('[data-time="10:00"]').click();await p.locator('[data-service="color"]').click();
    await p.locator('[data-time="10:00"]').waitFor();assert.equal(await p.locator('[data-staff="maria"]').count(),0);
    assert.match(await p.locator('#summary-date').innerText(),/Выберите/);
    await p.locator('[data-service="cut"]').click();await p.locator('[data-time="10:00"]').waitFor();
  });
  await check('Create → reload → move → cancel, with text-safe names',async()=>{
    await p.locator('[data-time="10:00"]').click();await p.locator('#client-name').fill('<img src=x onerror=alert(1)>');
    await p.locator('#submit-booking').click();await p.locator('#action-dialog[open]').waitFor();
    await p.locator('#dialog-submit').click();await p.locator('#mine-list .record').waitFor();
    assert.equal(await p.locator('#mine-list img').count(),0);assert.match(await p.locator('#mine-list').innerText(),/<img/);
    await p.reload();await p.locator('#mine-list .record').waitFor();
    await p.locator('#mine-list [data-action="move"]').click();await p.locator('[data-move-time="12:00"]').waitFor();
    await p.locator('[data-move-time="12:00"]').click();await p.locator('#dialog-submit').click();
    await p.locator('#action-dialog').waitFor({state:'hidden'});
    await p.locator('#mine-list .record').filter({hasText:'12:00'}).waitFor({state:'visible'});
    assert.match(await p.locator('#mine-list').innerText(),/12:00/);
    await p.locator('#mine-list [data-action="cancel"]').click();await p.locator('#dialog-submit').click();
    await p.locator('#action-dialog').waitFor({state:'hidden'});
    await p.locator('#mine-list .record-status').filter({hasText:'Отменено'}).waitFor({state:'visible'});
    assert.match(await p.locator('#mine-list').innerText(),/Отменено/);
  });
  await check('Admin filters, cancel, reset confirmation and keyboard Escape',async()=>{
    await p.locator('[data-view="admin"]').click();await p.locator('#admin-list .record').waitFor();
    await p.locator('#admin-status').selectOption('confirmed');assert.equal(await p.locator('#admin-list .record').count(),0);
    await p.locator('#clear-filters').click();assert.equal(await p.locator('#admin-list .record').count(),1);
    await p.locator('#reset-demo').click();await p.keyboard.press('Escape');assert.equal(await p.locator('dialog[open]').count(),0);
    await p.locator('#reset-demo').click();await p.locator('#dialog-submit').click();await p.locator('#action-dialog').waitFor({state:'hidden'});
    await p.locator('#admin-list .empty-state').waitFor({state:'visible'});
    assert.equal(await p.locator('#admin-list .record').count(),0);
  });
  // Direct adapter tests still use native IndexedDB, independent pages, and real browser transactions.
  const second=await context.newPage();await second.goto(url);await ready(second);
  for(const page of [p,second])await page.evaluate(async()=>{window.qaAdapter=await(await import('./data.js')).createAdapter();});
  const tomorrow=await p.evaluate(async()=>{const m=await import('./data.js');return m.addDays(m.moscowDate(),1);});
  await check('24 competing creates in two tabs: exactly one overlapping interval',async()=>{
    const outcomes=await Promise.all(Array.from({length:24},(_,n)=>(n%2?p:second).evaluate(async({date,n})=>{
      try{return {ok:true,booking:await qaAdapter.create({serviceId:n%2?'cut':'color',staffId:'anna',date,time:n%2?'10:00':'10:30',name:'Демо Конкуренция'})};}catch(e){return {ok:false,code:e.code};}
    },{date:tomorrow,n})));
    assert.equal(outcomes.filter(r=>r.ok).length,1);assert.equal(outcomes.filter(r=>r.code==='conflict').length,23);
  });
  await check('Adjacent/different staff allowed; concurrent moves preserve losing booking',async()=>{
    await p.evaluate(async()=>{window.qaAdapter=await(await import('./data.js')).createAdapter();await qaAdapter.reset();});
    const input={serviceId:'cut',staffId:'anna',date:tomorrow,name:'Демо Перенос'};
    const a=await p.evaluate(d=>qaAdapter.create(d),{...input,time:'10:00'});
    const b=await p.evaluate(d=>qaAdapter.create(d),{...input,time:'14:00'});
    await p.evaluate(d=>qaAdapter.create(d),{...input,time:'11:00'});
    await p.evaluate(d=>qaAdapter.create(d),{...input,staffId:'maria',time:'10:00'});
    const moved=await Promise.all([p.evaluate(async({id,date})=>{try{return {ok:true,b:await qaAdapter.move(id,{date,time:'12:00',staffId:'anna'})};}catch(e){return {ok:false,code:e.code};}},{id:a.id,date:tomorrow}),second.evaluate(async({id,date})=>{try{return {ok:true,b:await qaAdapter.move(id,{date,time:'12:30',staffId:'anna'})};}catch(e){return {ok:false,code:e.code};}},{id:b.id,date:tomorrow})]);
    assert.equal(moved.filter(x=>x.ok).length,1);assert.equal(moved.filter(x=>x.code==='conflict').length,1);
    const all=await p.evaluate(()=>qaAdapter.all());const loser=moved[0].ok?b:a;assert.equal(all.find(x=>x.id===loser.id).time,loser.time);
    await p.evaluate(id=>qaAdapter.cancel(id),a.id);await p.evaluate(id=>qaAdapter.cancel(id),a.id);
    const rejected=await p.evaluate(async({id,date})=>{try{await qaAdapter.move(id,{date,time:'18:00'});return false;}catch{return true;}},{id:a.id,date:tomorrow});assert(rejected);
  });
  await check('Validation and failed move leave original data intact',async()=>{
    await p.evaluate(async()=>{window.qaAdapter=await(await import('./data.js')).createAdapter();await qaAdapter.reset();});
    const invalid=[{serviceId:'color',staffId:'maria',time:'10:00'},{serviceId:'cut',staffId:'anna',time:'10:15'},{serviceId:'cut',staffId:'anna',time:'19:30'},{serviceId:'cut',staffId:'anna',date:'2026-02-30',time:'10:00'}];
    for(const value of invalid)assert(await p.evaluate(async d=>{try{await qaAdapter.create(d);return false;}catch{return true;}},{date:tomorrow,name:'Демо',...value}));
  });
  for(const width of [390,375,820])await check(`Responsive ${width}px and reduced motion`,async()=>{
    await p.setViewportSize({width,height:900});await p.emulateMedia({reducedMotion:'reduce'});await p.goto(url);await ready(p);await noOverflow(p);
    await p.screenshot({path:path.join(evidence,`preview-${width}.png`),fullPage:true});
    await p.locator('[data-view="admin"]').click();await noOverflow(p);
    await p.locator('[data-view="booking"]').click();await p.locator('[data-time="10:00"]').click();await p.locator('#client-name').fill('Демо Мобильный');
    await p.locator('#submit-booking').click();await p.locator('#action-dialog[open]').waitFor();await noOverflow(p);await p.keyboard.press('Escape');
    await p.evaluate(async()=>{window.qaAdapter=await(await import('./data.js')).createAdapter();await qaAdapter.reset();});
  });
  await check('No static API traffic or uncaught errors',async()=>{assert.deepEqual(apiCalls,[]);assert.deepEqual(errors,[]);});
  if(!process.env.DEMO_URL){
    await check('Unavailable storage and missing local backend fail explicitly',async()=>{
      const blocked=await browser.newContext();await blocked.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){return undefined;}}));
      const q=await blocked.newPage();await q.goto(url);await q.locator('#fatal').waitFor({state:'visible'});assert.match(await q.locator('#fatal').innerText(),/хранилище/);await blocked.close();
      const q2=await context.newPage();await q2.goto(url.replace('?demo=1',''));await q2.locator('#fatal').waitFor({state:'visible'});assert.match(await q2.locator('#fatal').innerText(),/не запущен/);await q2.close();
    });
  }
  await context.close();
  await writeFile(path.join(evidence,process.env.DEMO_URL?'public-browser-verification.json':'browser-verification.json'),JSON.stringify({date:new Date().toISOString(),mode:'static',url,checks:results,uncaughtErrors:errors},null,2)+'\n');
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
