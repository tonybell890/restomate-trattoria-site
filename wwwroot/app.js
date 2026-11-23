const MAX_PARTY = 12;
const MIN_PARTY = 1;
const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const fmtMonth = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtLong = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const el = id => document.getElementById(id);

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

/* ---------- configuration and API ---------- */

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
    if (!isGuid || /^0{8}-/.test(restaurantId)) {
        throw new Error('Imposta l\'ID del ristorante in wwwroot/config.json (campo restaurantId) oppure aggiungi ?restaurant=<id> all\'indirizzo.');
    }
    let origin;
    try {
        const url = new URL(apiBase);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
        origin = url.origin;
    } catch {
        throw new Error('Il campo apiBase in config.json non è un indirizzo valido.');
    }
    return { name: config.restaurantName || 'Trattoria da Mario', base: `${origin}/api/v1/restaurants/${restaurantId}` };
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
    if (error.status === 0) {
        return 'Impossibile contattare il servizio di prenotazione. Verifica che Restomate sia in esecuzione, che il certificato di sviluppo sia attendibile e che questo sito sia tra le origini CORS consentite.';
    }
    if (error.status === 429) return 'Troppe richieste ravvicinate. Attendi un minuto e riprova.';
    switch (error.code) {
        case 'no_availability': return 'Questo orario non è più disponibile. Scegli un altro orario.';
        case 'restaurant_not_found': return 'Ristorante non trovato o non attivo. Controlla l\'ID in config.json.';
        case 'invalid_booking_time': return 'La data o l\'orario scelti non sono prenotabili.';
        case 'invalid_party_size': return 'Il numero di persone non è valido.';
        case 'contact_required': return 'Indica almeno un\'email o un numero di telefono.';
        case 'restaurant_busy': return 'Il ristorante sta aggiornando le disponibilità. Riprova tra qualche secondo.';
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

/* ---------- helpers ---------- */

const ymd = (year, month, day) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const monthIndex = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const dayLabel = value => fmtLong.format(new Date(`${value}T12:00:00Z`));

function showStatus(message, kind = 'error') {
    const box = el('booking-status');
    box.textContent = message || '';
    box.className = message ? `status ${kind}` : 'status';
}

function showFatal(message) {
    showStatus(message, 'error');
    for (const id of ['party-minus', 'party-plus', 'cal-prev', 'cal-next', 'submit']) el(id).disabled = true;
    el('slots').textContent = '';
}

/* ---------- party size ---------- */

function renderParty() {
    el('party-value').textContent = state.party;
    el('party-label').textContent = state.party === 1 ? 'persona' : 'persone';
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

/* ---------- calendar ---------- */

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

/* ---------- slots ---------- */

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
    renderSummary();
    if (!state.date) {
        showSlotsMessage('Seleziona prima un giorno.');
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
        showSlotsMessage('Nessun orario disponibile per questo giorno e questo numero di persone. Prova un altro giorno o meno persone.');
        return;
    }
    const groups = [['Pranzo', s => !s.nextDay && Number(s.localTime.slice(0, 2)) < 16], ['Cena', s => !s.nextDay && Number(s.localTime.slice(0, 2)) >= 16], ['Dopo mezzanotte', s => s.nextDay]];
    for (const [title, test] of groups) {
        const items = state.slots.filter(test);
        if (items.length === 0) continue;
        const heading = document.createElement('h4');
        heading.textContent = title;
        const list = document.createElement('div');
        list.className = 'slot-list';
        for (const slot of items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'slot';
            button.textContent = slot.localTime;
            button.setAttribute('aria-pressed', state.slot?.startsAt === slot.startsAt ? 'true' : 'false');
            button.addEventListener('click', () => selectSlot(slot));
            list.append(button);
        }
        box.append(heading, list);
    }
}

function selectSlot(slot) {
    state.slot = slot;
    state.key = null;
    showStatus('');
    renderSlots();
    renderSummary();
}

function renderSummary() {
    const summary = el('summary');
    const ready = Boolean(state.slot && state.date);
    summary.classList.toggle('ready', ready);
    summary.classList.toggle('muted', !ready);
    summary.textContent = ready
        ? `Tavolo per ${state.party} ${state.party === 1 ? 'persona' : 'persone'}, ${dayLabel(state.date)} alle ${state.slot.localTime}`
        : 'Scegli giorno e orario per continuare.';
    el('submit').disabled = !ready || state.busy;
}

/* ---------- form ---------- */

function setFieldError(field, message) {
    const input = el(field);
    const error = el(`${field}-error`);
    error.textContent = message || '';
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
    el('submit').disabled = true;
    el('submit').textContent = 'Invio in corso…';
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
        showStatus(describe(error), 'error');
        if (error.code === 'idempotency_conflict') state.key = null;
        if (error.code === 'no_availability' || error.code === 'invalid_booking_time') {
            state.key = null;
            state.slot = null;
            renderSummary();
            await loadSlots();
        }
    } finally {
        state.busy = false;
        el('submit').textContent = 'Conferma la prenotazione';
        renderSummary();
    }
}

function showConfirmation(receipt) {
    el('c-name').textContent = el('name').value.trim();
    el('c-date').textContent = dayLabel(state.date);
    el('c-time').textContent = state.slot.localTime;
    el('c-party').textContent = `${receipt.partySize} ${receipt.partySize === 1 ? 'persona' : 'persone'}`;
    el('c-ref').textContent = String(receipt.id).slice(0, 8).toUpperCase();
    el('booking-grid').hidden = true;
    el('confirmation').hidden = false;
    showStatus('');
    state.key = null;
    el('confirmation-title').focus();
}

function resetBooking() {
    el('booking-form').reset();
    for (const field of ['name', 'email', 'phone']) setFieldError(field, '');
    state.slot = null;
    state.key = null;
    el('confirmation').hidden = true;
    el('booking-grid').hidden = false;
    renderSummary();
    if (state.date) scheduleSlots();
    el('booking-title').scrollIntoView();
}

/* ---------- start ---------- */

async function init() {
    el('party-minus').addEventListener('click', () => changeParty(-1));
    el('party-plus').addEventListener('click', () => changeParty(1));
    el('cal-prev').addEventListener('click', () => changeMonth(-1));
    el('cal-next').addEventListener('click', () => changeMonth(1));
    el('booking-form').addEventListener('submit', submit);
    el('booking-form').addEventListener('input', () => { state.key = null; });
    el('new-booking').addEventListener('click', resetBooking);
    renderParty();

    try {
        const config = await loadConfig();
        state.base = config.base;
        for (const node of document.querySelectorAll('[data-restaurant-name]')) node.textContent = config.name;
        state.info = await api('');
    } catch (error) {
        showFatal(error instanceof ApiError ? describe(error) : error.message);
        return;
    }
    for (const node of document.querySelectorAll('[data-restaurant-name]')) node.textContent = state.info.name;
    document.title = `${state.info.name} · Cucina di casa`;
    state.year = Number(state.info.today.slice(0, 4));
    state.month = Number(state.info.today.slice(5, 7)) - 1;
    renderCalendar();
    renderSummary();
}

init();
