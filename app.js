/* World Cup 2026 tracker — vendored schedule (openfootball) + optional live
 * scores overlay. All times rendered in the VIEWER'S local timezone. No build,
 * no deps. The backend hands us already-normalized data (kickoff_utc, num,
 * stage); this file only does presentation + local-time grouping. */
'use strict';

const BASE = location.pathname.replace(/[^/]*$/, ''); // works under /worldcup/ or /
// Demo mode: the dev build (served at /worldcup.dev/) or an explicit ?demo=1
// keeps polling /api/scores regardless of real match windows, so the dev
// instance's fabricated live scores visibly tick. See gateway/DEV_APPS.md.
const DEMO = location.pathname.includes('.dev') || new URLSearchParams(location.search).has('demo');

// ---- static-publish mode ---------------------------------------------------
// When a baked ./data.json sits next to index.html (the GitHub Pages snapshot),
// the app runs fully client-side off that one bundle — no backend, no API calls.
// A normal dojo backend deployment has no data.json (it 404s), so we fall through
// to the live API path. ONE codebase serves both: the only difference between the
// live app and the public snapshot is where the data comes from. See the worldcup
// repo's scripts/gen-static.py (the box bakes + pushes this; the public never
// touches the server).
let STATIC = false;
let DATA = null; // the loaded bundle: {schedule, scores, leaderboard, events, generated_at}

// ---- country -> flag emoji -------------------------------------------------
const ISO2 = {
  Algeria: 'DZ', Argentina: 'AR', Australia: 'AU', Austria: 'AT', Belgium: 'BE',
  'Bosnia & Herzegovina': 'BA', Brazil: 'BR', Canada: 'CA', 'Cape Verde': 'CV',
  Colombia: 'CO', Croatia: 'HR', 'Curaçao': 'CW', 'Czech Republic': 'CZ',
  'DR Congo': 'CD', Ecuador: 'EC', Egypt: 'EG', France: 'FR', Germany: 'DE',
  Ghana: 'GH', Haiti: 'HT', Iran: 'IR', Iraq: 'IQ', 'Ivory Coast': 'CI',
  Japan: 'JP', Jordan: 'JO', Mexico: 'MX', Morocco: 'MA', Netherlands: 'NL',
  'New Zealand': 'NZ', Norway: 'NO', Panama: 'PA', Paraguay: 'PY', Portugal: 'PT',
  Qatar: 'QA', 'Saudi Arabia': 'SA', Senegal: 'SN', 'South Africa': 'ZA',
  'South Korea': 'KR', Spain: 'ES', Sweden: 'SE', Switzerland: 'CH', Tunisia: 'TN',
  Turkey: 'TR', USA: 'US', Uruguay: 'UY', Uzbekistan: 'UZ',
  // additional nations seen in past seasons (e.g. 2022, used by the dev build)
  Cameroon: 'CM', 'Costa Rica': 'CR', Denmark: 'DK', Poland: 'PL', Serbia: 'RS',
};
// GB subdivision flags (tag sequences) for the home nations
const subdivFlag = (code) =>
  '\u{1F3F4}' + [...code].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('') + '\u{E007F}';
const SPECIAL_FLAG = {
  England: subdivFlag('gbeng'), Scotland: subdivFlag('gbsct'), Wales: subdivFlag('gbwls'),
};

function flagFor(team) {
  if (SPECIAL_FLAG[team]) return SPECIAL_FLAG[team];
  const iso = ISO2[team];
  if (!iso) return '';
  return iso.replace(/./g, (c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65));
}

// ---- knockout placeholder codes -> readable label --------------------------
function teamLabel(code) {
  if (ISO2[code] || SPECIAL_FLAG[code]) return { name: code, placeholder: false };
  let m;
  if ((m = /^1([A-L])$/.exec(code))) return ph(`Winner Group ${m[1]}`);
  if ((m = /^2([A-L])$/.exec(code))) return ph(`Runner-up Group ${m[1]}`);
  if ((m = /^3(.+)$/.exec(code))) return ph(`3rd: ${m[1]}`);
  if ((m = /^W(\d+)$/.exec(code))) return ph(`Winner Match ${m[1]}`);
  if ((m = /^L(\d+)$/.exec(code))) return ph(`Loser Match ${m[1]}`);
  return ph(code);
}
const ph = (name) => ({ name, placeholder: true });

