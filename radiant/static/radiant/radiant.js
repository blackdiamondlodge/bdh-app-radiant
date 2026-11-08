/*
 * Radiant system page.
 *
 * Polls /radiant/api/states/ every 10 s and /radiant/api/history/ every 5 min,
 * and renders one of three layouts (A mechanical room, B overview cards,
 * C house section).
 *
 * Setpoint changes are debounced per zone because the Nest integration is
 * rate limited. Each +/- press restarts that zone's timer. Only the final
 * value is sent, once the timer expires. Nothing is sent if the user ends
 * up back at the thermostat's current setpoint.
 */
(function () {
  'use strict';

  const root = document.getElementById('radiant-root');
  const ZONES = JSON.parse(document.getElementById('radiant-zones').textContent);
  const URLS = {
    states: root.dataset.statesUrl,
    history: root.dataset.historyUrl,
    setpoint: root.dataset.setpointUrl,
  };
  const CSRF = root.dataset.csrf;
  const DEBOUNCE_MS = parseInt(root.dataset.debounceMs, 10) || 10000;
  const STEP = parseFloat(root.dataset.step) || 0.5;
  const POLL_MS = 10000;
  const HISTORY_MS = 5 * 60 * 1000;
  const SENT_TIMEOUT_MS = 90000;

  let S = null;          // latest normalized state from the server
  let H = null;          // latest history
  let layout = localStorage.getItem('radiant.layout') || 'A';
  let selZone = 'main_floor';
  let lastOk = null;
  let error = null;
  let lastSig = '';
  const pending = {};    // zoneId -> { value, status: pending|sending|sent, deadline, timer, sentAt }

  // ── helpers ──────────────────────────────────────────────────────────
  const isNum = v => typeof v === 'number' && !isNaN(v);
  const f1 = v => isNum(v) ? v.toFixed(1) : '—';
  const deg = v => isNum(v) ? `${v.toFixed(1)}°` : '—';
  const kw = v => isNum(v) ? (v / 1000).toFixed(2) : '—';
  function tcol(t, lo = 10, hi = 45) {
    if (!isNum(t)) return '#555';
    const x = Math.max(0, Math.min(1, (t - lo) / (hi - lo)));
    const stops = [[63, 169, 245], [111, 211, 160], [255, 211, 77], [255, 90, 54]];
    const p = x * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), k = p - i;
    const c = stops[i].map((a, j) => Math.round(a + (stops[i + 1][j] - a) * k));
    return `rgb(${c})`;
  }
  const delta = (a, b) => (isNum(a) && isNum(b)) ? a - b : null;
  const zoneOn = Z => Z.act === 'heating' || Z.act === 'cooling';
  const actPill = a => a === 'heating' ? '<span class="pill heat"><i class="fas fa-fire"></i> Heating</span>'
    : a === 'cooling' ? '<span class="pill cool"><i class="fas fa-snowflake"></i> Cooling</span>'
    : a === 'unavailable' ? '<span class="pill err">Offline</span>'
    : a === 'off' ? '<span class="pill idle">Off</span>'
    : '<span class="pill idle">Idle</span>';
  function hpPill(h) {
    if (h.op === 'offline' || h.op === 'unavailable') return '<span class="pill err">offline</span>';
    if (h.running) return `<span class="pill ${h.op === 'cooling' ? 'cool' : 'heat'}">${h.op}</span>`;
    return `<span class="pill idle">${h.op || 'idle'}</span>`;
  }
  const faultPill = h => (h.fault === 'ok' ? '<span class="pill on">OK</span>' : `<span class="pill err">${h.fault}</span>`);
  function avgRet() {
    const v = Object.values(S.zones).map(z => z.ret).filter(isNum);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  // ── setpoints ────────────────────────────────────────────────────────
  const canSet = Z => (Z.mode === 'heat' || Z.mode === 'cool') && isNum(Z.tgt);
  const effTgt = id => (pending[id] ? pending[id].value : S.zones[id].tgt);
  function spText(Z) {
    if (Z.mode === 'heat_cool') return `${f1(Z.low)}–${f1(Z.high)}`;
    if (Z.mode === 'off') return 'Off';
    return `${f1(effTgt(Z.id))}°`;
  }
  function spStatus(id, dflt) {
    const p = pending[id];
    if (!p) return dflt;
    if (p.status === 'pending') return `sending in ${Math.max(0, Math.ceil((p.deadline - Date.now()) / 1000))}s`;
    if (p.status === 'sending') return 'sending…';
    return 'sent ✓';
  }
  const spCls = id => (pending[id] && pending[id].status !== 'sent' ? 'sp-pending' : '');

  function bump(id, d) {
    const Z = S && S.zones[id];
    if (!Z || !canSet(Z)) return;
    const prev = pending[id];
    const v = Math.min(Z.max, Math.max(Z.min, Math.round((effTgt(id) + d) / STEP) * STEP));
    if (prev) clearTimeout(prev.timer);
    if (Math.abs(v - Z.tgt) < 0.01) {
      // Back where the thermostat already is: cancel the pending change.
      delete pending[id];
    } else {
      const p = { value: v, status: 'pending', deadline: Date.now() + DEBOUNCE_MS };
      p.timer = setTimeout(() => sendSetpoint(id, p), DEBOUNCE_MS);
      pending[id] = p;
    }
    render(true);
  }

  function sendSetpoint(id, p) {
    if (pending[id] !== p) return;
    const Z = S.zones[id];
    if (Math.abs(p.value - Z.tgt) < 0.01) { delete pending[id]; render(true); return; }
    p.status = 'sending';
    render(true);
    fetch(URLS.setpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': CSRF },
      body: JSON.stringify({ entity_id: Z.entity, temperature: p.value }),
    })
      .then(r => r.json().then(j => ({ ok: r.ok && j.ok, j })))
      .then(({ ok, j }) => {
        if (pending[id] !== p) return;
        if (ok) {
          p.status = 'sent';
          p.sentAt = Date.now();
          setTimeout(pollStates, 3000);
        } else {
          delete pending[id];
          flashError(`${Z.name}: ${j.error || 'setpoint failed'}`);
        }
        render(true);
      })
      .catch(() => {
        if (pending[id] !== p) return;
        delete pending[id];
        flashError(`${Z.name}: network error`);
        render(true);
      });
  }

  function reconcilePending() {
    Object.keys(pending).forEach(id => {
      const p = pending[id], Z = S.zones[id];
      if (p.status !== 'sent') return;
      if ((Z && isNum(Z.tgt) && Math.abs(Z.tgt - p.value) < 0.01) || Date.now() - p.sentAt > SENT_TIMEOUT_MS) {
        delete pending[id];
      }
    });
  }

  // ── status line ──────────────────────────────────────────────────────
  let flash = null;
  function flashError(msg) { flash = { msg, until: Date.now() + 8000 }; updateStatus(); }
  function updateStatus() {
    const el = document.getElementById('rad-status');
    if (flash && Date.now() < flash.until) { el.textContent = `⚠ ${flash.msg}`; el.className = 'rad-status err'; return; }
    if (error) { el.textContent = `⚠ ${error}`; el.className = 'rad-status err'; return; }
    if (!lastOk) { el.textContent = 'connecting…'; el.className = 'rad-status'; return; }
    const s = Math.round((Date.now() - lastOk) / 1000);
    el.textContent = `live · ${s < 5 ? 'just now' : s + 's ago'}`;
    el.className = 'rad-status';
  }

  // ── KPI strip ────────────────────────────────────────────────────────
  function renderStrip() {
    const running = S.hp.filter(h => h.running).length;
    const w = S.hp.reduce((a, h) => a + (h.w || 0), 0), th = S.hp.reduce((a, h) => a + (h.therm || 0), 0);
    const calling = Object.values(S.zones).filter(zoneOn).length;
    const charging = S.stage1 || S.stage2 || S.backup;
    const mode = S.season === 'heat' ? 'Heat' : S.season === 'cool' ? 'Cool' : 'Off';
    const modeIc = S.season === 'heat' ? 'fa-fire' : S.season === 'cool' ? 'fa-snowflake' : 'fa-power-off';
    const modeC = S.season === 'heat' ? '#ff8a5c' : S.season === 'cool' ? '#5ec8ff' : '#9fb4c8';
    const kpi = (ic, c, glow, l, v, sub) => `<div class="rad-kpi"><div class="ic ${glow ? 'glow' : ''}" style="--kc:${c}"><i class="fas ${ic}"></i></div><div class="body"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div></div>`;
    const energy = H && isNum(H.energyTodayTotal) ? `${f1(H.energyTodayTotal)} kWh` : '—';
    document.getElementById('rad-strip').innerHTML = [
      kpi('fa-temperature-half', '#9fd3ff', false, 'Outdoor', `${f1(S.outdoor)}°`, 'USL station'),
      kpi(modeIc, modeC, S.season !== 'off', 'System mode', `<span style="color:${modeC}">${mode}</span>`, S.vacation ? '<span class="pill warn">Vacation mode</span>' : 'Home mode'),
      kpi('fa-database', tcol(S.tank), charging, 'Buffer tank', `<span style="color:${tcol(S.tank)}">${f1(S.tank)}°</span>`, `target ${f1(S.tankTarget)}° · ${charging ? '<span class="pill on">charging</span>' : 'satisfied'}`),
      kpi('fa-fan', '#3cc8b4', running > 0, 'Heat pumps', `${running}<span class="sub"> / ${S.hp.length} running</span>`, `stage1 ${S.stage1 ? '●' : '○'} stage2 ${S.stage2 ? '●' : '○'} backup ${S.backup ? '●' : '○'}`),
      kpi('fa-bolt', '#ffc35c', w > 0, 'Power / output', `${kw(w)} kW`, `${(th / 1000).toFixed(1)} kW thermal · COP ${w > 0 && th > 0 ? (th / w).toFixed(2) : '—'}`),
      kpi('fa-house-chimney', '#ff8a5c', calling > 0, 'Zone demand', `${calling}<span class="sub"> / ${ZONES.length} calling</span>`, `radiant supply ${f1(S.radSupply)}°`),
      kpi('fa-plug', '#b79cff', false, 'Energy today', energy, 'heat pump electrical'),
    ].join('');
  }

  // ── Layout A: mechanical room schematic ─────────────────────────────
  function renderA() {
    let o = '';
    const pipe = (d, t, on) => `<path class="pipe" d="${d}" stroke="#05080d" style="stroke-width:15;opacity:.7"/>${on ? `<path class="pipe glow" d="${d}" stroke="${tcol(t)}"/>` : ''}<path class="pipe" d="${d}" stroke="${tcol(t)}" ${on ? '' : 'stroke-opacity=".55"'}/><path class="flow ${on ? 'on' : 'off'}" d="${d}"/>`;
    const chip = (x, y, t, label) => `<g class="tchip"><rect x="${x - 34}" y="${y - 14}" width="68" height="26" rx="13"/><text x="${x}" y="${y + 5}" text-anchor="middle">${f1(t)}°</text>${label ? `<text x="${x}" y="${y - 20}" text-anchor="middle" style="font-weight:normal;fill:rgba(232,238,245,.6);font-size:11px">${label}</text>` : ''}</g>`;
    const tankX = 820, tankY = 150, tankW = 170, tankH = 430;
    const anyZone = Object.values(S.zones).some(zoneOn);

    o += '<text x="30" y="40" class="lbl-h">PRIMARY LOOP</text>';
    o += '<text x="1080" y="40" class="lbl-h">SECONDARY LOOP · RADIANT ZONES</text>';
    o += '<line x1="1050" y1="30" x2="1050" y2="830" stroke="rgba(255,255,255,.1)" stroke-dasharray="4 8"/>';

    const srcs = [...S.hp.map((h, i) => ({ kind: 'hp', h, i, y: 110 + i * 220 })), { kind: 'bk', y: 560 }];
    srcs.forEach(s => {
      const y = s.y, run = s.kind === 'hp' ? s.h.running : S.backup, x = 40, w = 360, h = 180;
      o += `<rect class="box ${run ? 'run' : ''}" x="${x}" y="${y}" width="${w}" height="${s.kind === 'bk' ? 120 : h}" rx="18"/>`;
      if (s.kind === 'hp') {
        const P = s.h;
        o += `<g transform="translate(${x + 58},${y + 64})"><circle r="42" fill="rgba(0,0,0,.35)" stroke="rgba(255,255,255,.15)" stroke-width="2"/>
          <g class="fan ${run ? 'on' : ''}"><path d="M0,-34 C14,-20 10,-6 0,0 C-10,-6 -14,-20 0,-34Z M34,0 C20,14 6,10 0,0 C6,-10 20,-14 34,0Z M0,34 C-14,20 -10,6 0,0 C10,6 14,20 0,34Z M-34,0 C-20,-14 -6,-10 0,0 C-6,10 -20,14 -34,0Z" fill="${run ? (P.op === 'cooling' ? '#5ec8ff' : '#ff8a5c') : 'rgba(255,255,255,.25)'}" ${run ? `style="filter:drop-shadow(0 0 6px ${P.op === 'cooling' ? '#5ec8ff' : '#ff8a5c'})"` : ''}/></g><circle r="6" fill="rgba(255,255,255,.6)"/></g>`;
        o += `<text x="${x + 120}" y="${y + 36}" class="lbl-b" style="font-size:20px">${P.name}</text>`;
        o += `<foreignObject x="${x + 120}" y="${y + 46}" width="235" height="30"><div xmlns="http://www.w3.org/1999/xhtml">${hpPill(P)} ${faultPill(P)} ${P.defrost ? '<span class="pill warn">defrost</span>' : ''}</div></foreignObject>`;
        o += `<text x="${x + 120}" y="${y + 100}" class="lbl">${Math.round(P.hz)} Hz · ${kw(P.w)} kW</text>`;
        o += `<text x="${x + 120}" y="${y + 124}" class="lbl">COP ${isNum(P.cop) ? P.cop.toFixed(2) : '—'} · ${(P.therm / 1000).toFixed(1)} kW th</text>`;
        o += `<text x="${x + 20}" y="${y + 160}" class="lbl-s">in ${deg(P.inlet)} → out ${deg(P.outlet)} · ${isNum(P.flow) ? Math.round(P.flow) : '—'} L/min · ΔT ${f1(P.dT)}°</text>`;
        const sy = y + 50, ry = y + 130;
        const lane = s.i === 0 ? 780 : 740, ent = s.i === 0 ? tankY + 60 : tankY + 110;
        o += pipe(`M${x + w},${sy} L${lane},${sy} L${lane},${ent} L${tankX},${ent}`, P.sup, run);
        o += chip(x + w + 90, sy, P.sup, `HP${s.i + 1} supply`);
        o += pipe(`M22,${ry} L${x},${ry}`, S.hpReturn, run);
      } else {
        o += `<text x="${x + 24}" y="${y + 40}" class="lbl-b" style="font-size:20px">Backup heat</text>`;
        o += `<foreignObject x="${x + 24}" y="${y + 52}" width="200" height="30"><div xmlns="http://www.w3.org/1999/xhtml">${run ? '<span class="pill on">running</span>' : '<span class="pill idle">off</span>'}</div></foreignObject>`;
        o += `<text x="${x + 24}" y="${y + 104}" class="lbl-s">AECO backup stage</text>`;
        o += pipe(`M${x + w},${y + 40} L800,${y + 40} L800,${tankY + 160} L${tankX},${tankY + 160}`, S.backupSup, S.backup);
        o += pipe(`M22,${y + 90} L${x},${y + 90}`, S.hpReturn, S.backup);
        o += chip(x + w + 90, y + 40, S.backupSup, 'backup supply');
      }
    });
    const anyHP = S.hp.some(h => h.running) || S.backup;
    o += pipe(`M${tankX + 50},${tankY + tankH - 6} L${tankX + 50},835 L22,835 L22,240`, S.hpReturn, anyHP);
    o += chip(560, 835, S.hpReturn, 'return to heat sources');

    const fillTop = tcol(isNum(S.tank) ? S.tank + 2 : null), fillBot = tcol(S.hpReturn);
    o += `<defs><linearGradient id="rad-tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fillTop}"/><stop offset="1" stop-color="${fillBot}"/></linearGradient></defs>`;
    o += `<defs><linearGradient id="rad-gloss" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".0"/><stop offset=".18" stop-color="#fff" stop-opacity=".35"/><stop offset=".32" stop-color="#fff" stop-opacity="0"/><stop offset=".85" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></linearGradient>
      <filter id="rad-tglow" x="-40%" y="-20%" width="180%" height="140%"><feGaussianBlur stdDeviation="18"/></filter></defs>`;
    o += `<rect x="${tankX}" y="${tankY}" width="${tankW}" height="${tankH}" rx="70" fill="${fillTop}" opacity=".35" filter="url(#rad-tglow)"/>`;
    o += `<rect x="${tankX}" y="${tankY}" width="${tankW}" height="${tankH}" rx="70" fill="url(#rad-tg)"/>`;
    o += `<rect x="${tankX}" y="${tankY}" width="${tankW}" height="${tankH}" rx="70" fill="url(#rad-gloss)" stroke="rgba(255,255,255,.35)" stroke-width="2"/>`;
    o += `<text x="${tankX + tankW / 2}" y="${tankY + tankH / 2 - 30}" text-anchor="middle" style="fill:rgba(10,14,20,.75);font-size:13px;letter-spacing:.25em;font-weight:700">BUFFER</text>`;
    o += `<text x="${tankX + tankW / 2}" y="${tankY + tankH / 2 + 14}" text-anchor="middle" style="fill:#0a0e14;font-size:46px;font-weight:700">${f1(S.tank)}°</text>`;
    o += `<text x="${tankX + tankW / 2}" y="${tankY + tankH / 2 + 44}" text-anchor="middle" style="fill:rgba(10,14,20,.75);font-size:15px;font-weight:600">target ${f1(S.tankTarget)}°</text>`;
    o += `<text x="${tankX + tankW / 2}" y="${tankY - 18}" text-anchor="middle" class="lbl-s">AECO-1988 · ${S.season} demand</text>`;

    const hdrX = 1120, zy0 = 90, zgap = 150, zx = 1260, rhX = 1170;
    o += pipe(`M${tankX + tankW},${tankY + 50} L${hdrX},${tankY + 50} L${hdrX},${zy0 + 20} M${hdrX},${tankY + 50} L${hdrX},${zy0 + (ZONES.length - 1) * zgap + 20}`, S.radSupply, anyZone);
    o += chip(tankX + tankW + 60, tankY + 50, S.radSupply, 'radiant supply');
    ZONES.forEach((z, i) => {
      const Z = S.zones[z.id], y = zy0 + i * zgap, on = zoneOn(Z), ok = canSet(Z);
      o += pipe(`M${hdrX},${y + 20} L${zx},${y + 20}`, S.radSupply, on);
      o += pipe(`M${zx},${y + 80} L${rhX},${y + 80}`, Z.ret, on);
      o += `<circle cx="${hdrX + 70}" cy="${y + 20}" r="13" fill="${on ? '#3cc8b4' : '#2a3442'}" stroke="rgba(255,255,255,.25)" stroke-width="1.5" ${on ? 'style="filter:drop-shadow(0 0 6px #3cc8b4)"' : ''}/><text x="${hdrX + 70}" y="${y + 25}" text-anchor="middle" style="fill:#fff;font-size:13px">${on ? '▶' : '■'}</text>`;
      o += chip(rhX + 48, y + 80, Z.ret, '');
      const cx = zx, cw = 580, ch = 110, col = Z.act === 'heating' ? '#ff6a3d' : Z.act === 'cooling' ? '#5ec8ff' : 'rgba(255,255,255,.14)';
      o += `<rect x="${cx}" y="${y}" width="${cw}" height="${ch}" rx="18" fill="${on ? (Z.act === 'cooling' ? 'rgba(94,200,255,.1)' : 'rgba(255,106,61,.1)') : 'rgba(255,255,255,.05)'}" stroke="${col}" stroke-width="${on ? 1.8 : 1}" ${on ? `style="filter:drop-shadow(0 0 10px ${col}55)"` : ''}/>`;
      o += `<rect x="${cx + 1}" y="${y + 16}" width="4" height="${ch - 32}" rx="2" fill="${col}"/>`;
      o += `<text x="${cx + 24}" y="${y + 32}" class="lbl" style="font-weight:bold;font-size:17px">${z.name}</text>`;
      o += `<foreignObject x="${cx + 24}" y="${y + 42}" width="180" height="28"><div xmlns="http://www.w3.org/1999/xhtml">${actPill(Z.act)}</div></foreignObject>`;
      o += `<text x="${cx + 24}" y="${y + 96}" class="lbl-s">return ${f1(Z.ret)}° · ${on ? `ΔT ${f1(delta(S.radSupply, Z.ret))}°` : 'no flow'}</text>`;
      o += `<text x="${cx + 250}" y="${y + 66}" text-anchor="middle" style="fill:#fff;font-size:42px;font-weight:600">${f1(Z.cur)}°</text>`;
      o += `<text x="${cx + 250}" y="${y + 92}" text-anchor="middle" class="lbl-s">room</text>`;
      o += `<g class="zbtn ${ok ? '' : 'disabled'}" ${ok ? `data-bump="${z.id}" data-d="-1"` : ''}><circle cx="${cx + 366}" cy="${y + 56}" r="26"/><text x="${cx + 366}" y="${y + 64}" text-anchor="middle">−</text></g>`;
      o += `<text class="${spCls(z.id)}" x="${cx + 446}" y="${y + 64}" text-anchor="middle" style="fill:#ffc35c;font-size:${Z.mode === 'heat_cool' ? 20 : 28}px;font-weight:bold">${spText(Z)}</text>`;
      o += `<text x="${cx + 446}" y="${y + 90}" text-anchor="middle" class="lbl-s" data-pstat="${z.id}" data-default="set">${spStatus(z.id, 'set')}</text>`;
      o += `<g class="zbtn ${ok ? '' : 'disabled'}" ${ok ? `data-bump="${z.id}" data-d="1"` : ''}><circle cx="${cx + 526}" cy="${y + 56}" r="26"/><text x="${cx + 526}" y="${y + 64}" text-anchor="middle">+</text></g>`;
    });
    o += pipe(`M${rhX},${zy0 + 80} L${rhX},800 L${tankX + 120},800 L${tankX + 120},${tankY + tankH - 6}`, avgRet(), anyZone);
    o += `<text x="${tankX + 135}" y="825" class="lbl-s">mixed zone return → buffer</text>`;
    document.getElementById('rad-schem').innerHTML = o;
  }

  // ── Layout B: overview cards ────────────────────────────────────────
  function setpointControl(Z, bigFont) {
    const ok = canSet(Z);
    return `<div><div class="rad-tgt">
        <button type="button" ${ok ? `data-bump="${Z.id}" data-d="-1"` : 'disabled'} aria-label="Lower ${Z.name}">−</button>
        <span class="t ${spCls(Z.id)}" ${bigFont ? 'style="font-size:2rem"' : ''}>${spText(Z)}</span>
        <button type="button" ${ok ? `data-bump="${Z.id}" data-d="1"` : 'disabled'} aria-label="Raise ${Z.name}">+</button>
      </div><div class="sp-stat" data-pstat="${Z.id}" data-default="">${spStatus(Z.id, '')}</div></div>`;
  }

  function renderB() {
    document.getElementById('rad-zonesB').innerHTML = ZONES.map(z => {
      const Z = S.zones[z.id], cls = Z.act === 'heating' ? 'heat' : Z.act === 'cooling' ? 'cool' : '';
      return `<div class="rad-zone ${cls}"><div class="d-flex justify-content-between align-items-center"><span class="name">${z.name}</span>${actPill(Z.act)}</div>
        <div class="d-flex justify-content-between align-items-end mt-2"><div class="cur">${f1(Z.cur)}°</div>${setpointControl(Z, false)}</div>
        <div class="meta"><span>supply ${f1(S.radSupply)}°</span><span>return ${f1(Z.ret)}°</span><span>${zoneOn(Z) ? `ΔT ${f1(delta(S.radSupply, Z.ret))}°` : 'no flow'}</span></div></div>`;
    }).join('');

    const pct = v => isNum(v) ? Math.max(0, Math.min(100, (v - 5) / 45 * 100)) : 0;
    const st = (on, label) => `<span class="pill ${on ? 'on' : 'idle'}">${label}</span>`;
    document.getElementById('rad-tankB').innerHTML = `
      <div class="rad-tankbar"><div class="fill" style="height:${pct(S.tank)}%;background:linear-gradient(${tcol(isNum(S.tank) ? S.tank + 2 : null)},${tcol(S.hpReturn)})"></div><div class="mark" style="bottom:${pct(S.tankTarget)}%"></div></div>
      <div><div style="font-size:3rem;font-weight:600;line-height:1;color:${tcol(S.tank)};text-shadow:0 0 24px ${tcol(S.tank)}66">${f1(S.tank)}°</div><div class="text-secondary">target <span style="color:#ffc35c">${f1(S.tankTarget)}°</span> (${S.season})</div>
        <table class="rad-mini mt-2 small"><tr><td>Radiant supply</td><td>${f1(S.radSupply)}°</td></tr><tr><td>Return to HPs</td><td>${f1(S.hpReturn)}°</td></tr>
        <tr><td>AECO stages</td><td>${st(S.stage1, '1')} ${st(S.stage2, '2')} ${st(S.backup, 'backup')}</td></tr></table></div>`;

    document.getElementById('rad-hpsB').innerHTML = S.hp.map(P => {
      const run = P.running;
      return `<div class="rad-hp ${run ? 'run' : ''}"><div class="row1"><b><i class="fas fa-fan ${run ? 'fa-spin' : ''} me-2" style="color:${run ? (P.op === 'cooling' ? '#5ec8ff' : '#ff8a5c') : 'rgba(255,255,255,.3)'}"></i>${P.name}</b>
        <span>${hpPill(P)} ${faultPill(P)} ${P.defrost ? '<span class="pill warn">defrost</span>' : ''}</span></div>
        <div class="stats"><div><div class="l">Compressor</div><div class="v">${Math.round(P.hz)} Hz</div></div><div><div class="l">Power</div><div class="v">${kw(P.w)} kW</div></div>
        <div><div class="l">COP</div><div class="v">${isNum(P.cop) ? P.cop.toFixed(2) : '—'}</div></div><div><div class="l">Supply</div><div class="v">${f1(P.sup)}°</div></div>
        <div><div class="l">In</div><div class="v">${deg(P.inlet)}</div></div><div><div class="l">Out</div><div class="v">${deg(P.outlet)}</div></div>
        <div><div class="l">Flow</div><div class="v">${isNum(P.flow) ? Math.round(P.flow) : '—'} L/m</div></div><div><div class="l">ΔT</div><div class="v">${f1(P.dT)}°</div></div></div></div>`;
    }).join('') + `<div class="rad-hp ${S.backup ? 'run' : ''} d-flex justify-content-between align-items-center"><b><i class="fas fa-fire-flame-simple me-2" style="color:${S.backup ? '#ff8a5c' : 'rgba(255,255,255,.3)'}"></i>Backup heat</b><span>${S.backup ? '<span class="pill on">running</span>' : '<span class="pill idle">off</span>'} supply ${f1(S.backupSup)}°</span></div>`;

    renderSpark();
  }

  function renderSpark() {
    const g = document.getElementById('rad-sparkB');
    const range = document.getElementById('rad-sparkRange');
    if (!H) { g.innerHTML = '<text x="400" y="80" fill="rgba(232,238,245,.5)" font-size="16" text-anchor="middle">loading history…</text>'; range.textContent = ''; return; }
    const series = [[H.tank, '#ffc35c'], [H.supply, '#ff6a3d'], [H.avgReturn, '#5ec8ff']];
    const all = series.flatMap(([s]) => s).filter(isNum);
    if (!all.length) { g.innerHTML = '<text x="400" y="80" fill="rgba(232,238,245,.5)" font-size="16" text-anchor="middle">no history</text>'; range.textContent = ''; return; }
    const lo = Math.floor(Math.min(...all) - 1), hi = Math.ceil(Math.max(...all) + 1);
    const n = H.tank.length, W = 800, HT = 150;
    const x = k => k * W / (n - 1), y = v => HT - (v - lo) / (hi - lo) * HT;
    let p = '';
    H.hpRunning.forEach((on, k) => { if (on) p += `<rect x="${k * W / n}" y="0" width="${W / n + 0.5}" height="${HT}" fill="#3cc8b4" opacity=".1"/>`; });
    series.forEach(([s, c]) => {
      // break the line across gaps
      let seg = [];
      const flush = () => { if (seg.length > 1) p += `<polyline fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" style="filter:drop-shadow(0 0 4px ${c}88)" vector-effect="non-scaling-stroke" points="${seg.join(' ')}"/>`; seg = []; };
      s.forEach((v, k) => { if (isNum(v)) seg.push(`${x(k).toFixed(1)},${y(v).toFixed(1)}`); else flush(); });
      flush();
    });
    g.innerHTML = p;
    range.textContent = `${lo}° – ${hi}° · 24 h`;
  }

  // ── Layout C: house section ─────────────────────────────────────────
  const ROOMS = {
    master_bedroom: { x: 120, y: 40, w: 760, h: 150 },
    main_floor: { x: 60, y: 200, w: 600, h: 170 },
    ski_room: { x: 670, y: 200, w: 270, h: 170 },
    basement_master: { x: 60, y: 380, w: 430, h: 200 },
    basement_bunk_rooms: { x: 500, y: 380, w: 440, h: 200 },
  };

  function renderC() {
    let o = '<defs><linearGradient id="rad-roof" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4d66"/><stop offset="1" stop-color="#1c2738"/></linearGradient></defs>'
      + '<polygon points="30,42 500,0 970,42" fill="url(#rad-roof)" stroke="rgba(255,255,255,.15)"/><rect x="20" y="588" width="960" height="10" rx="5" fill="rgba(255,255,255,.12)"/>';
    ZONES.forEach(z => {
      const r = ROOMS[z.id];
      if (!r) return;
      const Z = S.zones[z.id], on = zoneOn(Z), sel = selZone === z.id;
      o += `<rect class="room" data-select="${z.id}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="16" fill="${tcol(Z.cur, 10, 25)}" fill-opacity="${sel ? .42 : .28}" stroke="${sel ? '#ffc35c' : tcol(Z.cur, 10, 25)}" stroke-opacity="${sel ? 1 : .6}" stroke-width="${sel ? 3 : 1.5}" ${sel ? 'style="filter:drop-shadow(0 0 12px rgba(255,195,92,.55))"' : ''}/>`;
      if (on) for (let k = 0; k < 6; k++) o += `<path d="M${r.x + 20 + k * (r.w - 72) / 5},${r.y + r.h - 14} q8,-8 16,0 t16,0" stroke="${Z.act === 'cooling' ? '#5ec8ff' : '#ff6a3d'}" stroke-width="3" fill="none" opacity=".9" pointer-events="none"/>`;
      o += `<text class="roomtxt" x="${r.x + 16}" y="${r.y + 30}" style="font-size:17px;font-weight:600;fill:#fff">${z.name}</text>`;
      o += `<text class="roomtxt" x="${r.x + 16}" y="${r.y + 80}" style="font-size:42px;font-weight:600;fill:#fff">${f1(Z.cur)}°</text>`;
      o += `<text class="roomtxt" x="${r.x + 16}" y="${r.y + 108}" style="font-size:14px;fill:rgba(255,255,255,.8)">set ${spText(Z)} · ${Z.act} · return ${f1(Z.ret)}°</text>`;
    });
    document.getElementById('rad-house').innerHTML = o;

    const Z = S.zones[selZone];
    document.getElementById('rad-selC').innerHTML = `<div class="d-flex justify-content-between align-items-center"><h5 class="m-0">${Z.name}</h5>${actPill(Z.act)}</div>
      <div class="d-flex align-items-center justify-content-between mt-3">
        <div><div class="rad-kl">Room</div><div class="rad-bigdial">${f1(Z.cur)}°</div></div>
        <div><div class="rad-kl text-center">Setpoint</div>${setpointControl(Z, true)}</div></div>
      <table class="rad-mini mt-3"><tr><td>Floor supply (shared)</td><td>${f1(S.radSupply)}°</td></tr><tr><td>Zone return</td><td>${f1(Z.ret)}°</td></tr>
      <tr><td>Loop ΔT</td><td>${zoneOn(Z) ? f1(delta(S.radSupply, Z.ret)) + '°' : 'no flow'}</td></tr>
      ${isNum(Z.humidity) ? `<tr><td>Humidity</td><td>${Math.round(Z.humidity)}%</td></tr>` : ''}</table>`;

    let m = '';
    S.hp.forEach((P, i) => {
      m += `<rect x="10" y="${20 + i * 70}" width="150" height="56" rx="12" fill="rgba(255,255,255,.06)" stroke="${P.running ? '#3cc8b4' : 'rgba(255,255,255,.14)'}" stroke-width="1.5"/>
        <text x="22" y="${44 + i * 70}" fill="#fff" font-size="14" font-weight="bold">HP${i + 1} ${P.running ? '●' : '○'}</text><text x="22" y="${64 + i * 70}" fill="rgba(232,238,245,.6)" font-size="12">${Math.round(P.hz)} Hz · ${isNum(P.w) ? (P.w / 1000).toFixed(1) : '—'} kW</text>
        <line x1="160" y1="${48 + i * 70}" x2="250" y2="${48 + i * 70}" stroke="${tcol(P.sup)}" stroke-width="6" stroke-linecap="round"/><text x="200" y="${40 + i * 70}" fill="rgba(232,238,245,.75)" font-size="12" text-anchor="middle">${f1(P.sup)}°</text>`;
    });
    m += `<rect x="10" y="160" width="150" height="50" rx="12" fill="rgba(255,255,255,.06)" stroke="${S.backup ? '#3cc8b4' : 'rgba(255,255,255,.14)'}" stroke-width="1.5"/><text x="22" y="190" fill="#fff" font-size="14" font-weight="bold">Backup ${S.backup ? '●' : '○'}</text>`;
    m += `<rect x="250" y="20" width="90" height="190" rx="40" fill="${tcol(S.tank)}" stroke="rgba(255,255,255,.35)" stroke-width="2" style="filter:drop-shadow(0 0 10px ${tcol(S.tank)}88)"/><text x="295" y="120" fill="#111" font-size="22" font-weight="bold" text-anchor="middle">${f1(S.tank)}°</text><text x="295" y="142" fill="#111" font-size="11" text-anchor="middle">tgt ${f1(S.tankTarget)}°</text>`;
    m += `<line x1="340" y1="60" x2="550" y2="60" stroke="${tcol(S.radSupply)}" stroke-width="6" stroke-linecap="round"/><text x="445" y="50" fill="rgba(232,238,245,.75)" font-size="12" text-anchor="middle">supply ${f1(S.radSupply)}°</text>`;
    m += `<line x1="340" y1="180" x2="550" y2="180" stroke="${tcol(avgRet())}" stroke-width="6" stroke-linecap="round"/><text x="445" y="170" fill="rgba(232,238,245,.75)" font-size="12" text-anchor="middle">avg return ${f1(avgRet())}°</text>`;
    document.getElementById('rad-miniPlant').innerHTML = m;
  }

  // ── render loop ─────────────────────────────────────────────────────
  function render(force) {
    if (!S) return;
    const sig = JSON.stringify([S, H && H.end, layout, selZone,
      Object.entries(pending).map(([k, p]) => [k, p.value, p.status])]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    document.getElementById('rad-loading').classList.add('rad-hidden');
    ['A', 'B', 'C'].forEach(k => document.getElementById('rad-view' + k).classList.toggle('rad-hidden', k !== layout));
    document.querySelectorAll('#rad-tabs [data-layout]').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
    renderStrip();
    ({ A: renderA, B: renderB, C: renderC })[layout]();
  }

  // ── data ────────────────────────────────────────────────────────────
  function pollStates() {
    return fetch(URLS.states, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        if (j.ok) { S = j; lastOk = Date.now(); error = null; reconcilePending(); }
        else error = j.error || 'Home Assistant error';
      })
      .catch(() => { error = 'Hub server unreachable'; })
      .finally(() => { updateStatus(); render(false); });
  }

  function pollHistory() {
    return fetch(URLS.history, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.ok) { H = j; render(false); } })
      .catch(() => {});
  }

  // ── events ──────────────────────────────────────────────────────────
  document.addEventListener('click', e => {
    const tab = e.target.closest('#rad-tabs [data-layout]');
    if (tab) {
      layout = tab.dataset.layout;
      localStorage.setItem('radiant.layout', layout);
      render(true);
      return;
    }
    const b = e.target.closest('[data-bump]');
    if (b) { bump(b.dataset.bump, parseFloat(b.dataset.d) * STEP); return; }
    const s = e.target.closest('[data-select]');
    if (s) { selZone = s.dataset.select; render(true); }
  });

  // Countdown text for pending setpoints, without re-rendering the views.
  setInterval(() => {
    document.querySelectorAll('[data-pstat]').forEach(el => {
      el.textContent = spStatus(el.dataset.pstat, el.dataset.default);
    });
    updateStatus();
  }, 500);

  const urlLayout = new URLSearchParams(location.search).get('layout');
  if (urlLayout) layout = urlLayout.toUpperCase();
  if (!['A', 'B', 'C'].includes(layout)) layout = 'A';
  pollStates();
  pollHistory();
  setInterval(pollStates, POLL_MS);
  setInterval(pollHistory, HISTORY_MS);

  // Exposed for tests / debugging.
  window.radiant = { pending, get state() { return S; } };
})();
