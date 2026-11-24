const $ = id => document.getElementById(id), t0 = Date.now();
const post = (p, b) => fetch('/api/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ ok: r.ok, ...(await r.json()) }));
const ls = (k, v) => v === undefined ? JSON.parse(localStorage.getItem(k) || 'null') : localStorage.setItem(k, JSON.stringify(v));
const ar = n => Number(n).toLocaleString('ar-EG');
function msg(el, html, err) { el.hidden = false; el.className = 'result' + (err ? ' err' : ''); el.replaceChildren(); if (typeof html === 'string') el.textContent = html; else el.append(html); }
async function stats() {
  const s = await (await fetch('/api/stats')).json();
  $('s-live').textContent = ar(s.liveLinks); $('s-seats').textContent = ar(s.seatsLeft); $('s-taken').textContent = ar(s.totalTaken); $('s-contrib').textContent = ar(s.contributors);
  $('boardcard').hidden = !s.board.length;
  $('board').replaceChildren(...s.board.map(x => { const li = document.createElement('li'); li.textContent = x.name; const sp = document.createElement('span'); sp.textContent = ar(x.served) + ' شخص'; li.append(sp); return li; }));
}
$('take').onclick = async () => {
  $('take').disabled = true;
  const r = await post('take', { own: (ls('mine') || {}).id });
  $('take').disabled = false;
  if (!r.ok) return msg($('result'), r.error, true);
  ls('lastTake', { id: r.id, url: r.url, at: Date.now() });
  showTaken(); stats();
};
function showTaken() {
  const t = ls('lastTake'); if (!t || !t.url) return;
  const box = document.createElement('div'), a = document.createElement('a');
  a.href = t.url; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; a.textContent = t.url;
  const row = document.createElement('div'); row.className = 'row';
  const bad = document.createElement('button'); bad.className = 'ghost danger';
  if (t.reported) { bad.disabled = true; bad.textContent = 'اتبلّغ عنه. شكراً'; }
  else {
    bad.textContent = 'اللينك مش شغال';
    bad.onclick = async () => {
      const x = await post('report', { id: t.id }); bad.disabled = true;
      if (x.ok) { ls('lastTake', { ...ls('lastTake'), reported: true }); bad.textContent = 'اتبلّغ عنه. شكراً'; } else bad.textContent = x.error;
      stats();
    };
  }
  row.append(bad); box.append(a, row);
  box.append(nextStep());
  msg($('result'), box);
}

function goAdd() {
  $('add').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('url').focus({ preventScroll: true }), 400);
}

function nextStep() {
  const step = document.createElement('div'); step.className = 'nextstep';
  const h3 = document.createElement('h3'); h3.textContent = 'دخلت من اللينك؟';
  const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'ضيف لينكك وهتظهر في لوحة الشرف، وكل حد هياخد منك هيحسبلك.';
  const row = document.createElement('div'); row.className = 'row';
  const go = document.createElement('button'); go.className = 'primary'; go.textContent = 'ضيف لينكي دلوقتي';
  go.onclick = goAdd;
  const rem = document.createElement('button'); rem.className = 'ghost'; rem.textContent = 'ذكّرني بعد ساعة ⏰';
  const status = document.createElement('p'); status.className = 'muted small'; status.hidden = true;
  rem.onclick = () => remind(rem, status);
  row.append(go, rem); step.append(h3, p, row, status);
  return step;
}

let remindTimer;
async function remind(btn, status) {
  btn.disabled = true;
  const at = Date.now() + 3600000;
  ls('remindAt', at);
  let note;
  if ('Notification' in window) {
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        clearTimeout(remindTimer);
        remindTimer = setTimeout(() => { try { new Notification('دعوتي ✦', { body: 'ساعة عدت! لو دخلت من الدعوة، ارجع ضيف لينكك.' }); } catch {} }, 3600000);
        note = 'هيوصلك إشعار بعد ساعة لو الصفحة لسه مفتوحة. وللأمان احفظها كمان في التقويم:';
      } else note = 'الإشعارات مقفولة، فاحفظ التذكير في التقويم:';
    } catch { note = 'الإشعارات مش متاحة هنا، فاحفظ التذكير في التقويم:'; }
  } else note = 'احفظ التذكير في التقويم:';
  const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const cal = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent('دعوتي: ضيف لينكك') +
    '&dates=' + fmt(new Date(at)) + '/' + fmt(new Date(at + 900000)) +
    '&details=' + encodeURIComponent('ارجع لموقع دعوتي وضيف لينك الدعوة بتاعك عشان تطلع في لوحة الشرف.');
  status.hidden = false; status.replaceChildren();
  status.append(document.createTextNode(note + ' '));
  const a = document.createElement('a'); a.href = cal; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'احفظ في جوجل كالندر';
  status.append(a);
  btn.textContent = 'التذكير اتحفظ ✓';
}

function comeback() {
  const t = ls('lastTake'); if (!t || !t.at) return;
  if (Date.now() - t.at < 3600000) return;
  const m = ls('mine'); if (m && m.addedAt && m.addedAt > t.at) return;
  $('comeback').hidden = false;
}
$('comeback-go').onclick = goAdd;
$('add').onsubmit = async e => {
  e.preventDefault();
  const r = await post('add', { url: $('url').value, name: $('name').value, website: $('website').value, t: t0 });
  if (!r.ok) return msg($('added'), r.error, true);
  if (r.id) ls('mine', { id: r.id, secret: r.secret, addedAt: Date.now() });
  $('add').reset(); stats(); showMine('اتضاف لينكك. شكراً!');
};
function showMine(text) {
  const m = ls('mine'); if (!m) return;
  const box = document.createElement('div'), p = document.createElement('p'); p.textContent = text || 'لينكك متضاف.'; p.style.margin = '0 0 10px';
  const b = document.createElement('button'); b.className = 'ghost danger'; b.textContent = 'شيل لينكي (مبقاش شغال)';
  b.onclick = async () => { const x = await post('remove', m); if (x.ok) { localStorage.removeItem('mine'); msg($('added'), 'اتشال.'); stats(); } else msg($('added'), x.error, true); };
  box.append(p, b); msg($('added'), box);
}
showTaken(); showMine(); comeback(); stats(); setInterval(stats, 30000);