// ---- stage colors + badge text ---------------------------------------------
const STAGE_COLOR = {
  group: 'var(--st-group)', r32: 'var(--st-r32)', r16: 'var(--st-r16)',
  qf: 'var(--st-qf)', sf: 'var(--st-sf)', third: 'var(--st-third)', final: 'var(--st-final)',
};
function badgeText(mt) {
  if (mt.stage === 'group') return mt.group;
  if (mt.stage === 'third') return '3rd place';
  return mt.round; // "Round of 32", "Quarter-final", "Semi-final", "Final"
}

// ---- date/time helpers (viewer local) --------------------------------------
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDow = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const fmtDate = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' });
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
// "now" the UI runs on: the dev build's /api/scores carries a fabricated `now`
// (mid-tournament) so the page treats that day as today and snaps there; prod
// has no `now`, so it falls back to the real clock.
let simNow = null;
const clockNow = () => simNow || new Date();
const todayKey = () => dayKey(clockNow());

// ---- state -----------------------------------------------------------------
let MATCHES = [];
let filter = 'all';
let scores = {}; // num -> {status, score1, score2, minute}
let mainTab = 'matches';        // 'matches' | 'players'
let lbStat = 'goals';           // 'goals' | 'assists' | 'clean_sheets'
let leaderboards = null;        // {goals:[…], assists:[…], clean_sheets:[…], source}
let gamePollTimer = null;       // re-poll the open game view while a match is live

function passesFilter(mt) {
  if (filter === 'all') return true;
  if (filter === 'group') return mt.stage === 'group';
  return mt.stage !== 'group';
}

// ---- render ----------------------------------------------------------------
function render() {
  const agenda = document.getElementById('agenda');
  const visible = MATCHES.filter(passesFilter);
  agenda.innerHTML = '';
  if (!visible.length) {
    agenda.innerHTML = '<div class="loading">No matches for this filter.</div>';
    return;
  }

  // group by local calendar day
  const days = new Map();
  for (const mt of visible) {
    const d = new Date(mt.kickoff_utc);
    const k = dayKey(d);
    if (!days.has(k)) days.set(k, { date: d, items: [] });
    days.get(k).items.push(mt);
  }

  const tKey = todayKey();
  for (const [k, day] of days) {
    const sec = document.createElement('section');
    sec.className = 'day';
    sec.dataset.day = k;
    if (k === tKey) sec.classList.add('is-today');

    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML =
      `<span class="dow">${fmtDow.format(day.date)}</span>` +
      `<span class="date">${fmtDate.format(day.date)}</span>` +
      `<span class="count">${day.items.length} ${day.items.length === 1 ? 'match' : 'matches'}</span>`;
    sec.appendChild(head);

    for (const mt of day.items) sec.appendChild(matchCard(mt));
    agenda.appendChild(sec);
  }
  applyScores();
  setupJumpPill();
}

function matchCard(mt) {
  const card = document.createElement('article');
  card.className = 'match';
  card.id = `m-${mt.num}`;
  card.style.setProperty('--stage', STAGE_COLOR[mt.stage] || STAGE_COLOR.group);

  const t1 = teamLabel(mt.team1);
  const t2 = teamLabel(mt.team2);
  const kickoff = fmtTime.format(new Date(mt.kickoff_utc));

  card.innerHTML =
    `<div class="m-time">` +
      `<div class="clock">${kickoff}</div>` +
      `<div class="status"></div>` +
    `</div>` +
    `<div class="m-teams">` +
      teamRow(t1, mt.team1) +
      teamRow(t2, mt.team2) +
    `</div>` +
    `<div class="m-meta">` +
      `<span class="badge">${esc(badgeText(mt))}</span>` +
      (mt.ground ? `<span class="venue">${esc(mt.ground)}</span>` : '') +
    `</div>`;
  return card;
}

function teamRow(label, code) {
  const flag = flagFor(code);
  return (
    `<div class="team">` +
      `<span class="flag">${flag || '<span style="color:var(--faint)">·</span>'}</span>` +
      `<span class="name${label.placeholder ? ' placeholder' : ''}">${esc(label.name)}</span>` +
      `<span class="score"></span>` +
    `</div>`
  );
}

