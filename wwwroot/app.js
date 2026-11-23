const MIN_PARTY = 1;
const MAX_PARTY = 12;
const el = id => document.getElementById(id);
const LANGS = ['it', 'en'];
const LOCALES = { it: 'it-IT', en: 'en-GB' };

const state = {
    lang: 'it', base: '', info: null, party: 2, year: 0, month: 0, date: null,
    slots: [], slot: null, key: null, busy: false, loadId: 0, timer: null, controller: null,
    step: 1, category: 'starters', receipt: null, fatal: null, slotsMessage: null
};

const t = (key, vars = {}) => {
    let text = I18N[state.lang][key] ?? I18N.it[key] ?? key;
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, value);
    return text;
};
const people = n => t(n === 1 ? 'people.one' : 'people.many', { n });
const fmtMonth = () => new Intl.DateTimeFormat(LOCALES[state.lang], { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtLong = () => new Intl.DateTimeFormat(LOCALES[state.lang], { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayLabel = value => fmtLong().format(new Date(`${value}T12:00:00Z`));
const weekdays = () => {
    const base = new Date(Date.UTC(2024, 0, 1));
    return [0, 1, 2, 3, 4, 5, 6].map(i => new Intl.DateTimeFormat(LOCALES[state.lang], { weekday: 'short', timeZone: 'UTC' })
        .format(new Date(base.getTime() + i * 86400000)));
};

class ApiError extends Error {
    constructor(status, code, detail) {
        super(detail || code || 'error');
        this.status = status;
        this.code = code || '';
    }
}

/* ---------- lingua ---------- */

function applyLanguage() {
    document.documentElement.lang = state.lang;
    document.title = t('meta.title');
    el('meta-desc').setAttribute('content', t('meta.desc'));
    document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach(n => { n.innerHTML = t(n.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-attrs]').forEach(n => {
        for (const pair of n.dataset.i18nAttrs.split(';')) {
            const [attr, key] = pair.split(':');
            n.setAttribute(attr, t(key));
        }
    });
    document.querySelectorAll('#lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
    el('lang').dataset.active = state.lang;
    renderParty();
    renderMenu(state.category);
    renderGalleryLabels();
    if (state.info) renderCalendar();
    if (state.fatal) showFatal(state.fatal);
    else if (state.slotsMessage) showSlotsMessage(state.slotsMessage.key, state.slotsMessage.isError);
    else if (state.slots.length) renderSlots();
    else if (!state.date) showSlotsMessage('slots.pick');
    if (state.slot) el('chosen-text').textContent = chosenText();
    if (state.receipt) fillConfirmation();
}

function setLanguage(lang) {
    if (!LANGS.includes(lang) || lang === state.lang) return;
    state.lang = lang;
    try { localStorage.setItem('lang', lang); } catch { /* ignore */ }
    applyLanguage();
}

function detectLanguage() {
    try {
        const saved = localStorage.getItem('lang');
        if (LANGS.includes(saved)) return saved;
    } catch { /* ignore */ }
    const fromUrl = new URLSearchParams(location.search).get('lang');
    if (LANGS.includes(fromUrl)) return fromUrl;
    return (navigator.language || 'it').toLowerCase().startsWith('it') ? 'it' : 'en';
}

/* ---------- configurazione e API ---------- */

async function loadConfig() {
    let config;
    try {
        const response = await fetch('config.json', { cache: 'no-store' });
        config = await response.json();
    } catch {
        throw new ApiError(-1, 'config');
    }
    const params = new URLSearchParams(location.search);
    const restaurantId = params.get('restaurant') || config.restaurantId || '';
    const apiBase = params.get('api') || config.apiBase || '';
    const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restaurantId);
    if (!isGuid || /^0{8}-/.test(restaurantId)) throw new ApiError(-1, 'config');
    let origin;
    try {
        const url = new URL(apiBase);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
        origin = url.origin;
    } catch {
        throw new ApiError(-1, 'config');
    }
    return `${origin}/api/v1/restaurants/${restaurantId}`;
}

async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
    let response;
    try {
        response = await fetch(state.base + path, {
            method,
            signal,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined
        });
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new ApiError(0, 'network');
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new ApiError(response.status, data?.title, data?.detail);
    return data;
}

function describe(error) {
    if (error.status === -1) return t('err.config');
    if (error.status === 0) return t('err.network');
    if (error.status === 429) return t('err.429');
    const key = `err.${error.code}`;
    if (I18N.it[key]) return t(key);
    return error.status >= 500 ? t('err.server') : t('err.generic');
}

function newKey() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ---------- utilità ---------- */

const ymd = (year, month, day) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const monthIndex = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const chosenText = () => `${people(state.party)} · ${dayLabel(state.date)} · ${t('chosen.at')} ${state.slot.localTime}`;

let statusError = null;
function showStatus(error) {
    statusError = error || null;
    const box = el('status');
    box.textContent = error ? describe(error) : '';
    box.className = error ? 'status error' : 'status';
}

/* ---------- schermate della prenotazione ---------- */

function goStep(n) {
    state.step = n;
    for (const i of [1, 2, 3]) el(`step-${i}`).hidden = i !== n;
    for (const li of el('steps').children) {
        const s = Number(li.dataset.step);
        li.classList.toggle('active', s === n && n < 3);
        li.classList.toggle('done', s < n || n === 3);
    }
    showStatus(null);
    el(n === 3 ? 'step-3' : 'book-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (n === 3) el('step-3').focus({ preventScroll: true });
    if (n === 2) setTimeout(() => el('name').focus({ preventScroll: true }), 300);
}

/* ---------- persone ---------- */

function renderParty() {
    el('party-value').textContent = state.party;
    el('party-minus').disabled = state.party <= MIN_PARTY;
    el('party-plus').disabled = state.party >= MAX_PARTY;
}

function changeParty(delta) {
    const next = Math.min(MAX_PARTY, Math.max(MIN_PARTY, state.party + delta));
    if (next === state.party) return;
    state.party = next;
    renderParty();
    scheduleSlots();
}

/* ---------- calendario ---------- */

function renderCalendar() {
    const grid = el('calendar-grid');
    grid.replaceChildren();
    for (const name of weekdays()) {
        const head = document.createElement('div');
        head.className = 'cal-head';
        head.textContent = name;
        grid.append(head);
    }
    const offset = (new Date(Date.UTC(state.year, state.month, 1)).getUTCDay() + 6) % 7;
    for (let i = 0; i < offset; i++) grid.append(document.createElement('div'));
    const days = new Date(Date.UTC(state.year, state.month + 1, 0)).getUTCDate();
    for (let day = 1; day <= days; day++) {
        const value = ymd(state.year, state.month, day);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cal-day';
        button.textContent = day;
        button.disabled = value < state.info.today || value > state.info.lastBookableDate;
        button.setAttribute('aria-label', dayLabel(value));
        button.setAttribute('aria-pressed', value === state.date ? 'true' : 'false');
        if (value === state.info.today) button.classList.add('today');
        if (value === state.date) button.classList.add('selected');
        button.addEventListener('click', () => selectDate(value));
        grid.append(button);
    }
    el('cal-title').textContent = fmtMonth().format(new Date(Date.UTC(state.year, state.month, 1)));
    const current = state.year * 12 + state.month;
    el('cal-prev').disabled = current <= monthIndex(state.info.today);
    el('cal-next').disabled = current >= monthIndex(state.info.lastBookableDate);
}

function changeMonth(delta) {
    const index = state.year * 12 + state.month + delta;
    state.year = Math.floor(index / 12);
    state.month = index % 12;
    renderCalendar();
}

function selectDate(value) {
    state.date = value;
    renderCalendar();
    scheduleSlots();
}

/* ---------- orari ---------- */

function showSlotsMessage(key, isError = false) {
    state.slotsMessage = { key, isError };
    const box = el('slots');
    box.replaceChildren();
    const p = document.createElement('p');
    p.className = isError ? 'field-error' : 'muted';
    p.textContent = isError && typeof key === 'object' ? describe(key) : t(key);
    box.append(p);
}

function scheduleSlots() {
    clearTimeout(state.timer);
    state.controller?.abort();
    state.loadId++;
    state.slot = null;
    state.key = null;
    state.slots = [];
    if (!state.date) {
        showSlotsMessage('slots.pick');
        return;
    }
    showSlotsMessage('slots.searching');
    state.timer = setTimeout(loadSlots, 250);
}

async function loadSlots() {
    state.controller?.abort();
    state.controller = new AbortController();
    const id = ++state.loadId;
    try {
        const result = await api(`/availability/slots?date=${state.date}&partySize=${state.party}`, { signal: state.controller.signal });
        if (id !== state.loadId) return;
        state.slots = result.slots;
        renderSlots();
    } catch (error) {
        if (error.name === 'AbortError' || id !== state.loadId) return;
        state.slots = [];
        showSlotsMessage(error, true);
    }
}

function renderSlots() {
    const box = el('slots');
    box.replaceChildren();
    state.slotsMessage = null;
    if (state.slots.length === 0) {
        showSlotsMessage('slots.none');
        return;
    }
    const groups = [
        ['slots.lunch', s => !s.nextDay && Number(s.localTime.slice(0, 2)) < 16],
        ['slots.dinner', s => !s.nextDay && Number(s.localTime.slice(0, 2)) >= 16],
        ['slots.late', s => s.nextDay]
    ];
    for (const [title, test] of groups) {
        const items = state.slots.filter(test);
        if (items.length === 0) continue;
        const wrap = document.createElement('div');
        wrap.className = 'slots-group';
        const heading = document.createElement('h4');
        heading.textContent = t(title);
        const list = document.createElement('div');
        list.className = 'slot-list';
        for (const slot of items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'slot';
            button.textContent = slot.localTime;
            button.addEventListener('click', () => selectSlot(slot));
            list.append(button);
        }
        wrap.append(heading, list);
        box.append(wrap);
    }
}

function selectSlot(slot) {
    state.slot = slot;
    state.key = null;
    el('chosen-text').textContent = chosenText();
    goStep(2);
}

/* ---------- modulo ---------- */

function setFieldError(field, key) {
    const input = el(field);
    el(`${field}-error`).textContent = key ? t(key) : '';
    if (key) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}

function validate() {
    const name = el('name').value.trim();
    const email = el('email').value.trim();
    const phone = el('phone').value.trim();
    const errors = {};
    if (!name) errors.name = 'val.name';
    if (email && !el('email').checkValidity()) errors.email = 'val.email';
    if (!email && !phone) errors.phone = 'val.contact';
    for (const field of ['name', 'email', 'phone']) setFieldError(field, errors[field]);
    const first = ['name', 'email', 'phone'].find(field => errors[field]);
    if (first) el(first).focus();
    return Object.keys(errors).length === 0;
}

async function submit(event) {
    event.preventDefault();
    if (state.busy || !state.slot) return;
    showStatus(null);
    if (!validate()) return;
    state.busy = true;
    const button = el('submit');
    button.disabled = true;
    button.textContent = t('form.sending');
    state.key ??= newKey();
    const email = el('email').value.trim();
    const phone = el('phone').value.trim();
    const body = { startsAt: state.slot.startsAt, partySize: state.party, name: el('name').value.trim() };
    if (email) body.email = email;
    if (phone) body.phone = phone;
    try {
        const receipt = await api('/reservations', { method: 'POST', headers: { 'Idempotency-Key': state.key }, body });
        state.receipt = receipt;
        fillConfirmation();
        goStep(3);
    } catch (error) {
        showStatus(error);
        if (error.code === 'idempotency_conflict') state.key = null;
        if (error.code === 'no_availability' || error.code === 'invalid_booking_time') {
            state.key = null;
            state.slot = null;
            goStep(1);
            showStatus(error);
            await loadSlots();
        }
    } finally {
        state.busy = false;
        button.disabled = false;
        button.textContent = t('form.submit');
    }
}

function fillConfirmation() {
    el('c-date').textContent = dayLabel(state.date);
    el('c-time').textContent = state.slot.localTime;
    el('c-party').textContent = people(state.receipt.partySize);
    el('c-ref').textContent = String(state.receipt.id).slice(0, 8).toUpperCase();
}

function showFatal(error) {
    state.fatal = error;
    for (const id of ['party-minus', 'party-plus', 'cal-prev', 'cal-next']) el(id).disabled = true;
    const box = el('slots');
    box.replaceChildren();
    const p = document.createElement('p');
    p.className = 'field-error';
    p.textContent = describe(error);
    box.append(p);
}

/* ---------- menu, galleria, navigazione ---------- */

function renderMenu(category) {
    state.category = category;
    const tabs = el('menu-tabs');
    if (!tabs.children.length) {
        for (const key of Object.keys(MENU)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'tab';
            button.setAttribute('role', 'tab');
            button.dataset.cat = key;
            button.addEventListener('click', () => renderMenu(key));
            tabs.append(button);
        }
    }
    for (const tab of tabs.children) {
        tab.textContent = t(`cat.${tab.dataset.cat}`);
        tab.setAttribute('aria-selected', tab.dataset.cat === category ? 'true' : 'false');
    }
    const panel = el('menu-panel');
    panel.replaceChildren();
    const en = state.lang === 'en' ? 1 : 0;
    for (const item of MENU[category]) {
        const dish = document.createElement('div');
        dish.className = 'dish';
        const top = document.createElement('div');
        top.className = 'dish-top';
        const n = document.createElement('span');
        n.textContent = item[en];
        const p = document.createElement('span');
        p.textContent = item[4] === '-' ? '' : `€ ${item[4]}`;
        top.append(n, p);
        const d = document.createElement('p');
        d.textContent = item[2 + en];
        dish.append(top, d);
        panel.append(dish);
    }
}

function renderGalleryLabels() {
    el('gallery').querySelectorAll('.g').forEach((b, i) => b.setAttribute('aria-label', t('gal.open', { n: i + 1 })));
}

function initGallery() {
    const gallery = el('gallery');
    const box = el('lightbox');
    for (let i = 1; i <= 6; i++) {
        const src = `img/gallery-${i}.jpg`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'g';
        button.style.backgroundImage = `url(${src}), linear-gradient(135deg,#6b3a1d,#2a170b)`;
        button.addEventListener('click', () => {
            el('lb-img').style.backgroundImage = `url(${src})`;
            box.showModal();
        });
        gallery.append(button);
    }
    el('lb-close').addEventListener('click', () => box.close());
    box.addEventListener('click', event => { if (event.target === box) box.close(); });
}

function initPage() {
    const header = document.querySelector('.site-header');
    const hero = document.querySelector('[data-parallax]');
    const onScroll = () => {
        header.classList.toggle('solid', window.scrollY > 40);
        if (hero && window.scrollY < window.innerHeight) hero.style.transform = `translateY(${window.scrollY * 0.25}px)`;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    const toggle = el('nav-toggle');
    const nav = el('nav');
    toggle.addEventListener('click', () => {
        const open = nav.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', event => {
        if (event.target.closest('a')) {
            nav.classList.remove('open');
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
    document.querySelectorAll('#lang button').forEach(b => b.addEventListener('click', () => setLanguage(b.dataset.lang)));
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); }
        }
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(node => observer.observe(node));
}

/* ---------- avvio ---------- */

async function init() {
    state.lang = detectLanguage();
    initPage();
    initGallery();
    el('party-minus').addEventListener('click', () => changeParty(-1));
    el('party-plus').addEventListener('click', () => changeParty(1));
    el('cal-prev').addEventListener('click', () => changeMonth(-1));
    el('cal-next').addEventListener('click', () => changeMonth(1));
    el('step-2').addEventListener('submit', submit);
    el('back').addEventListener('click', () => goStep(1));
    applyLanguage();
    try {
        state.base = await loadConfig();
        state.info = await api('');
        const [y, m] = state.info.today.split('-').map(Number);
        state.year = y;
        state.month = m - 1;
        renderCalendar();
    } catch (error) {
        showFatal(error instanceof ApiError ? error : new ApiError(-1, 'config'));
    }
}

init();
