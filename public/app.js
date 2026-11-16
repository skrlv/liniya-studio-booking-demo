import {createAdapter,addDays} from './data.js';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('ru-RU').format(n)+' ₽';
const dateFormat=(date,options={day:'numeric',month:'long'})=>new Intl.DateTimeFormat('ru-RU',{...options,timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));
const duration=n=>n>=60?`${Math.floor(n/60)} ч${n%60?' '+n%60+' мин':''}`:`${n} мин`;
let adapter,catalog,serviceId,staffId,date,time='',busy=false,view='booking',records=[],slotRequest=0,dialogState=null,dialogRequest=0,listRequest=0;
const service=id=>catalog.services.find(s=>s.id===(id||serviceId));
const staff=id=>catalog.staff.find(s=>s.id===(id||staffId));
const eligible=id=>catalog.staff.filter(s=>s.services.includes(id));
const minDate=()=>addDays(catalog.today,1),maxDate=()=>addDays(catalog.today,30);
function showNotice(message,error=false){const e=$('#notice');e.textContent=message;e.classList.toggle('error',error);e.setAttribute('role',error?'alert':'status');e.hidden=false;}
function clearNotice(){$('#notice').hidden=true;}
function setBusy(value){busy=value;document.querySelectorAll('#booking-form input,#booking-form button,.summary-submit').forEach(x=>x.disabled=value);$('#submit-booking').innerHTML=value?'Сохраняем запись…':'Подтвердить запись <span>↗</span>';}
function renderServices(){
  const symbols={cut:'✂',color:'◒',care:'✳'};
  $('#services').innerHTML=catalog.services.map(s=>`<button type="button" class="service-card ${s.id===serviceId?'selected':''}" data-service="${esc(s.id)}" aria-pressed="${s.id===serviceId}" id="service-${esc(s.id)}"><span class="radio-mark" aria-hidden="true"></span><span class="service-symbol" aria-hidden="true">${symbols[s.id]||'◌'}</span><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p><div class="service-bottom"><span class="service-price">${money(s.price)}</span><span class="service-duration">${duration(s.duration)}</span></div></button>`).join('');
}
function renderStaff(){
  $('#staff').innerHTML=eligible(serviceId).map(s=>`<button type="button" class="staff-card ${s.id===staffId?'selected':''}" data-staff="${esc(s.id)}" aria-pressed="${s.id===staffId}" id="staff-${esc(s.id)}"><span class="avatar" aria-hidden="true">${esc(s.initials||s.name[0])}</span><span><strong>${esc(s.name)}</strong><small>${esc(s.role)}</small></span>${s.id===staffId?'<span class="staff-check" aria-hidden="true">✓</span>':''}</button>`).join('');
}
function renderDates(){
  const first=date<addDays(minDate(),7)?minDate():date;
  $('#dates').innerHTML=Array.from({length:7},(_,n)=>addDays(first,n)).filter(d=>d<=maxDate()).map((d,n)=>`<button type="button" class="date-card ${d===date?'selected':''}" data-date="${d}" aria-pressed="${d===date}" aria-label="${esc(dateFormat(d,{day:'numeric',month:'long',weekday:'long'}))}"><span>${esc(dateFormat(d,{weekday:'short'}))}</span><strong>${Number(d.slice(-2))}</strong><small>${d===minDate()?'завтра':dateFormat(d,{month:'short'}).replace('.','')}</small></button>`).join('');
  $('#month-label').textContent=dateFormat(date,{month:'long',year:'numeric'});
  $('#booking-date').value=date;
}
function renderSummary(){
  $('#summary-service').textContent=service().name;
  $('#summary-staff').textContent=staff().name;
  $('#summary-date').textContent=time?`${dateFormat(date)}, ${time}`:'Выберите время';
  $('#summary-price').textContent=money(service().price);
  $('#summary-duration').textContent=duration(service().duration);
}
async function renderSlots({notify=false}={}){
  const request=++slotRequest;
  $('#slots').innerHTML='';$('#slots-message').textContent='Проверяем свободное время…';$('#slots-count').textContent='';
  try{
    const slots=await adapter.slots(serviceId,staffId,date);
    if(request!==slotRequest)return;
    if(time&&!slots.includes(time)){time='';if(notify)showNotice('Выбранное время уже занято. Расписание обновлено — выберите другой момент.',true);}
    $('#slots').innerHTML=slots.map(t=>`<button type="button" class="slot ${t===time?'selected':''}" data-time="${esc(t)}" aria-pressed="${t===time}">${esc(t)}</button>`).join('');
    $('#slots-count').textContent=slots.length?`· ${slots.length} ${slots.length===1?'вариант':'вариантов'}`:'';
    $('#slots-message').textContent=slots.length?'Время учитывает длительность выбранной услуги.':'В этот день свободного времени нет. Выберите другую дату или специалиста.';
  }catch(e){if(request!==slotRequest)return;time='';$('#slots-message').textContent=e.message;showNotice(e.message,true);}
  renderSummary();
}
function renderBooking(){renderServices();renderStaff();renderDates();renderSummary();return renderSlots();}
async function refreshCount(){try{const mine=await adapter.mine();const n=mine.filter(b=>b.status==='confirmed').length;$('#my-count').textContent=n;$('#my-count').hidden=!n;}catch{}}
function recordHTML(b,admin){
  const s=service(b.serviceId),st=staff(b.staffId),active=b.status==='confirmed';
  return `<article class="record ${active?'':'cancelled'}" data-record="${esc(b.id)}"><div class="record-date"><strong>${Number(b.date.slice(-2))}</strong><span>${esc(dateFormat(b.date,{month:'short'}))}</span><span>${esc(b.time)}</span></div><div class="record-body"><span class="record-status ${active?'':'cancelled'}">${active?'Подтверждено':'Отменено'}</span><h3>${esc(s?.name||b.serviceId)}</h3><p>${esc(st?.name||b.staffId)} · ${duration(b.duration)} · ${money(b.price)}</p><p>${esc(b.name)}</p><div class="record-meta">${esc(dateFormat(b.date,{day:'numeric',month:'long',year:'numeric'}))} · № ${esc(b.id.slice(0,8))}</div></div>${active?`<div class="record-actions"><button type="button" data-action="move" data-id="${esc(b.id)}" data-admin="${admin}">Перенести ↗</button><button type="button" class="cancel-action" data-action="cancel" data-id="${esc(b.id)}" data-admin="${admin}">Отменить запись</button></div>`:''}</article>`;
}
function emptyHTML(admin=false){return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">${admin?'⌘':'↗'}</div><h2>${admin?'Пока нет записей':'Всё начинается с паузы'}</h2><p>${admin?'Записей с такими параметрами пока нет. Измените фильтры или создайте первую демонстрационную запись.':'Выберите услугу и удобное время. Подтверждённые и отменённые записи появятся здесь.'}</p><button class="button" type="button" data-go-booking>Выбрать своё время <span>↗</span></button></div>`;}
async function loadMine(){
  const request=++listRequest;
  $('#mine-list').innerHTML='<p class="small-muted">Загружаем записи…</p>';
  try{const value=await adapter.mine();if(request!==listRequest||view!=='mine')return;records=value;renderMine();}catch(e){if(request!==listRequest||view!=='mine')return;$('#mine-list').innerHTML='';showNotice(e.message,true);}
}
function renderMine(){
  const sorted=[...records].sort((a,b)=>(a.status==='cancelled')-(b.status==='cancelled')||(a.date+a.time).localeCompare(b.date+b.time));
  $('#mine-list').innerHTML=sorted.length?sorted.map(b=>recordHTML(b,false)).join(''):emptyHTML();
}
function renderAdmin(){
  const confirmed=records.filter(b=>b.status==='confirmed'),cancelled=records.length-confirmed.length;
  $('#admin-stats').innerHTML=`<div class="stat"><span>Подтверждено</span><strong>${confirmed.length}</strong><small>действующих записей</small></div><div class="stat"><span>Отменено</span><strong>${cancelled}</strong><small>в истории демо</small></div><div class="stat"><span>Демо-стоимость</span><strong>${money(confirmed.reduce((n,b)=>n+b.price,0))}</strong><small>без реальных платежей</small></div>`;
  const status=$('#admin-status').value,staffFilter=$('#admin-staff').value,day=$('#admin-date').value;
  const filtered=records.filter(b=>(status==='all'||b.status===status)&&(staffFilter==='all'||b.staffId===staffFilter)&&(!day||b.date===day)).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  $('#admin-list').innerHTML=filtered.length?filtered.map(b=>recordHTML(b,true)).join(''):emptyHTML(true);
}
async function loadAdmin(){
  const request=++listRequest;
  if(adapter.mode==='server'&&!adapter.adminToken){$('#admin-login').hidden=false;$('#admin-content').hidden=true;return;}
  $('#admin-login').hidden=true;$('#admin-content').hidden=false;
  $('#admin-list').innerHTML='<p class="small-muted">Загружаем кабинет…</p>';
  try{const value=await adapter.admin();if(request!==listRequest||view!=='admin')return;records=value;renderAdmin();}catch(e){if(request!==listRequest||view!=='admin')return;if(adapter.mode==='server'&&['401','403','unauthorized','forbidden'].includes(e.code)){adapter.adminToken='';$('#admin-login').hidden=false;$('#admin-content').hidden=true;}else $('#admin-list').innerHTML='';showNotice(e.message,true);}
}
async function switchView(next,scroll=true){
  if(!['booking','mine','admin'].includes(next))next='booking';
  view=next;++listRequest;clearNotice();
  for(const v of ['booking','mine','admin'])$('#'+v+'-view').hidden=v!==view;
  document.querySelectorAll('.nav-btn').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  const titles={booking:['БЬЮТИ-СТУДИЯ / ОНЛАЙН-ЗАПИСЬ','Время для <em>себя.</em>','Выберите то, что хочется сегодня.<br>А мы найдём для этого время.'],mine:['ЛИЧНОЕ / МОИ ЗАПИСИ','Ваше время.<br class="mobile-break"> Ваши <em>планы.</em>','Все ваши маленькие паузы — в одном месте.<br>Переносите и отменяйте, когда нужно.'],admin:['УПРАВЛЕНИЕ / КАБИНЕТ СТУДИИ','Всё <em>по местам.</em>','Расписание, специалисты и записи.<br>Забота о студии начинается здесь.']};
  $('#view-eyebrow').textContent=titles[view][0];$('#view-title').innerHTML=titles[view][1];$('#view-description').innerHTML=titles[view][2];
  if(location.hash!=='#'+view)history.replaceState(null,'','#'+view);
  if(scroll)window.scrollTo({top:0,behavior:'instant'});
  if(view==='mine')await loadMine();else if(view==='admin')await loadAdmin();else await renderSlots({notify:true});
  refreshCount();
}
function closeDialog(){if(busy)return;dialogState=null;++dialogRequest;$('#action-dialog').close();}
function showDialog(state){
  dialogState=state;$('#dialog-error').hidden=true;$('#dialog-fields').innerHTML='';$('#dialog-back').hidden=false;$('#dialog-submit').disabled=false;$('#dialog-submit').textContent='Подтвердить';$('#dialog-eyebrow').textContent='ВАША ЗАПИСЬ';
  if(state.type==='success'){
    const b=state.booking;$('#dialog-title').textContent='Время для вас найдено';$('#dialog-description').textContent=adapter.mode==='demo'?'Демо-запись сохранена в этом браузере. Реальная студия не получит уведомление.':'Запись сохранена локальным сервером. Это учебная студия; уведомления не отправляются.';
    $('#dialog-eyebrow').textContent='ГОТОВО / ЗАПИСЬ ПОДТВЕРЖДЕНА';$('#dialog-fields').innerHTML=`<div class="dialog-booking-summary"><strong>${esc(service(b.serviceId).name)}</strong>${esc(dateFormat(b.date))}, ${esc(b.time)} · Москва<br>${esc(staff(b.staffId).name)} · ${duration(b.duration)} · ${money(b.price)}<br>Демо-стоимость, без оплаты</div>${b.storageWarning?`<p class="dialog-storage-note">${esc(b.storageWarning)}</p>`:''}`;$('#dialog-submit').textContent='К моим записям ↗';$('#dialog-back').hidden=true;
  }else if(state.type==='cancel'){
    $('#dialog-title').textContent='Отменить эту запись?';$('#dialog-description').textContent=`${service(state.booking.serviceId).name}, ${dateFormat(state.booking.date)} в ${state.booking.time}. Время снова станет доступным. Отменённая запись останется в истории.`;$('#dialog-submit').textContent='Да, отменить';
  }else if(state.type==='reset'){
    $('#dialog-eyebrow').textContent='ДЕМО / ЛОКАЛЬНЫЕ ДАННЫЕ';$('#dialog-title').textContent='Начать с чистого листа?';$('#dialog-description').textContent='Все записи этого демо в текущем браузере будут удалены. Данные других сайтов останутся на месте.';$('#dialog-submit').textContent='Удалить демо-данные';
  }else if(state.type==='move'){
    const b=state.booking;state.staffId=b.staffId;state.date=b.date>=minDate()&&b.date<=maxDate()?b.date:minDate();state.time=b.time;
    $('#dialog-title').textContent='Найдём другое время';$('#dialog-description').textContent='Текущая запись сохранится, пока новое время не будет подтверждено. Если его займут, прежняя запись останется у вас.';
    $('#dialog-fields').innerHTML=`<label class="field-label" for="move-staff">Специалист</label><select id="move-staff">${eligible(b.serviceId).map(s=>`<option value="${esc(s.id)}" ${s.id===b.staffId?'selected':''}>${esc(s.name)} — ${esc(s.role)}</option>`).join('')}</select><label class="field-label" for="move-date">Новая дата</label><input type="date" id="move-date" min="${minDate()}" max="${maxDate()}" value="${state.date}" required><label class="field-label">Свободное время · Москва</label><div class="dialog-slots" id="move-slots" role="group" aria-label="Новое время записи"></div><p class="small-muted" id="move-message" role="status"></p>`;
    $('#dialog-submit').textContent='Перенести запись ↗';
  }
  $('#action-dialog').showModal();
  if(state.type==='move')loadMoveSlots();
}
async function loadMoveSlots(){
  const state=dialogState;if(!state||state.type!=='move')return;const request=++dialogRequest;
  $('#move-slots').innerHTML='';$('#move-message').textContent='Проверяем расписание…';$('#dialog-submit').disabled=true;
  if(state.date<minDate()||state.date>maxDate()){$('#move-message').textContent='Выберите дату в ближайшие 30 дней, начиная с завтра.';return;}
  try{const slots=await adapter.slots(state.booking.serviceId,state.staffId,state.date,state.booking.id,state.admin);if(request!==dialogRequest||dialogState!==state)return;if(!slots.includes(state.time))state.time='';$('#move-slots').innerHTML=slots.map(t=>`<button type="button" class="slot ${t===state.time?'selected':''}" aria-pressed="${t===state.time}" data-move-time="${esc(t)}">${esc(t)}</button>`).join('');$('#move-message').textContent=slots.length?'Выберите время и подтвердите перенос.':'Свободного времени нет. Выберите другую дату или специалиста.';$('#dialog-submit').disabled=false;}catch(e){if(request!==dialogRequest||dialogState!==state)return;$('#move-message').textContent=e.message;}
}
async function submitBooking(event){
  event.preventDefault();if(busy)return;clearNotice();
  if(!time){showNotice('Выберите свободное время для записи.',true);$('#slots').scrollIntoView({block:'center',behavior:'smooth'});$('#slots button')?.focus({preventScroll:true});return;}
  const name=$('#client-name').value.trim();if(name.length<2||name.length>60){showNotice('Введите вымышленное имя: от 2 до 60 символов.',true);$('#client-name').focus();return;}
  setBusy(true);
  try{const booking=await adapter.create({serviceId,staffId,date,time,name});time='';$('#client-name').value='';setBusy(false);showDialog({type:'success',booking});refreshCount();await renderSlots();}catch(e){showNotice(e.message,true);if(e.code==='conflict')await renderSlots();}finally{setBusy(false);}
}
async function submitDialog(event){
  event.preventDefault();if(busy||!dialogState)return;const state=dialogState;
  if(state.type==='success'){closeDialog();await switchView('mine');return;}
  if(state.type==='move'&&!state.time){$('#dialog-error').textContent='Выберите новое свободное время.';$('#dialog-error').hidden=false;return;}
  busy=true;$('#dialog-submit').disabled=true;$('#dialog-back').disabled=true;$('#dialog-close').disabled=true;$('#dialog-error').hidden=true;
  try{
    if(state.type==='move')await adapter.move(state.booking.id,{staffId:state.staffId,date:state.date,time:state.time},state.admin);
    if(state.type==='cancel')await adapter.cancel(state.booking.id,state.admin);
    if(state.type==='reset')await adapter.reset();
    busy=false;closeDialog();await (view==='admin'?loadAdmin():loadMine());refreshCount();showNotice(state.type==='move'?'Запись перенесена. Прежнее время снова доступно.':state.type==='cancel'?'Запись отменена. Время снова доступно для записи.':'Демонстрационные записи удалены.');
  }catch(e){$('#dialog-error').textContent=e.message;$('#dialog-error').hidden=false;if(e.code==='conflict'&&state.type==='move')await loadMoveSlots();}finally{busy=false;$('#dialog-submit').disabled=false;$('#dialog-back').disabled=false;$('#dialog-close').disabled=false;}
}
function bindEvents(){
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  $('.brand').addEventListener('click',e=>{e.preventDefault();switchView('booking');});$('#footer-book').addEventListener('click',e=>{e.preventDefault();switchView('booking');});
  $('#booking-form').addEventListener('submit',submitBooking);
  $('#services').addEventListener('click',e=>{const b=e.target.closest('[data-service]');if(!b||busy)return;serviceId=b.dataset.service;if(!eligible(serviceId).some(s=>s.id===staffId))staffId=eligible(serviceId)[0].id;time='';renderBooking();});
  $('#staff').addEventListener('click',e=>{const b=e.target.closest('[data-staff]');if(!b||busy)return;staffId=b.dataset.staff;time='';renderStaff();renderSummary();renderSlots();});
  $('#dates').addEventListener('click',e=>{const b=e.target.closest('[data-date]');if(!b||busy)return;date=b.dataset.date;time='';renderDates();renderSlots();});
  $('#booking-date').addEventListener('change',e=>{if(e.target.value<minDate()||e.target.value>maxDate()){showNotice('Выберите дату в ближайшие 30 дней, начиная с завтрашнего дня.',true);e.target.value=date;return;}date=e.target.value;time='';renderDates();renderSlots();});
  $('#slots').addEventListener('click',e=>{const b=e.target.closest('[data-time]');if(!b||busy)return;time=b.dataset.time;$('#slots').querySelectorAll('button').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',x===b);});renderSummary();});
  $('#refresh-mine').addEventListener('click',loadMine);$('#refresh-admin').addEventListener('click',loadAdmin);
  ['#admin-status','#admin-staff','#admin-date'].forEach(id=>$(id).addEventListener('change',renderAdmin));
  $('#clear-filters').addEventListener('click',()=>{$('#admin-status').value='all';$('#admin-staff').value='all';$('#admin-date').value='';renderAdmin();});
  $('#reset-demo').addEventListener('click',()=>showDialog({type:'reset'}));
  $('#admin-login-form').addEventListener('submit',async e=>{e.preventDefault();const token=$('#admin-token').value.trim();if(!token)return;adapter.adminToken=token;$('#admin-token').value='';clearNotice();await loadAdmin();});
  $('#admin-logout').addEventListener('click',()=>{adapter.adminToken='';records=[];loadAdmin();});
  $('#dialog-form').addEventListener('submit',submitDialog);$('#dialog-close').addEventListener('click',closeDialog);$('#dialog-back').addEventListener('click',closeDialog);
  $('#action-dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();else{dialogState=null;++dialogRequest;}});
  $('#dialog-fields').addEventListener('change',e=>{if(dialogState?.type!=='move')return;if(e.target.id==='move-date'){dialogState.date=e.target.value;dialogState.time='';loadMoveSlots();}if(e.target.id==='move-staff'){dialogState.staffId=e.target.value;dialogState.time='';loadMoveSlots();}});
  $('#dialog-fields').addEventListener('click',e=>{const b=e.target.closest('[data-move-time]');if(!b||dialogState?.type!=='move'||busy)return;dialogState.time=b.dataset.moveTime;$('#move-slots').querySelectorAll('button').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',x===b);});});
  document.addEventListener('click',e=>{const go=e.target.closest('[data-go-booking]');if(go){switchView('booking');return;}const b=e.target.closest('[data-action]');if(!b||busy)return;const booking=records.find(r=>r.id===b.dataset.id);if(booking)showDialog({type:b.dataset.action,booking,admin:b.dataset.admin==='true'});});
  window.addEventListener('hashchange',()=>switchView(location.hash.slice(1)));
  window.addEventListener('bookings-changed',()=>{if(busy)return;refreshCount();if(view==='booking')renderSlots({notify:true});if(view==='mine')loadMine();if(view==='admin'&&(adapter.mode==='demo'||adapter.adminToken))loadAdmin();});
  window.addEventListener('focus',()=>{if(adapter&&view==='booking'&&!busy)renderSlots({notify:true});});
}
async function init(){
  try{
    adapter=await createAdapter();catalog=adapter.catalog;serviceId=catalog.services[0].id;staffId=eligible(serviceId)[0].id;date=minDate();
    $('#booking-date').min=minDate();$('#booking-date').max=maxDate();
    $('#admin-staff').innerHTML='<option value="all">Все специалисты</option>'+catalog.staff.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    if(adapter.mode==='server'){
      $('#storage-explanation').textContent='Учебные записи хранятся в общей базе локального сервера. Управление своей записью доступно по ключу, сохранённому в этом браузере. Студия, цены и расписание вымышленные.';
      $('#mode-badge').lastElementChild.textContent='Локальный сервер · SQLite';$('#mode-description').innerHTML='Общая база локального сервера.<br>Все сведения студии демонстрационные.';$('#mine-mode-note').textContent='Записи этого браузера. Ключи доступа сохранены на этом устройстве.';$('#admin-mode-note').textContent='Локальный кабинет с ключом администратора. Общие записи SQLite; все данные демонстрационные.';$('#reset-demo').hidden=true;$('#admin-logout').hidden=false;
    }
    $('#loading').hidden=true;$('#app-content').hidden=false;bindEvents();await renderBooking();await switchView(location.hash.slice(1)||'booking',false);
  }catch(e){$('#loading').hidden=true;$('#fatal').hidden=false;$('#fatal-message').textContent=e.message;$('#retry-load').addEventListener('click',()=>location.reload());}
}
init();