// ---- live scores overlay ---------------------------------------------------
function applyScores() {
  for (const mt of MATCHES) {
    const card = document.getElementById(`m-${mt.num}`);
    if (!card) continue;
    const sc = scores[mt.num];
    const rows = card.querySelectorAll('.team');
    const scoreEls = card.querySelectorAll('.score');
    const statusEl = card.querySelector('.status');
    rows.forEach((r) => r.classList.remove('win', 'lose'));
    card.classList.remove('live');
    statusEl.className = 'status';
    statusEl.textContent = '';

    if (!sc) { scoreEls.forEach((e) => (e.textContent = '')); continue; }

    const paused = sc.status === 'PAUSED';        // half-time
    const live = /IN_PLAY|LIVE/.test(sc.status);
    const done = sc.status === 'FINISHED';
    card.classList.toggle('live', live || paused);  // underway -> in-progress styling
    const has = sc.score1 != null && sc.score2 != null;
    scoreEls[0].textContent = has ? sc.score1 : '';
    scoreEls[1].textContent = has ? sc.score2 : '';

    if (paused) {
      statusEl.classList.add('live');
      statusEl.textContent = 'HT';
    } else if (live) {
      statusEl.classList.add('live');
      statusEl.textContent = sc.minute ? `LIVE ${sc.minute}'` : 'LIVE';
    } else if (done) {
      statusEl.classList.add('ft');
      statusEl.textContent = 'FT';
      if (has && sc.score1 !== sc.score2) {
        const w = sc.score1 > sc.score2 ? 0 : 1;
        rows[w].classList.add('win');
        rows[1 - w].classList.add('lose');
      }
    }
  }
}

async function fetchScores() {
  if (STATIC) {                       // snapshot: scores already in the bundle
    const data = DATA.scores || {};
    if (data.now) simNow = new Date(data.now);
    scores = data.matches || {};
    applyScores();
    return;
  }
  try {
    const r = await fetch(`${BASE}api/scores`, { cache: 'no-store' });
    const data = await r.json();
    if (data.now) simNow = new Date(data.now); // demo clock (mid-tournament)
    scores = data.matches || {};
    applyScores();
  } catch (e) { /* keep last */ }
}

