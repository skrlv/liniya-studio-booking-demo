// Both adapters implement the same booking contract. No API call is made by the static demo.
export const DB_NAME = 'liniya-studio-demo-v1';
export const moscowDate = () => {
  const p = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return ['year','month','day'].map(k=>p.find(x=>x.type===k).value).join('-');
};
export const addDays = (date,n) => { const d=new Date(date+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); };
const minutes = time => Number(time.slice(0,2))*60+Number(time.slice(3));
const clock = n => `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
const fail = (message,code='validation') => { const e=new Error(message); e.code=code; throw e; };
const copy = value => JSON.parse(JSON.stringify(value));
function validate(catalog,data) {
  const service=catalog.services.find(x=>x.id===data.serviceId), staff=catalog.staff.find(x=>x.id===data.staffId);
  if(!service || !staff || !staff.services.includes(service.id)) fail('Выберите услугу и подходящего специалиста.');
  const today=moscowDate();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(data.date||'') || data.date<addDays(today,1) || data.date>addDays(today,30) || Number.isNaN(Date.parse(data.date+'T12:00:00Z')) || new Date(data.date+'T12:00:00Z').toISOString().slice(0,10)!==data.date) fail('Выберите дату в ближайшие 30 дней, начиная с завтрашнего дня.');
  if(!/^\d{2}:\d{2}$/.test(data.time||'') || minutes(data.time)<600 || minutes(data.time)+service.duration>1200 || minutes(data.time)%30 || Number(data.time.slice(3))>59) fail('Выберите доступное время в расписании.');
  if(typeof data.name!=='string' || data.name.trim().length<2 || data.name.trim().length>60 || /[\x00-\x1f]/.test(data.name)) fail('Введите вымышленное имя: от 2 до 60 символов.');
  return {...data,name:data.name.trim(),duration:service.duration,price:service.price};
}
function checkConflict(records,data,exclude) {
  if(records.some(b=>b.id!==exclude && b.status==='confirmed' && b.staffId===data.staffId && b.date===data.date && minutes(b.time)<minutes(data.time)+data.duration && minutes(b.time)+b.duration>minutes(data.time))) fail('Это время уже занято. Выберите другое — расписание обновлено.','conflict');
}
function openDB() {
  return new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB) return reject(new Error('Браузер не разрешает локальное хранилище. Откройте демо в обычном окне браузера.'));
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('bookings',{keyPath:'id'});
    request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
    request.onerror=()=>reject(new Error('Не удалось открыть локальные данные. Проверьте разрешения браузера.'));
    request.onblocked=()=>reject(new Error('Закройте другие вкладки демо и повторите попытку.'));
  });
}
export class DemoAdapter {
  constructor(catalog,db) { this.catalog={...catalog,mode:'demo',today:moscowDate(),timezone:'Europe/Moscow'};this.db=db;this.mode='demo';try{this.channel=new BroadcastChannel(DB_NAME);this.channel.onmessage=()=>window.dispatchEvent(new Event('bookings-changed'));}catch{} }
  all() { return new Promise((resolve,reject)=>{const tx=this.db.transaction('bookings','readonly');const r=tx.objectStore('bookings').getAll();r.onsuccess=()=>resolve(copy(r.result));r.onerror=()=>reject(new Error('Не удалось прочитать записи. Обновите страницу.'));}); }
  async slots(serviceId,staffId,date,exclude) {
    const service=this.catalog.services.find(s=>s.id===serviceId),staff=this.catalog.staff.find(s=>s.id===staffId);
    if(!service || !staff || !staff.services.includes(serviceId) || date<addDays(moscowDate(),1) || date>addDays(moscowDate(),30)) return [];
    const records=await this.all(),slots=[];
    for(let n=600;n+service.duration<=1200;n+=30){try{checkConflict(records,{staffId,date,time:clock(n),duration:service.duration},exclude);slots.push(clock(n));}catch{}}
    return slots;
  }
  mutate(operation) { return new Promise((resolve,reject)=>{let result,error;const tx=this.db.transaction('bookings','readwrite');const store=tx.objectStore('bookings');const r=store.getAll();r.onsuccess=()=>{try{result=operation(r.result,store);}catch(e){error=e;tx.abort();}};tx.oncomplete=()=>{try{this.channel?.postMessage('updated');}catch{}resolve(copy(result));};tx.onabort=()=>reject(error || new Error('Запись не сохранена: браузер отказал в доступе к данным.'));tx.onerror=()=>{error ||= new Error('Запись не сохранена: локальное хранилище недоступно или заполнено.');};}); }
  create(data) { return this.mutate((records,store)=>{const clean=validate(this.catalog,data);if(records.length>=200)fail('В демо достигнут лимит 200 записей. Очистите демо-данные в кабинете администратора.');checkConflict(records,clean);const b={...clean,id:crypto.randomUUID(),status:'confirmed',createdAt:new Date().toISOString()};store.add(b);return b;}); }
  move(id,data) { return this.mutate((records,store)=>{const old=records.find(b=>b.id===id);if(!old || old.status!=='confirmed')fail('Эта запись уже отменена или не найдена. Обновите список.');const clean=validate(this.catalog,{...old,...data});checkConflict(records,clean,id);store.put(clean);return clean;}); }
  cancel(id) { return this.mutate((records,store)=>{const b=records.find(b=>b.id===id);if(!b)fail('Запись не найдена.');b.status='cancelled';store.put(b);return b;}); }
  async mine(){return this.all();} async admin(){return this.all();}
  reset(){return this.mutate((records,store)=>{store.clear();return true;});}
}
export class ServerAdapter {
  constructor(catalog){this.catalog=catalog;this.mode='server';this.adminToken='';this.memoryRefs=[];this.pending=new Map();}
  refs(){let saved=[];try{const value=JSON.parse(localStorage.getItem('liniya-server-refs-v1')||'[]');if(Array.isArray(value))saved=value.filter(r=>typeof r.id==='string'&&typeof r.token==='string');}catch{}return [...new Map([...saved,...this.memoryRefs].map(r=>[r.id,r])).values()];}
  async request(path,options={}){let r;try{r=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});}catch{fail('Локальный сервер недоступен. Запустите его и повторите попытку.','network');}let value;try{value=await r.json();}catch{fail('Сервер вернул неожиданный ответ. Проверьте его запуск.','network');}if(!r.ok)fail(value.error||'Не удалось выполнить действие.',value.code||String(r.status));return value;}
  headers(id,admin=false){if(admin)return {Authorization:`Bearer ${this.adminToken}`};const ref=this.refs().find(x=>x.id===id);return {'X-Booking-Token':ref?.token||''};}
  async mutation(path,options){
    const fingerprint=JSON.stringify([options.method,path,options.body||'',options.headers?.Authorization||'owner']);
    let key=this.pending.get(fingerprint);
    if(!key){key=crypto.randomUUID();this.pending.set(fingerprint,key);}
    const request={...options,headers:{...options.headers,'Idempotency-Key':key}};
    try{let value;try{value=await this.request(path,request);}catch(e){if(e.code!=='network')throw e;value=await this.request(path,request);}this.pending.delete(fingerprint);return value;}
    catch(e){if(e.code!=='network')this.pending.delete(fingerprint);else e.message+=' Повторите то же действие на этой странице: повторный запрос не создаст вторую запись.';throw e;}
  }
  async slots(service,staff,date,exclude,admin=false){const q=new URLSearchParams({service,staff,date});if(exclude)q.set('exclude',exclude);return (await this.request('/api/slots?'+q,{headers:exclude?this.headers(exclude,admin):{}})).slots;}
  async create(data){try{localStorage.setItem('liniya-storage-check','1');localStorage.removeItem('liniya-storage-check');}catch{fail('Разрешите сохранение данных в браузере: без него нельзя сохранить ключ управления записью.');}const value=await this.mutation('/api/bookings',{method:'POST',body:JSON.stringify(data)});const refs=[...this.refs(),{id:value.booking.id,token:value.token}];this.memoryRefs=refs;try{localStorage.setItem('liniya-server-refs-v1',JSON.stringify(refs));}catch{value.booking.storageWarning='Запись создана, но ключ доступен только до закрытия этой страницы. При необходимости обратитесь к администратору локального демо.';}return value.booking;}
  async mine(){const records=[];for(const ref of this.refs()){try{records.push((await this.request('/api/bookings/'+encodeURIComponent(ref.id),{headers:{'X-Booking-Token':ref.token}})).booking);}catch(e){if(!['401','403','404','not_found','unauthorized','forbidden'].includes(e.code))throw e;}}return records;}
  async admin(){return (await this.request('/api/admin/bookings',{headers:{Authorization:`Bearer ${this.adminToken}`}})).bookings;}
  async move(id,data,admin=false){return (await this.mutation('/api/bookings/'+encodeURIComponent(id),{method:'PATCH',headers:this.headers(id,admin),body:JSON.stringify(data)})).booking;}
  async cancel(id,admin=false){return (await this.mutation('/api/bookings/'+encodeURIComponent(id),{method:'DELETE',headers:this.headers(id,admin)})).booking;}
}
export async function createAdapter(){
  const loopback=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  const server=loopback && new URLSearchParams(location.search).get('demo')!=='1';
  let response;try{response=await fetch(server?'/api/catalog':'./catalog.json',{cache:'no-store'});}catch{fail(server?'Не удалось подключиться к локальному серверу. Запустите server/app.py и обновите страницу.':'Не удалось загрузить каталог. Проверьте соединение и повторите попытку.');}
  if(!response.ok)fail(server?'Сервер записи не запущен. Для статического просмотра добавьте ?demo=1 к адресу.':'Каталог временно недоступен. Повторите попытку.');
  let catalog;try{catalog=await response.json();}catch{fail('Каталог имеет неверный формат. Для статического просмотра добавьте ?demo=1 к адресу.');}
  if(!Array.isArray(catalog.services)||!Array.isArray(catalog.staff))fail('Каталог имеет неверный формат.');
  return server?new ServerAdapter(catalog):new DemoAdapter(catalog,await openDB());
}
