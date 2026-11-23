const MIN_PARTY = 1;
const MAX_PARTY = 12;
const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const fmtMonth = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtLong = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const el = id => document.getElementById(id);

/* Contenuti segnaposto: sostituire con il menu reale dell'osteria. */
const MENU = {
    Antipasti: [
        ['Parmigiana di melanzane', 'Come da tradizione campana', '9'],
        ['Frittura di paranza', 'Pescato del giorno, limone', '12'],
        ['Tagliere di salumi e formaggi', 'Prodotti del territorio', '14'],
        ['Alici marinate', 'Olio, aglio e prezzemolo', '10']
    ],
    Primi: [
        ['Scialatielli ai frutti di mare', 'Pasta fresca fatta in casa', '16'],
        ['Paccheri al ragù napoletano', 'Cottura lenta di ore', '13'],
        ['Spaghetti alle vongole', 'Vongole veraci, pomodorino', '15'],
        ['Ravioli di ricotta e limone', 'Burro e salvia', '13']
    ],
    Secondi: [
        ['Pesce del giorno all\'acqua pazza', 'Pomodorini e basilico', '20'],
        ['Polpo alla Luciana', 'Tenero, in umido', '18'],
        ['Tagliata di manzo', 'Rucola e scaglie di grana', '19'],
        ['Provola alla brace', 'Con verdure di stagione', '12']
    ],
    Dolci: [
        ['Delizia al limone', 'Dolce tipico della costiera', '6'],
        ['Babà al rum', 'Con crema chantilly', '6'],
        ['Pastiera', 'Ricetta di famiglia', '6'],
        ['Sorbetto al limone', 'Fatto in casa', '5']
    ],
    Vini: [
        ['Falanghina del Sannio', 'Calice', '5'],
        ['Fiano di Avellino', 'Calice', '6'],
        ['Aglianico', 'Calice', '6'],
        ['Cantina campana', 'Chiedi la carta dei vini', '-']
    ]
};

const state = {
    base: '', info: null, party: 2, year: 0, month: 0, date: null,
    slots: [], slot: null, key: null, busy: false, loadId: 0, timer: null, controller: null
};

class ApiError extends Error {
    constructor(status, code, detail) {
        super(detail || code || 'error');
        this.status = status;
        this.code = code || '';
    }
}

/* ---------- configurazione e API ---------- */