// poll quickly only when a match is plausibly in play
function anyLiveWindow() {
  const t = clockNow().getTime();
  return MATCHES.some((mt) => {
    const ko = new Date(mt.kickoff_utc).getTime();
    return t >= ko - 600000 && t <= ko + 9000000;
  });
}
function startScorePolling() {
  if (STATIC) {                       // re-pull the pushed snapshot so a freshly
    setInterval(async () => {         // published data.json appears without reload
      try {
        const r = await fetch(`${BASE}data.json?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
        if (!r.ok) return;
        DATA = await r.json();
        applyStaticChrome();
        const sc = DATA.scores || {};
        if (sc.now) simNow = new Date(sc.now);
        scores = sc.matches || {};
        applyScores();
        if (mainTab === 'players') { leaderboards = DATA.leaderboard; renderLeaderboard(); }
      } catch (e) { /* keep last */ }
    }, 60000);
    return;
  }
  const every = DEMO ? 12000 : 30000;
  setInterval(() => {
    if (DEMO || anyLiveWindow()) {
      fetchScores();
      if (mainTab === 'players') fetchLeaderboard(); // keep the board live
    }
  }, every);
}

// ---- player leaderboards (goals / assists / clean sheets) ------------------
const LB_LABEL = { goals: 'goals', assists: 'assists', clean_sheets: 'clean sheets' };

async function fetchLeaderboard() {
  if (STATIC) {                       // snapshot: leaderboard already in the bundle
    leaderboards = DATA.leaderboard || { goals: [], assists: [], clean_sheets: [] };
    if (leaderboards.now) simNow = new Date(leaderboards.now);
    if (mainTab === 'players') renderLeaderboard();
    return;
  }
  try {
    const r = await fetch(`${BASE}api/leaderboard`, { cache: 'no-store' });
    const data = await r.json();
    if (data.now) simNow = new Date(data.now);
    leaderboards = data;
    if (mainTab === 'players') renderLeaderboard();
  } catch (e) { /* keep last */ }
}

// In static mode a scores-only snapshot (e.g. the football-data source) carries
// no player leaderboards; hide the Players tab until a snapshot has data, so the
// public app shows just the calendar rather than an empty board. Re-applied on
// each snapshot re-pull so the tab appears the moment player data shows up.
function applyStaticChrome() {
  if (!STATIC) return;
  const lb = DATA && DATA.leaderboard;
  const hasPlayers = !!lb && ['goals', 'assists', 'clean_sheets']
    .some((k) => Array.isArray(lb[k]) && lb[k].length);
  const tabs = document.getElementById('mainTabs');
  if (tabs) tabs.hidden = !hasPlayers;   // lone "Matches" tab -> hide the whole bar
  // The share link points AT the public site; on the public site itself it's
  // redundant (you're already there), so hide it.
  const share = document.getElementById('shareLink');
  if (share) share.hidden = true;
}

function renderLeaderboard() {
  const list = document.getElementById('lbList');
  if (!list) return;
  if (!leaderboards) { list.innerHTML = '<li class="loading">Loading…</li>'; return; }
  const rows = leaderboards[lbStat] || [];
  if (!rows.length) {
    const why = /football-data/.test(leaderboards.source || '')
      ? 'Player stats need the ESPN or API-Football data source — the current one provides scores only.'
      : `No ${LB_LABEL[lbStat] || 'data'} yet — check back once matches are underway.`;
    list.innerHTML = `<li class="lb-empty">${esc(why)}</li>`;
    return;
  }
  list.innerHTML = rows.map((r, i) =>
    `<li class="lb-row">` +
      `<span class="lb-rank">${i + 1}</span>` +
      `<span class="lb-flag">${flagFor(r.team) || '<span style="color:var(--faint)">·</span>'}</span>` +
      `<span class="lb-who">` +
        `<div class="lb-name">${esc(r.player)}</div>` +
        `<div class="lb-team">${esc(r.team)}</div>` +
      `</span>` +
      `<span class="lb-count">${r.count}</span>` +
    `</li>`).join('');
}

function switchMainTab(tab) {
  mainTab = tab;
  document.querySelectorAll('#mainTabs .tab')
    .forEach((t) => t.classList.toggle('is-on', t.dataset.tab === tab));
  const players = tab === 'players';
  document.body.classList.toggle('on-players', players);  // CSS-hides the jump pill
  document.getElementById('agenda').hidden = players;
  document.getElementById('matchControls').hidden = players;
  document.getElementById('playerControls').hidden = !players;
  document.getElementById('leaderboard').hidden = !players;
  if (players) {
    document.getElementById('jumpNow').classList.remove('show');
    window.scrollTo(0, 0);   // the board always starts at the top
    renderLeaderboard();     // show cached immediately (or "Loading…")
    fetchLeaderboard();      // then refresh
  } else {
    scrollToToday(false);    // back to the calendar's "today" anchor, not the first match
  }
}

// ---- navigation ------------------------------------------------------------
// The day section to treat as "today": today's own section if it has matches,
// else the next upcoming day, else the last day on the calendar.
function todayTarget() {
  const tKey = todayKey();
  const c = clockNow();
  const midnight = new Date(c.getFullYear(), c.getMonth(), c.getDate());
  return (
    document.querySelector(`.day[data-day="${tKey}"]`) ||
    [...document.querySelectorAll('.day')].find((s) => {
      const [y, m, d] = s.dataset.day.split('-').map(Number);
      return new Date(y, m, d) >= midnight;
    }) ||
    document.querySelector('.day:last-child')
  );
}

function scrollToToday(smooth) {
  const target = todayTarget();
  if (target) target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

// The floating "Jump to today" pill: wired to scroll, and only shown when the
// today section is off-screen (arrow points the way). Re-bound on every render
// since the DOM — and thus the target element — is rebuilt.
let jumpIO = null;
function setupJumpPill() {
  const pill = document.getElementById('jumpNow');
  const btn = document.getElementById('jumpNowBtn');
  if (!pill || !btn) return;
  btn.onclick = () => scrollToToday(true);
  if (jumpIO) jumpIO.disconnect();
  const target = todayTarget();
  if (!target) { pill.classList.remove('show'); return; }
  jumpIO = new IntersectionObserver(([e]) => {
    if (mainTab !== 'matches') { pill.classList.remove('show'); return; }
    if (e.isIntersecting) {
      pill.classList.remove('show');
    } else {
      pill.classList.add('show');
      btn.textContent = e.boundingClientRect.top < 0 ? '↑ Jump to today' : '↓ Jump to today';
    }
  }, { rootMargin: '-120px 0px 0px 0px', threshold: 0 });
  jumpIO.observe(target);
}

// ---- individual game view (hash-routed: #game=<num>) -----------------------
function route() {
  const m = location.hash.match(/^#game=(\d+)/);
  if (m) openGame(+m[1]);
  else closeGame();
}

function closeGame() {
  stopGamePoll();
  const v = document.getElementById('gameView');
  if (v) v.hidden = true;
}

function stopGamePoll() {
  if (gamePollTimer) { clearInterval(gamePollTimer); gamePollTimer = null; }
}

// One match's event data, from the active source (static bundle or live API).
async function fetchGameData(num) {
  if (STATIC) return (DATA && DATA.events && DATA.events[num]) || { status: 'SCHEDULED', events: [] };
  try {
    return await (await fetch(`${BASE}api/events?match=${num}`, { cache: 'no-store' })).json();
  } catch (e) { return null; }
}

async function openGame(num) {
  const mt = MATCHES.find((m) => m.num === num);
  const view = document.getElementById('gameView');
  if (!mt || !view) return;
  stopGamePoll();
  view.hidden = false;
  view.scrollTop = 0;
  view.innerHTML =
    `<div class="g-topbar"><button class="g-back">← Back</button></div><div class="g-empty">Loading…</div>`;
  view.querySelector('.g-back').onclick = () => history.back();
  const data = (await fetchGameData(num)) || { status: 'SCHEDULED', events: [] };
  if (location.hash !== `#game=${num}`) return;
  renderGame(view, mt, data);
  // Keep the open view live: re-poll until the match is over, so new goals/cards
  // appear without leaving the screen. (Stays on whatever cadence the rest of the
  // app polls; static mode rides the data.json re-pull.)
  if (data.status !== 'FINISHED') {
    const every = STATIC ? 60000 : (DEMO ? 12000 : 30000);
    gamePollTimer = setInterval(() => refreshGameView(num), every);
  }
}

async function refreshGameView(num) {
  if (location.hash !== `#game=${num}`) { stopGamePoll(); return; }
  const view = document.getElementById('gameView');
  const mt = MATCHES.find((m) => m.num === num);
  if (!view || view.hidden || !mt) return;
  const data = await fetchGameData(num);
  if (!data || location.hash !== `#game=${num}`) return;
  // Preserve reading position: stay pinned to the bottom if you're watching the
  // live tail (new nodes slot in there); otherwise hold your scroll position.
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 60;
  const prev = view.scrollTop;
  renderGame(view, mt, data);
  view.scrollTop = nearBottom ? view.scrollHeight : prev;
  if (data.status === 'FINISHED') stopGamePoll();  // nothing more will change
}

function renderGame(view, mt, data) {
  const d = new Date(mt.kickoff_utc);
  const t1 = teamLabel(mt.team1), t2 = teamLabel(mt.team2);
  const has = data.score1 != null && data.score2 != null;
  const st = data.status;
  const live = /IN_PLAY|LIVE/.test(st), ht = st === 'PAUSED', ft = st === 'FINISHED';
  let mid, status;
  if (has && (live || ht || ft)) {
    mid = `<div class="nums">${data.score1}<span class="dash">–</span>${data.score2}</div>`;
    status = ft ? 'Full time' : ht ? 'Half time' : `Live ${data.minute || ''}'`.trim();
  } else {
    mid = `<div class="ko">${fmtTime.format(d)}</div>`;
    status = 'Upcoming';
  }
  const win1 = ft && has && data.score1 > data.score2;
  const win2 = ft && has && data.score2 > data.score1;
  const team = (t, code, w, l) =>
    `<div class="g-team${w ? ' win' : ''}${l ? ' lose' : ''}">` +
      `<span class="flag">${flagFor(code) || '<span style="color:var(--faint)">·</span>'}</span>` +
      `<span class="name${t.placeholder ? ' placeholder' : ''}">${esc(t.name)}</span></div>`;

  const evs = data.events || [];
  // For a game that's underway, cap the timeline with a pulsing red node at the
  // trailing end — it reads as "still live, more goals/cards may still come".
  const liveTail = (live || ht)
    ? `<div class="g-ev g-tail">` +
        `<div class="g-ev-c left empty"></div>` +
        `<div class="g-ev-min live">${ht ? 'HT' : (data.minute ? data.minute + "'" : '')}</div>` +
        `<div class="g-ev-c right empty"></div>` +
      `</div>`
    : '';
  const timeline = (evs.length || liveTail)
    ? evs.map(eventRow).join('') + liveTail
    : `<div class="g-empty">${ft ? 'No goals or cards' : st === 'SCHEDULED' ? 'Not started yet' : 'No events yet'}</div>`;

  view.innerHTML =
    `<div class="g-topbar"><button class="g-back">← Back</button><span class="g-stage">${esc(badgeText(mt))}</span></div>` +
    `<div class="g-head">` +
      `<div class="g-date">${fmtDow.format(d)}, ${fmtDate.format(d)} · ${fmtTime.format(d)}</div>` +
      `<div class="g-score">` +
        team(t1, mt.team1, win1, win2) +
        `<div class="g-mid">${mid}<div class="g-status${live ? ' live' : ''}">${status}</div></div>` +
        team(t2, mt.team2, win2, win1) +
      `</div>` +
      (mt.ground ? `<div class="g-venue">${esc(mt.ground)}</div>` : '') +
    `</div>` +
    `<div class="g-timeline">${timeline}</div>`;
  view.querySelector('.g-back').onclick = () => history.back();
}

function eventRow(ev) {
  const icon = ev.kind === 'goal' ? '⚽'
    : ev.kind === 'card' ? (ev.detail === 'Red Card' ? '🟥' : '🟨')
    : ev.kind === 'sub' ? '🔁'
    : '📺';  // VAR / other
  let txt = esc(ev.player || '');
  if (ev.kind === 'goal') {
    if (ev.detail === 'Penalty') txt += ' (pen)';
    else if (ev.detail === 'Own Goal') txt += ' (OG)';
    if (ev.assist) txt += ` <span class="g-assist">↳ ${esc(ev.assist)}</span>`;
  } else if (ev.kind === 'sub') {
    if (ev.assist) txt += ` <span class="g-assist">↔ ${esc(ev.assist)}</span>`;
  } else if (ev.kind !== 'card' && ev.detail) {
    txt += ` <span class="g-assist">${esc(ev.detail)}</span>`;  // e.g. VAR "Goal cancelled"
  }
  const body = `<span class="g-ev-icon">${icon}</span><span class="g-ev-txt">${txt}</span>`;
  const l = ev.side === 1 ? body : '';
  const r = ev.side === 2 ? body : '';
  return `<div class="g-ev ${ev.kind}">` +
    `<div class="g-ev-c left${l ? '' : ' empty'}">${l}</div>` +
    `<div class="g-ev-min">${ev.minute}'</div>` +
    `<div class="g-ev-c right${r ? '' : ' empty'}">${r}</div></div>`;
}

// ---- util ------------------------------------------------------------------
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  document.getElementById('filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    filter = btn.dataset.filter;
    document.querySelectorAll('#filters .chip').forEach((c) => c.classList.toggle('is-on', c === btn));
    render();
    scrollToToday(false);
  });
  document.getElementById('todayBtn').addEventListener('click', () => scrollToToday(true));
  // primary tabs (Matches | Players) + leaderboard stat sub-tabs
  document.getElementById('mainTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchMainTab(btn.dataset.tab);
  });
  document.getElementById('lbStats').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    lbStat = btn.dataset.stat;
    document.querySelectorAll('#lbStats .chip').forEach((c) => c.classList.toggle('is-on', c === btn));
    renderLeaderboard();
  });
  // tap a match card -> open its game view (hash route gives native back-button)
  document.getElementById('agenda').addEventListener('click', (e) => {
    const card = e.target.closest('.match');
    if (card && card.id.startsWith('m-')) location.hash = 'game=' + card.id.slice(2);
  });
  window.addEventListener('hashchange', route);

  // Static-publish: if a baked snapshot sits next to us, run entirely off it.
  // Absent on a live backend (404) -> fall through to the API path below.
  try {
    const r = await fetch(`${BASE}data.json`, { cache: 'no-cache' });
    if (r.ok) { DATA = await r.json(); STATIC = true; applyStaticChrome(); }
  } catch (e) { /* no snapshot -> live backend mode */ }

  try {
    let data;
    if (STATIC) {
      data = DATA.schedule || { matches: [] };
    } else {
      const r = await fetch(`${BASE}api/schedule`, { cache: 'no-cache' });
      data = await r.json();
    }
    MATCHES = (data.matches || []).slice().sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
    // brand year + host line follow the active season (dev shows 2022/Qatar)
    const yr = ((data.name || '').match(/\d{4}/) || [])[0] || '2026';
    const yrEl = document.querySelector('.brand-text .yr');
    if (yrEl) yrEl.textContent = yr;
    const host = { '2022': 'Qatar', '2026': 'Canada · Mexico · USA' }[yr];
    document.getElementById('subtitle').textContent =
      host ? `${data.count} matches · ${host}` : `${data.count} matches`;
  } catch (e) {
    document.getElementById('agenda').innerHTML =
      '<div class="loading">Could not load the schedule. Is the backend running?</div>';
    return;
  }
  await fetchScores();      // learn the (demo) clock + initial scores before layout
  render();
  scrollToToday(false);     // snaps "today" to the top; scroll up = past, down = future
  startScorePolling();
  route();                  // open a deep-linked #game=<num> if present
}

boot();
