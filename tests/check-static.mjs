import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'public');
const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
const catalog=JSON.parse(fs.readFileSync(path.join(dir,'catalog.json'),'utf8'));
const resources=[...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(m=>m[1]);
for(const url of resources){
  assert(!url.startsWith('/'),`Root URL breaks repository base path: ${url}`);
  assert(!/^(?:https?:)?\/\//.test(url),`External required resource: ${url}`);
  if(url.startsWith('#')||url.startsWith('data:'))continue;
  assert(fs.existsSync(path.join(dir,url.split(/[?#]/)[0])),`Missing resource: ${url}`);
}
assert.match(html,/<html[^>]+lang=["']ru["']/,'Russian language metadata');
assert.match(html,/name=["']viewport["']/,'Responsive viewport');
assert.match(html,/демо|демонстрац/iu,'Explicit demo label');
assert.match(html,/вымышлен/iu,'Fictitious name instruction');
assert.equal(catalog.timezone,'Europe/Moscow');
assert(catalog.services.length>=3 && catalog.staff.length>=3);
const services=new Map(catalog.services.map(s=>[s.id,s]));
assert.equal(services.size,catalog.services.length,'Unique service IDs');
assert.equal(new Set(catalog.staff.map(s=>s.id)).size,catalog.staff.length,'Unique staff IDs');
for(const s of catalog.services){assert(s.name && s.description);assert(Number.isInteger(s.duration)&&s.duration>0&&s.duration%30===0);assert(Number.isFinite(s.price)&&s.price>=0);}
for(const s of catalog.staff){assert(s.name && s.role && s.services.length);for(const id of s.services)assert(services.has(id),`Unknown service ${id}`);}
for(const filename of fs.readdirSync(dir)){
  assert(!/\.(?:sqlite|db|log|env)(?:$|[.-])/i.test(filename),`Runtime file in public: ${filename}`);
  if(!/\.(?:js|html|css|json|svg)$/.test(filename))continue;
  const content=fs.readFileSync(path.join(dir,filename),'utf8');
  assert(!/(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----)/.test(content),`Potential secret in ${filename}`);
}
console.log(`Static checks passed: ${resources.length} local resources; ${catalog.services.length} services; ${catalog.staff.length} specialists.`);