async function loadConfig() {
    let config;
    try {
        const response = await fetch('config.json', { cache: 'no-store' });
        config = await response.json();
    } catch {
        throw new Error('Impossibile leggere config.json.');
    }
    const params = new URLSearchParams(location.search);
    const restaurantId = params.get('restaurant') || config.restaurantId || '';
    const apiBase = params.get('api') || config.apiBase || '';
    const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restaurantId);
    if (!isGuid || /^0{8}-/.test(restaurantId)) throw new Error('Prenotazioni non ancora configurate.');
    let origin;
    try {
        const url = new URL(apiBase);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
        origin = url.origin;
    } catch {
        throw new Error('Prenotazioni non ancora configurate.');
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
    if (error.status === 0) return 'Impossibile contattare il servizio di prenotazione. Riprova tra poco.';
    if (error.status === 429) return 'Troppe richieste ravvicinate. Attendi un minuto e riprova.';
    switch (error.code) {
        case 'no_availability': return 'Questo orario non è più disponibile. Scegline un altro.';
        case 'restaurant_not_found': return 'Ristorante non trovato o non attivo.';
        case 'invalid_booking_time': return 'La data o l\'orario scelti non sono prenotabili.';
        case 'invalid_party_size': return 'Il numero di persone non è valido.';
        case 'contact_required': return 'Indica almeno un\'email o un numero di telefono.';
        case 'restaurant_busy': return 'Stiamo aggiornando le disponibilità. Riprova tra qualche secondo.';
        case 'idempotency_conflict': return 'La richiesta non è valida. Ricarica la pagina e riprova.';
        default: return error.status >= 500
            ? 'Si è verificato un errore del servizio. Riprova più tardi.'
            : 'Richiesta non valida. Controlla i dati inseriti.';
    }
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
const dayLabel = value => fmtLong.format(new Date(`${value}T12:00:00Z`));
const people = n => `${n} ${n === 1 ? 'persona' : 'persone'}`;

function showStatus(message) {
    const box = el('status');
    box.textContent = message || '';
    box.className = message ? 'status error' : 'status';
}

/* ---------- schermate della prenotazione ---------- */

function goStep(n) {
    for (const i of [1, 2, 3]) el(`step-${i}`).hidden = i !== n;
    for (const li of el('steps').children) {
        const s = Number(li.dataset.step);
        li.classList.toggle('active', s === n);
        li.classList.toggle('done', s < n);
    }
    showStatus('');
    const target = n === 3 ? el('step-3') : el('book-title');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    for (const name of WEEKDAYS) {
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
    el('cal-title').textContent = fmtMonth.format(new Date(Date.UTC(state.year, state.month, 1)));
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

function showSlotsMessage(message, isError = false) {
    const box = el('slots');
    box.replaceChildren();
    const p = document.createElement('p');
    p.className = isError ? 'field-error' : 'muted';
    p.textContent = message;
    box.append(p);
}

function scheduleSlots() {
    clearTimeout(state.timer);
    state.controller?.abort();
    state.loadId++;
    state.slot = null;
    state.key = null;
    if (!state.date) {
        showSlotsMessage('Seleziona un giorno per vedere gli orari.');
        return;
    }
    showSlotsMessage('Cerco gli orari disponibili…');
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
        showSlotsMessage(describe(error), true);
    }
}

function renderSlots() {
    const box = el('slots');
    box.replaceChildren();
    if (state.slots.length === 0) {
        showSlotsMessage('Nessun orario disponibile per questo giorno e questo numero di persone. Prova un altro giorno.');
        return;
    }
    const groups = [
        ['Pranzo', s => !s.nextDay && Number(s.localTime.slice(0, 2)) < 16],
        ['Cena', s => !s.nextDay && Number(s.localTime.slice(0, 2)) >= 16],
        ['Dopo mezzanotte', s => s.nextDay]
    ];
    for (const [title, test] of groups) {
        const items = state.slots.filter(test);
        if (items.length === 0) continue;
        const wrap = document.createElement('div');
        wrap.className = 'slots-group';
        const heading = document.createElement('h4');
        heading.textContent = title;
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
    el('chosen-text').textContent = `${people(state.party)} · ${dayLabel(state.date)} · ore ${slot.localTime}`;
    goStep(2);
}

/* ---------- modulo ---------- */

function setFieldError(field, message) {
    const input = el(field);
    el(`${field}-error`).textContent = message || '';
    if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}

function validate() {
    const name = el('name').value.trim();
    const email = el('email').value.trim();
    const phone = el('phone').value.trim();
    const errors = {};
    if (!name) errors.name = 'Inserisci il tuo nome.';
    if (email && !el('email').checkValidity()) errors.email = 'Inserisci un indirizzo email valido.';
    if (!email && !phone) errors.phone = 'Indica almeno un\'email o un numero di telefono.';
    for (const field of ['name', 'email', 'phone']) setFieldError(field, errors[field]);
    const first = ['name', 'email', 'phone'].find(field => errors[field]);
    if (first) el(first).focus();
    return Object.keys(errors).length === 0;
}

async function submit(event) {
    event.preventDefault();
    if (state.busy || !state.slot) return;
    showStatus('');
    if (!validate()) return;
    state.busy = true;
    const button = el('submit');
    button.disabled = true;
    button.textContent = 'Invio in corso…';
    state.key ??= newKey();
    const email = el('email').value.trim();
    const phone = el('phone').value.trim();
    const body = { startsAt: state.slot.startsAt, partySize: state.party, name: el('name').value.trim() };
    if (email) body.email = email;
    if (phone) body.phone = phone;
    try {
        const receipt = await api('/reservations', { method: 'POST', headers: { 'Idempotency-Key': state.key }, body });
        showConfirmation(receipt);
    } catch (error) {
        showStatus(describe(error));
        if (error.code === 'idempotency_conflict') state.key = null;
        if (error.code === 'no_availability' || error.code === 'invalid_booking_time') {
            state.key = null;
            state.slot = null;
            goStep(1);
            showStatus(describe(error));
            await loadSlots();
        }
    } finally {
        state.busy = false;
        button.disabled = false;
        button.textContent = 'Conferma la prenotazione';
    }
}

function showConfirmation(receipt) {
    el('c-date').textContent = dayLabel(state.date);
    el('c-time').textContent = state.slot.localTime;
    el('c-party').textContent = people(receipt.partySize);
    el('c-ref').textContent = String(receipt.id).slice(0, 8).toUpperCase();
    goStep(3);
}

function restart() {
    el('step-2').reset();
    for (const f of ['name', 'email', 'phone']) setFieldError(f, '');
    state.slot = null;
    state.key = null;
    scheduleSlots();
    goStep(1);
}

function showFatal(message) {
    for (const id of ['party-minus', 'party-plus', 'cal-prev', 'cal-next']) el(id).disabled = true;
    showSlotsMessage(message, true);
}

/* ---------- menu, galleria, navigazione ---------- */

function renderMenu(category) {
    for (const tab of el('menu-tabs').children) tab.setAttribute('aria-selected', tab.dataset.cat === category ? 'true' : 'false');
    const panel = el('menu-panel');
    panel.replaceChildren();
    for (const [name, description, price] of MENU[category]) {
        const dish = document.createElement('div');
        dish.className = 'dish';
        const top = document.createElement('div');
        top.className = 'dish-top';
        const n = document.createElement('span');
        n.textContent = name;
        const p = document.createElement('span');
        p.textContent = price === '-' ? '' : `€ ${price}`;
        top.append(n, p);
        const d = document.createElement('p');
        d.textContent = description;
        dish.append(top, d);
        panel.append(dish);
    }
}

function initMenu() {
    const tabs = el('menu-tabs');
    for (const category of Object.keys(MENU)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tab';
        button.setAttribute('role', 'tab');
        button.dataset.cat = category;
        button.textContent = category;
        button.addEventListener('click', () => renderMenu(category));
        tabs.append(button);
    }
    renderMenu(Object.keys(MENU)[0]);
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
        button.setAttribute('aria-label', `Apri foto ${i}`);
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
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); }
        }
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(node => observer.observe(node));
}

/* ---------- avvio ---------- */

async function init() {
    initPage();
    initMenu();
    initGallery();
    el('party-minus').addEventListener('click', () => changeParty(-1));
    el('party-plus').addEventListener('click', () => changeParty(1));
    el('cal-prev').addEventListener('click', () => changeMonth(-1));
    el('cal-next').addEventListener('click', () => changeMonth(1));
    el('step-2').addEventListener('submit', submit);
    el('back').addEventListener('click', () => goStep(1));
    el('again').addEventListener('click', restart);
    renderParty();
    try {
        state.base = await loadConfig();
        state.info = await api('');
        const [y, m] = state.info.today.split('-').map(Number);
        state.year = y;
        state.month = m - 1;
        renderCalendar();
    } catch (error) {
        showFatal(error instanceof ApiError ? describe(error) : error.message);
    }
}

init();
