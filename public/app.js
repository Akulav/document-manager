// Importat direct (fără import map), ca politica CSP să poată interzice orice script inline.
import { createApp, reactive } from '/vendor/vue.js';

// ---------- stare comună ----------
const store = reactive({
  ready: false,
  me: null,
  units: [],
  users: [],
  categories: [],
  docs: [],
  docsLoaded: false,
  toast: null,
  dialog: null,
  route: location.hash.slice(1) || 'documente',
});
window.addEventListener('hashchange', () => (store.route = location.hash.slice(1) || 'documente'));

// La ieșire (sau la expirarea sesiunii) datele contului anterior dispar imediat din pagină,
// ca următoarea persoană care se autentifică pe același calculator să nu le vadă nici o clipă.
function clearSession() {
  store.me = null;
  store.units = [];
  store.users = [];
  store.categories = [];
  store.docs = [];
  store.docsLoaded = false;
  store.dialog = null;
}

let toastTimer;
function toast(msg, err = false) {
  store.toast = { msg, err };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (store.toast = null), err ? 6000 : 2800);
}

// Fereastră de confirmare / întrebare în stilul aplicației (în locul confirm/prompt/alert ale browserului).
// Întoarce true/false sau, cu `input: true`, textul introdus (null la anulare).
function ask(opts) {
  return new Promise((resolve) => {
    if (store.dialog) store.dialog.resolve(opts.input ? null : false);
    store.dialog = { title: 'Confirmare', okLabel: 'Confirmă', value: '', ...opts, resolve };
  });
}

async function api(url, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
  if (opts.form) init.body = opts.form;
  else if (opts.raw) {
    init.headers['Content-Type'] = 'application/octet-stream';
    init.body = opts.raw;
  } else if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let r;
  try {
    r = await fetch(url, init);
  } catch {
    throw new Error('Serverul nu răspunde. Verificați conexiunea la rețea și reîncercați.');
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401 && store.me) {
      clearSession();
      toast('Sesiunea a expirat. Autentificați-vă din nou.', true);
    }
    throw new Error((data && data.error) || (r.status >= 500 ? 'Eroare internă de server.' : 'Cererea nu a putut fi procesată.'));
  }
  return data;
}

// Rulează o acțiune și afișează rezultatul; întoarce true la succes.
async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

async function loadShared() {
  const [dir, cats] = await Promise.all([api('/api/directory'), api('/api/categories')]);
  store.units = dir.units;
  store.users = dir.users;
  store.categories = cats;
}
async function loadDocs() {
  store.docs = await api('/api/documents');
  store.docsLoaded = true;
}
const inboxCount = () => store.docs.filter((d) => d.unseen || d.mySign === 'pending').length;
// Notificările se actualizează singure, fără reîncărcarea paginii.
setInterval(() => {
  if (store.me && !store.me.must_change && !document.hidden) loadDocs().catch(() => {});
}, 60000);

async function loadSession() {
  let me = null;
  try {
    me = await api('/api/me');
  } catch {}
  if (!me || me.must_change) clearSession();
  if (me && !me.must_change) {
    try {
      await Promise.all([loadShared(), loadDocs()]);
    } catch (e) {
      toast(e.message, true);
    }
  }
  store.me = me;
  store.ready = true;
}

// ---------- utilitare ----------
const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const ROLES = { admin: 'Administrator', editor: 'Editor', user: 'Angajat' };
const isAdmin = () => store.me && store.me.role === 'admin';
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
// Culoare stabilă pentru avatar, derivată din nume (aceeași persoană are mereu aceeași culoare).
const AVATAR_COLORS = ['#1d4e89', '#0f766e', '#9a3412', '#6d28d9', '#b45309', '#0e7490', '#be123c', '#4d7c0f'];
const avatarStyle = (name) => {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { background: AVATAR_COLORS[h % AVATAR_COLORS.length] };
};

function childUnits(parentId) {
  const ids = new Set(store.units.map((u) => u.id));
  // subdiviziunile fără părinte valid sunt tratate ca rădăcini
  return store.units.filter((u) => (parentId === null ? u.parent_id === null || !ids.has(u.parent_id) : u.parent_id === parentId));
}
function flatUnits() {
  const out = [];
  const walk = (parentId, depth) => {
    for (const u of childUnits(parentId)) {
      out.push({ ...u, depth, label: '   '.repeat(depth) + u.name });
      walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
const unitName = (id) => (store.units.find((u) => u.id === id) || {}).name || '—';
function tagIndex() {
  const map = new Map();
  for (const c of store.categories) for (const t of c.tags) map.set(t.id, { ...t, color: c.color, category: c.name });
  return map;
}
const chipStyle = (color) => ({ color, borderColor: color, background: color + '14' });

// ---------- componente de bază ----------
// Ferestrele deschise, în ordine; Escape o închide doar pe cea de deasupra.
const modalStack = [];
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) {
    e.preventDefault();
    modalStack[modalStack.length - 1].cancel();
  }
});

const Modal = {
  props: {
    title: String,
    wide: Boolean,
    xl: Boolean,
    busy: Boolean,
    danger: Boolean,
    okLabel: { type: String, default: 'Salvează' },
    busyLabel: { type: String, default: 'Se salvează…' },
    cancelLabel: { type: String, default: 'Anulează' },
  },
  emits: ['close', 'submit'],
  methods: {
    // în timpul salvării fereastra rămâne deschisă, ca utilizatorul să vadă rezultatul
    cancel() {
      if (!this.busy) this.$emit('close');
    },
  },
  mounted() {
    modalStack.push(this);
    this.lastFocus = document.activeElement;
    const el =
      this.$el.querySelector('[autofocus]') ||
      this.$el.querySelector('.modal-body input:not([type=hidden]):not([type=checkbox]):not([type=radio]), .modal-body select, .modal-body textarea') ||
      this.$el.querySelector('.modal-foot .btn:last-child');
    if (el) el.focus();
  },
  unmounted() {
    const i = modalStack.indexOf(this);
    if (i >= 0) modalStack.splice(i, 1);
    if (this.lastFocus && document.contains(this.lastFocus)) this.lastFocus.focus();
  },
  template: /*html*/ `
    <div class="overlay" @mousedown.self="cancel">
      <form class="modal" :class="{ wide, xl }" role="dialog" aria-modal="true" :aria-label="title" @submit.prevent="busy || $emit('submit')">
        <div class="modal-head"><h2>{{ title }}</h2><button type="button" class="x" @click="cancel" aria-label="Închide">×</button></div>
        <div class="modal-body"><slot /></div>
        <div class="modal-foot">
          <button v-if="cancelLabel" type="button" class="btn" :disabled="busy" @click="cancel">{{ cancelLabel }}</button>
          <button class="btn" :class="danger ? 'danger-solid' : 'primary'" :disabled="busy">{{ busy ? busyLabel : okLabel }}</button>
        </div>
      </form>
    </div>`,
};

const DialogHost = {
  components: { Modal },
  computed: { d: () => store.dialog },
  methods: {
    close(result) {
      const d = store.dialog;
      store.dialog = null;
      if (d) d.resolve(result);
    },
    ok() {
      if (!this.d.input) return this.close(true);
      const v = this.d.value.trim();
      if (v) this.close(v);
    },
  },
  template: /*html*/ `
    <Modal v-if="d" :title="d.title" :ok-label="d.okLabel" :cancel-label="d.cancelLabel === undefined ? 'Anulează' : d.cancelLabel" :danger="d.danger" @close="close(d.input ? null : false)" @submit="ok">
      <p v-if="d.message" class="dialog-msg">{{ d.message }}</p>
      <label v-if="d.input" class="field"><span>{{ d.label }}</span><input v-model="d.value" :maxlength="d.maxlength || 200" required autofocus /></label>
    </Modal>`,
};

const Brand = {
  template: /*html*/ `<div class="brand"><img class="brand-logo" src="/favicon.svg" alt="" width="30" height="30" /><span>e-Management <span class="brand-mark">ANSC</span></span></div>`,
};

const Login = {
  components: { Brand },
  data: () => ({ username: '', password: '', error: '', busy: false }),
  methods: {
    async submit() {
      this.busy = true;
      this.error = '';
      try {
        await api('/api/login', { method: 'POST', body: { username: this.username, password: this.password } });
        await loadSession();
      } catch (e) {
        this.error = e.message;
      }
      this.busy = false;
    },
  },
  template: /*html*/ `
    <div class="login-wrap">
      <form class="login" @submit.prevent="submit">
        <Brand />
        <h1>Autentificare</h1>
        <p class="muted small login-sub">Agenția Națională pentru Soluționarea Contestațiilor</p>
        <div v-if="error" class="error" role="alert">{{ error }}</div>
        <label class="field"><span>Utilizator</span><input v-model="username" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus required /></label>
        <label class="field"><span>Parolă</span><input v-model="password" type="password" autocomplete="current-password" required /></label>
        <button class="btn primary block" :disabled="busy">{{ busy ? 'Se verifică…' : 'Intră în sistem' }}</button>
      </form>
    </div>`,
};

const PasswordFields = {
  props: { modelValue: Object },
  template: /*html*/ `
    <label class="field"><span>Parola curentă</span><input v-model="modelValue.current" type="password" autocomplete="current-password" required /></label>
    <label class="field"><span>Parola nouă (cel puțin 10 caractere)</span><input v-model="modelValue.next" type="password" autocomplete="new-password" minlength="10" required /></label>
    <label class="field"><span>Repetați parola nouă</span><input v-model="modelValue.again" type="password" autocomplete="new-password" required /></label>`,
};
async function changePassword(f) {
  if (f.next !== f.again) {
    toast('Parolele noi nu coincid.', true);
    return false;
  }
  return run(() => api('/api/password', { method: 'POST', body: { current: f.current, next: f.next } }), 'Parola a fost schimbată.');
}

const ForcedPassword = {
  components: { Brand, PasswordFields },
  data: () => ({ f: { current: '', next: '', again: '' }, busy: false }),
  methods: {
    async submit() {
      this.busy = true;
      if (await changePassword(this.f)) await loadSession();
      this.busy = false;
    },
    async logout() {
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      clearSession();
    },
  },
  template: /*html*/ `
    <div class="login-wrap">
      <form class="login" @submit.prevent="submit">
        <Brand />
        <h1>Setați o parolă nouă</h1>
        <p class="muted small login-sub">Înainte de a continua, schimbați parola primită de la administrator.</p>
        <PasswordFields v-model="f" />
        <button class="btn primary block" :disabled="busy">{{ busy ? 'Se salvează…' : 'Salvează parola' }}</button>
        <button type="button" class="btn link block login-alt" @click="logout">Ieșire</button>
      </form>
    </div>`,
};

// ---------- documente ----------
const docDay = (d) => Number(d.doc_date.slice(8));
const docMon = (d) => MONTHS[Number(d.doc_date.slice(5, 7)) - 1].slice(0, 3) + ' ' + d.doc_date.slice(0, 4);
function visLabel(d) {
  if (d.visibility === 'all') return 'Toți angajații';
  const names = [...d.unitIds.map(unitName), ...d.userIds.map((id) => (store.users.find((u) => u.id === id) || {}).full_name || '—')];
  return names.length ? 'Vizibil pentru: ' + names.join(', ') : d.signers.length ? 'Privat (autor, semnatari și administratori)' : 'Privat (autor și administratori)';
}
// Textul de avertizare când notificarea prin e-mail nu a ajuns la toți semnatarii ('' = totul în regulă).
function mailNote(m) {
  if (!m) return '';
  if (m.disabled) return 'E-mailul nu este configurat în Setări: semnatarii văd solicitarea doar în Notificări.';
  const parts = [];
  if (m.noEmail.length) parts.push('fără adresă de e-mail: ' + m.noEmail.join(', '));
  if (m.failed.length) parts.push('trimitere eșuată: ' + m.failed.join(', '));
  return parts.length ? 'E-mail netrimis — ' + parts.join('; ') : '';
}

const DocForm = {
  components: { Modal },
  props: { doc: Object },
  emits: ['close', 'saved'],
  data() {
    const d = this.doc;
    return {
      busy: false,
      dragging: false,
      userFilter: '',
      signFilter: '',
      newFiles: [],
      needsSign: d ? d.signers.length > 0 : false,
      form: {
        title: d ? d.title : '',
        number: d ? d.number : '',
        doc_date: d ? d.doc_date : today(),
        description: d ? d.description : '',
        visibility: d ? d.visibility : 'all',
        tagIds: d ? [...d.tagIds] : [],
        unitIds: d ? [...d.unitIds] : [],
        userIds: d ? [...d.userIds] : [],
        signerIds: d ? d.signers.map((s) => s.id) : [],
        removeFileIds: [],
      },
    };
  },
  computed: {
    store: () => store,
    units: () => flatUnits(),
    people() {
      return this.match(this.userFilter, this.form.userIds);
    },
    signCandidates() {
      const q = this.signFilter.trim().toLowerCase();
      return store.users.filter((u) => !this.form.signerIds.includes(u.id) && (!q || u.full_name.toLowerCase().includes(q)));
    },
    // versiunile semnate fac parte din lanțul de semnare și nu se pot elimina de aici
    keptFiles() {
      return this.doc ? this.doc.files.filter((f) => !f.signed_by_name && !this.form.removeFileIds.includes(f.id)) : [];
    },
    mailHint() {
      return store.me.mailEnabled
        ? 'Persoana aflată la rând primește un e-mail și o notificare în aplicație. Semnatarii văd documentul indiferent de setările de vizibilitate.'
        : 'E-mailul nu este configurat (administratorul îl setează în pagina „Setări”): semnatarii vor fi anunțați doar în aplicație.';
    },
  },
  methods: {
    fmtSize,
    match(filter, selected) {
      const q = filter.trim().toLowerCase();
      return store.users.filter((u) => !q || u.full_name.toLowerCase().includes(q) || selected.includes(u.id));
    },
    toggle(list, id) {
      const i = list.indexOf(id);
      if (i < 0) list.push(id);
      else list.splice(i, 1);
    },
    personName(id) {
      const u = store.users.find((x) => x.id === id) || (this.doc && this.doc.signers.find((s) => s.id === id));
      return u ? u.full_name || u.name : '—';
    },
    hasSigned(id) {
      return !!this.doc && this.doc.signers.some((s) => s.id === id && s.signed_at);
    },
    // un semnatar cu contul dezactivat nu mai poate semna: lanțul rămâne blocat până este eliminat
    inactive(id) {
      const s = this.doc && this.doc.signers.find((x) => x.id === id);
      return !!s && !s.active && !s.signed_at;
    },
    dragLeave(e) {
      if (!e.currentTarget.contains(e.relatedTarget)) this.dragging = false;
    },
    move(i, step) {
      const list = this.form.signerIds;
      list.splice(i + step, 0, list.splice(i, 1)[0]);
    },
    tagStyle(c, t) {
      return this.form.tagIds.includes(t.id) ? { background: c.color, borderColor: c.color } : { borderColor: c.color, color: c.color };
    },
    // Fișierele se adună la fiecare alegere, deci se pot adăuga pe rând .docx, .pdf etc.
    addFiles(list) {
      for (const f of list) {
        if (this.newFiles.some((x) => x.name === f.name && x.size === f.size)) continue;
        if (this.newFiles.length >= 10) return toast('Cel mult 10 fișiere noi la o salvare.', true);
        if (f.size > 50 * 1024 * 1024) toast('„' + f.name + '” depășește 50 MB.', true);
        else this.newFiles.push(f);
      }
    },
    drop(e) {
      this.dragging = false;
      this.addFiles(e.dataTransfer.files);
    },
    async submit() {
      const fd = new FormData();
      fd.append('data', JSON.stringify({ ...this.form, signerIds: this.needsSign ? this.form.signerIds : [] }));
      for (const f of this.newFiles) fd.append('files', f);
      this.busy = true;
      try {
        const r = await api(this.doc ? '/api/documents/' + this.doc.id : '/api/documents', { method: this.doc ? 'PUT' : 'POST', form: fd });
        const note = mailNote(r.mail);
        toast(note || (this.doc ? 'Documentul a fost actualizat.' : 'Documentul a fost adăugat.'), !!note);
        await loadDocs();
        this.$emit('saved');
      } catch (e) {
        toast(e.message, true);
      }
      this.busy = false;
    },
  },
  template: /*html*/ `
    <Modal xl :title="doc ? 'Modifică documentul' : 'Document nou'" :busy="busy" @close="$emit('close')" @submit="submit">
      <div class="form-cols">
        <div>
          <label class="field"><span>Denumirea documentului *</span><input v-model="form.title" maxlength="300" required autofocus /></label>
          <div class="row">
            <label class="field"><span>Data documentului *</span><input v-model="form.doc_date" type="date" required /></label>
            <label class="field"><span>Număr</span><input v-model="form.number" maxlength="60" placeholder="ex. 15-P" /></label>
          </div>
          <label class="field"><span>Descriere</span><textarea v-model="form.description" rows="4" maxlength="5000"></textarea></label>

          <div class="section-title">Fișiere</div>
          <div class="drop" :class="{ over: dragging }" @dragover.prevent="dragging = true" @dragleave="dragLeave" @drop.prevent="drop">
            <input ref="files" type="file" multiple hidden @change="addFiles($event.target.files); $event.target.value = ''" />
            Trageți fișierele aici sau
            <button type="button" class="btn sm" @click="$refs.files.click()">Alegeți fișiere</button>
            <div class="muted small">Mai multe fișiere pe același document (.pdf, .docx, .xlsx…), max. 50 MB fiecare</div>
          </div>
          <ul v-if="keptFiles.length || newFiles.length" class="filelist">
            <li v-for="f in keptFiles" :key="'k' + f.id">
              <span class="fname">{{ f.name }}</span><span class="muted small">{{ fmtSize(f.size) }}</span>
              <button type="button" class="btn link danger" @click="form.removeFileIds.push(f.id)">Elimină</button>
            </li>
            <li v-for="(f, i) in newFiles" :key="'n' + i">
              <span class="fname">{{ f.name }}</span><span class="badge new">nou</span><span class="muted small">{{ fmtSize(f.size) }}</span>
              <button type="button" class="btn link danger" @click="newFiles.splice(i, 1)">Elimină</button>
            </li>
          </ul>
        </div>

        <div>
          <div class="section-title">Etichete</div>
          <div v-if="!store.categories.length" class="muted small">Administratorul nu a definit încă nicio categorie.</div>
          <div v-for="c in store.categories" :key="c.id" class="pick-group">
            <div>{{ c.name }}</div>
            <div class="pick">
              <button v-for="t in c.tags" :key="t.id" type="button" :class="{ on: form.tagIds.includes(t.id) }" :style="tagStyle(c, t)" @click="toggle(form.tagIds, t.id)">{{ t.name }}</button>
              <span v-if="!c.tags.length" class="muted small">fără etichete</span>
            </div>
          </div>

          <div class="section-title spaced">Cine poate vedea documentul</div>
          <label class="check"><input type="radio" value="all" v-model="form.visibility" /> Toți angajații</label>
          <label class="check"><input type="radio" value="restricted" v-model="form.visibility" /> Doar subdiviziunile și persoanele selectate</label>
          <div v-if="form.visibility === 'restricted'" class="vis-box">
            <div class="vis-cols">
              <div>
                <b class="small">Subdiviziuni</b>
                <div class="scroll">
                  <label v-for="u in units" :key="u.id" class="check" :style="{ paddingLeft: u.depth * 14 + 'px' }">
                    <input type="checkbox" :checked="form.unitIds.includes(u.id)" @change="toggle(form.unitIds, u.id)" /> {{ u.name }}
                  </label>
                </div>
              </div>
              <div>
                <b class="small">Persoane</b>
                <input v-model="userFilter" placeholder="Caută după nume…" class="mt6" />
                <div class="scroll">
                  <label v-for="u in people" :key="u.id" class="check">
                    <input type="checkbox" :checked="form.userIds.includes(u.id)" @change="toggle(form.userIds, u.id)" /> {{ u.full_name }}
                  </label>
                </div>
              </div>
            </div>
            <p class="muted small hint">O subdiviziune include automat și cele din subordinea ei. Autorul și administratorii văd documentul întotdeauna.</p>
          </div>

          <div class="section-title spaced">Semnare</div>
          <label class="check"><input type="checkbox" v-model="needsSign" /> Documentul trebuie semnat digital, pe rând</label>
          <div v-if="needsSign" class="vis-box">
            <b class="small">Ordinea semnării</b>
            <div v-if="!form.signerIds.length" class="muted small mt4">Adăugați semnatarii din lista de mai jos, în ordinea în care trebuie să semneze.</div>
            <ol class="signorder">
              <li v-for="(id, i) in form.signerIds" :key="id">
                <span class="step">{{ i + 1 }}</span>
                <span class="fname">{{ personName(id) }} <span v-if="hasSigned(id)" class="muted small">(a semnat)</span><span v-else-if="inactive(id)" class="warn small">(cont dezactivat — eliminați sau înlocuiți)</span></span>
                <button type="button" class="btn link" :disabled="i === 0" @click="move(i, -1)" aria-label="Mută mai sus">↑</button>
                <button type="button" class="btn link" :disabled="i === form.signerIds.length - 1" @click="move(i, 1)" aria-label="Mută mai jos">↓</button>
                <button type="button" class="btn link danger" :disabled="hasSigned(id)" @click="form.signerIds.splice(i, 1)">Elimină</button>
              </li>
            </ol>
            <input v-model="signFilter" placeholder="Adaugă semnatar: caută după nume…" class="mt6" />
            <div class="scroll short">
              <button v-for="u in signCandidates" :key="u.id" type="button" class="side-item" @click="form.signerIds.push(u.id)">
                <span>+ {{ u.full_name }} <span v-if="!u.email" class="muted small">(fără e-mail)</span></span>
              </button>
            </div>
            <p class="muted small hint">Fiecare semnatar descarcă versiunea curentă, o semnează digital și o încarcă înapoi; apoi vine rândul următorului. {{ mailHint }}</p>
          </div>
        </div>
      </div>
    </Modal>`,
};

const EXT_KIND = { pdf: 'pdf', doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', xls: 'xls', xlsx: 'xls', csv: 'xls', png: 'img', jpg: 'img', jpeg: 'img', p7s: 'sig', asice: 'sig', sig: 'sig' };
const FileLink = {
  props: { file: Object },
  emits: ['open'],
  computed: {
    ext() {
      const m = /\.([a-z0-9]{1,5})$/i.exec(this.file.name);
      return m ? m[1].toLowerCase() : 'fișier';
    },
    kind() {
      return EXT_KIND[this.ext] || 'other';
    },
  },
  methods: { fmtSize },
  template: /*html*/ `
    <a class="file" :href="'/api/files/' + file.id" target="_blank" rel="noopener" @click="$emit('open')">
      <span class="ext" :class="kind">{{ ext }}</span><span class="fname">{{ file.name }}</span><span class="muted small">{{ fmtSize(file.size) }}</span>
    </a>`,
};

// ---------- Semnarea cu tokenul prin puntea FleetView ----------
// Browserul NU mai contactează MoldSign direct (MoldSign refuză originea aplicației, fiindcă
// nu e în lista STISC). În schimb trimite cererile agentului FleetView de pe calculator
// („tava"), care le retransmite către MoldSign cu originea permisă. Codul PIN se introduce
// tot în fereastra MoldSign — nimic nu se semnează fără el. Autentificarea față de tavă: un
// jeton de semnare obținut de la server după autentificare, pe care tava îl validează înapoi.
let SIGN_BRIDGE_URL = 'http://127.0.0.1:48625';
let signToken = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Obține o singură dată jetonul de semnare (legat de sesiune) și adresa punții.
async function ensureSignToken() {
  if (signToken) return signToken;
  const r = await api('/api/sign/token', { method: 'POST' });
  signToken = r.token;
  if (r.bridge) SIGN_BRIDGE_URL = r.bridge;
  return signToken;
}

// Trimite o cerere tăvii FleetView, cu jetonul de semnare ca Bearer. Dacă jetonul a
// expirat (401), cere unul nou și reîncearcă o singură dată: tava respinge cererea
// înainte de a o trimite la MoldSign, deci reîncercarea este sigură.
async function bridge(pathname, init = {}, retried = false) {
  const headers = { ...(init.headers || {}) };
  if (signToken) headers.Authorization = 'Bearer ' + signToken;
  let r;
  try {
    r = await fetch(SIGN_BRIDGE_URL + pathname, { ...init, headers, credentials: 'omit' });
  } catch {
    throw new Error('Puntea de semnare FleetView nu răspunde. Asigurați-vă că agentul FleetView rulează pe acest calculator și reîncercați.');
  }
  if (r.status === 401) {
    signToken = null;
    if (!retried) {
      await ensureSignToken();
      return bridge(pathname, init, true);
    }
  }
  return r;
}
function moldsignError(r) {
  const e = r.headers.get('error') || '';
  if (/pin locked/i.test(e)) return 'Codul PIN al tokenului este blocat.';
  if (/puk locked/i.test(e)) return 'Codul PUK al tokenului este blocat.';
  if (/invalid pin/i.test(e)) return 'Codul PIN introdus este greșit.';
  if (r.status === 401 || r.status === 403) return e || 'Semnarea prin puntea FleetView a fost refuzată.';
  return 'MoldSign nu a putut semna documentul' + (e ? ' (' + e + ').' : '.');
}
async function moldsignCertificates() {
  const r = await bridge('/certificates?private_only=true');
  if (!r.ok) throw new Error(moldsignError(r));
  const d = await r.json().catch(() => ({}));
  return (d.certificateModel || []).filter((c) => c.privateKeyPresent !== false && !c.authority);
}
const dnField = (dn, key) => ((new RegExp('(?:^|,)\\s*' + key + '=([^,]+)', 'i').exec(dn || '') || [])[1] || '').trim();
const certLabel = (c) => c.certificateName || dnField(c.subjectDN, 'CN') || c.label || 'Certificat';
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('Fișierul nu a putut fi citit.'));
    fr.readAsDataURL(blob);
  });
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
// Trimite PDF-ul la MoldSign prin tavă (semnătură PAdES) și așteaptă versiunea semnată.
async function moldsignPdf(blob, cert) {
  const r = await bridge('/sign/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data: await blobToBase64(blob), contentType: 'pdf', signFormat: 'PAdES', certificate: cert }),
  });
  if (!r.ok) throw new Error(moldsignError(r));
  // răspunsul indică adresa rezultatului: sign/data/{furnizor}/{sesiune}[/{tip}]
  const loc = r.headers.get('Location');
  if (!loc) throw new Error('MoldSign nu a întors rezultatul semnării.');
  let p = new URL(loc, SIGN_BRIDGE_URL).pathname.replace(/\/+$/, '');
  if (p.split('/').filter(Boolean).length === 4) p += '/pdf';
  // semnatarul introduce PIN-ul în fereastra MoldSign; așteptăm cel mult 5 minute
  for (let i = 0; i < 300; i++) {
    const g = await bridge(p, { headers: { Accept: 'application/json' } });
    if (g.ok) {
      const j = await g.json().catch(() => null);
      if (j && j.base64File) return base64ToBytes(j.base64File);
    } else if (![202, 204, 409].includes(g.status)) throw new Error(moldsignError(g));
    await sleep(1000);
  }
  throw new Error('Timpul pentru semnare a expirat. Reîncercați.');
}

// Rezultatul verificării semnăturilor unui PDF, calculat pe server.
const SIG_STATUS = { valid: 'Semnătură validă', warning: 'Validă, cu observații', invalid: 'Semnătură nevalidă' };
const SignatureCheck = {
  components: { Modal },
  props: { file: Object },
  emits: ['close'],
  data: () => ({ sigs: null, error: '' }),
  async mounted() {
    try {
      this.sigs = (await api('/api/files/' + this.file.id + '/signatures')).signatures;
    } catch (e) {
      this.error = e.message;
    }
  },
  methods: {
    label: (s) => SIG_STATUS[s.status],
    when: (d) => (d ? new Date(d).toLocaleString('ro-RO', { dateStyle: 'short', timeStyle: 'short' }) : ''),
    day: (d) => (d ? new Date(d).toLocaleDateString('ro-RO') : ''),
  },
  template: /*html*/ `
    <Modal :title="'Semnături: ' + file.name" wide ok-label="Închide" cancel-label="" @close="$emit('close')" @submit="$emit('close')">
      <p v-if="error" class="warn">{{ error }}</p>
      <p v-else-if="!sigs" class="muted">Se verifică…</p>
      <p v-else-if="!sigs.length" class="muted">Fișierul nu conține semnături electronice.</p>
      <div v-for="s in sigs || []" :key="s.index" class="sigcheck" :class="s.status">
        <div class="sigcheck-head"><b>{{ s.index }}. {{ s.signer || 'Semnatar necunoscut' }}</b><span class="sigstatus">{{ label(s) }}</span></div>
        <div class="small">
          <span v-if="s.idnp">IDNP/cod: {{ s.idnp }} · </span><span v-if="s.organization">{{ s.organization }} · </span>
          <span v-if="s.timestamp && s.timestamp.ok">marcă temporală {{ when(s.timestamp.time) }}</span>
          <span v-else-if="s.signingTime">semnat la {{ when(s.signingTime) }} (ora calculatorului semnatarului)</span>
        </div>
        <div v-if="s.chain && s.chain.length" class="small muted">Certificat: {{ s.chain.join(' → ') }}<template v-if="s.validTo">, valabil până la {{ day(s.validTo) }}</template></div>
        <ul v-if="s.problems.length" class="sigproblems"><li v-for="p in s.problems" :key="p">{{ p }}</li></ul>
        <ul class="signotes small muted"><li v-for="n in s.notes" :key="n">{{ n }}</li></ul>
      </div>
    </Modal>`,
};

// Datele din baza de date sunt în UTC ('AAAA-LL-ZZ OO:MM:SS'); le afișăm în ora locală.
const fmtDateTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('ro-RO', { dateStyle: 'short', timeStyle: 'short' });

const isPdfName = (n) => /\.pdf$/i.test(n);
const DocCard = {
  components: { FileLink, Modal, SignatureCheck },
  props: { doc: Object },
  emits: ['edit'],
  data: () => ({ busy: false, reminding: false, signing: '', certPick: null, verifying: null }),
  computed: {
    store: () => store,
    tags: () => tagIndex(),
    // versiuni semnate de persoane care nu mai figurează în lanț (date mai vechi): rămân vizibile
    orphanSigned() {
      const ids = new Set(this.doc.signers.map((s) => s.id));
      return this.doc.files.filter((f) => f.signed_by_name && !ids.has(f.signed_by));
    },
    pending() {
      return this.doc.signers.filter((s) => !s.signed_at).length;
    },
    originals() {
      return this.doc.files.filter((f) => !f.signed_by_name);
    },
    // Versiunea care trebuie semnată acum: fișierele ultimului semnatar sau, dacă nu a semnat nimeni, originalele.
    latest() {
      const signed = this.doc.files.filter((f) => f.signed_by_name);
      if (!signed.length) return this.originals;
      const last = signed[signed.length - 1];
      return signed.filter((f) => f.signed_by === last.signed_by && f.created_at === last.created_at);
    },
    // MoldSign semnează doar PDF-uri; pentru alte formate rămâne încărcarea manuală
    canToken() {
      return this.latest.length > 0 && this.latest.every((f) => isPdfName(f.name));
    },
  },
  methods: {
    chipStyle,
    docDay,
    docMon,
    visLabel,
    fmtDateTime,
    signedFiles(userId) {
      return this.doc.files.filter((f) => f.signed_by_name && f.signed_by === userId);
    },
    // serverul marchează documentul ca văzut când se deschide un fișier; reîmprospătăm lista puțin mai târziu
    opened() {
      if (this.doc.unseen) setTimeout(() => loadDocs().catch(() => {}), 800);
    },
    markSeen() {
      run(async () => {
        await api('/api/documents/' + this.doc.id + '/seen', { method: 'POST' });
        await loadDocs();
      });
    },
    async uploadSigned(e) {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      const names = files.map((f) => f.name).join(', ');
      const big = files.find((f) => f.size > 50 * 1024 * 1024);
      if (big) return toast('„' + big.name + '” depășește limita de 50 MB.', true);
      if (files.length > 10) return toast('Cel mult 10 fișiere la o încărcare.', true);
      const ok = await ask({
        title: 'Încărcați versiunea semnată?',
        message: '„' + names + '” va fi înregistrat ca versiune semnată de dvs. După încărcare, documentul trece la următorul semnatar.',
        okLabel: 'Încarcă',
      });
      if (!ok) return;
      this.busy = true;
      try {
        await this.sendSigned(files);
        toast(this.lastNote || 'Versiunea semnată a fost încărcată.', !!this.lastNote);
      } catch (err) {
        toast(err.message, true);
      }
      this.busy = false;
    },
    async sendSigned(files, data) {
      const fd = new FormData();
      if (data) fd.append('data', JSON.stringify(data));
      for (const f of files) fd.append('files', f);
      const r = await api('/api/documents/' + this.doc.id + '/sign', { method: 'POST', form: fd });
      this.lastNote = mailNote(r.mail);
      await loadDocs();
    },
    // Semnarea cu tokenul: alegerea certificatului, semnarea fiecărui PDF în MoldSign, apoi încărcarea.
    async signWithToken() {
      this.busy = true;
      this.signing = 'Se contactează MoldSign…';
      try {
        await ensureSignToken();
        const certs = await moldsignCertificates();
        if (!certs.length) throw new Error('MoldSign nu găsește niciun certificat de semnare. Conectați tokenul și reîncercați.');
        const names = this.latest.map((f) => f.name).join(', ');
        const cert = await new Promise((resolve) => (this.certPick = { certs, chosen: 0, names, resolve }));
        if (!cert) return;
        const signed = [];
        for (const f of this.latest) {
          this.signing = 'Introduceți PIN-ul în fereastra MoldSign…';
          const res = await fetch('/api/files/' + f.id + '?download=1', { credentials: 'same-origin' });
          if (!res.ok) throw new Error('„' + f.name + '” nu a putut fi descărcat.');
          const bytes = await moldsignPdf(await res.blob(), cert);
          signed.push(new File([bytes], f.name, { type: 'application/pdf' }));
        }
        this.signing = 'Se încarcă versiunea semnată…';
        await this.sendSigned(signed, { method: 'moldsign' });
        toast(this.lastNote || 'Documentul a fost semnat cu MoldSign.', !!this.lastNote);
      } catch (err) {
        toast(err.message, true);
      } finally {
        this.busy = false;
        this.signing = '';
        this.certPick = null;
      }
    },
    pickCert(ok) {
      const p = this.certPick;
      this.certPick = null;
      if (p) p.resolve(ok ? p.certs[p.chosen] : null);
    },
    certLabel,
    certIssuer: (c) => dnField(c.issuerDN, 'CN'),
    isPdfName,
    async remind() {
      this.reminding = true;
      try {
        const r = await api('/api/documents/' + this.doc.id + '/remind', { method: 'POST' });
        const note = mailNote(r.mail);
        toast(note || 'Notificarea a fost retrimisă pe e-mail.', !!note);
      } catch (e) {
        toast(e.message, true);
      }
      this.reminding = false;
    },
    async remove() {
      const ok = await ask({
        title: 'Ștergeți documentul?',
        message: '„' + this.doc.title + '” va fi șters definitiv, împreună cu toate fișierele atașate. Acțiunea nu poate fi anulată.',
        okLabel: 'Șterge definitiv',
        danger: true,
      });
      if (!ok) return;
      await run(async () => {
        await api('/api/documents/' + this.doc.id, { method: 'DELETE' });
        await loadDocs();
      }, 'Documentul a fost șters.');
    },
  },
  template: /*html*/ `
    <article class="card doc" :class="{ unseen: doc.unseen }">
      <div class="doc-date"><b>{{ docDay(doc) }}</b><span>{{ docMon(doc) }}</span></div>
      <div class="doc-body">
        <div class="doc-title">
          <span v-if="doc.unseen" class="badge new">Nou</span>
          {{ doc.title }}<span v-if="doc.number" class="doc-nr">nr. {{ doc.number }}</span>
        </div>
        <p v-if="doc.description" class="doc-desc">{{ doc.description }}</p>
        <div v-if="originals.length" class="files">
          <FileLink v-for="f in originals" :key="f.id" :file="f" @open="opened" />
        </div>

        <div v-if="doc.signers.length" class="signbox" :class="{ done: !pending }">
          <div class="sign-head">
            <b>{{ pending ? 'În curs de semnare' : 'Semnat de toți' }}</b>
            <span class="small">{{ doc.signers.length - pending }} din {{ doc.signers.length }}</span>
            <button v-if="doc.canEdit && pending && store.me.mailEnabled" class="btn link" :disabled="reminding" @click="remind">Retrimite e-mail</button>
          </div>
          <ol class="chain">
            <li v-for="f in orphanSigned" :key="'o' + f.id" class="ok">
              <span class="step">✓</span>
              <div>
                <b>{{ f.signed_by_name }}</b><span class="small"> — a semnat (cont șters)</span>
                <div class="files"><FileLink :file="f" @open="opened" /><button v-if="isPdfName(f.name)" class="btn link sm" @click="verifying = f">Verifică semnătura</button></div>
              </div>
            </li>
            <li v-for="(s, i) in doc.signers" :key="s.id" :class="{ ok: s.signed_at, turn: s.id === doc.signTurn }">
              <span class="step">{{ s.signed_at ? '✓' : i + 1 }}</span>
              <div>
                <b>{{ s.name }}</b>
                <span class="small"> — {{ s.signed_at ? 'a semnat la ' + fmtDateTime(s.signed_at) : s.id === doc.signTurn ? 'este la rând' : 'așteaptă' }}</span>
                <span v-if="!s.active && !s.signed_at" class="warn small"> · cont dezactivat, lanțul este blocat</span>
                <div v-if="signedFiles(s.id).length" class="files">
                  <template v-for="f in signedFiles(s.id)" :key="f.id">
                    <FileLink :file="f" @open="opened" />
                    <button v-if="isPdfName(f.name)" class="btn link sm" @click="verifying = f">Verifică semnătura</button>
                  </template>
                </div>
              </div>
            </li>
          </ol>
          <div v-if="doc.mySign === 'pending'" class="myturn">
            <div v-if="canToken"><b>Este rândul dvs. să semnați.</b> Semnați cu tokenul prin MoldSign sau, dacă ați semnat în altă aplicație, încărcați fișierul semnat.</div>
            <div v-else><b>Este rândul dvs. să semnați.</b> Descărcați versiunea curentă, semnați-o digital, apoi încărcați fișierul semnat.</div>
            <div class="files">
              <FileLink v-for="f in latest" :key="f.id" :file="f" @open="opened" />
              <input ref="signed" type="file" multiple hidden @change="uploadSigned" />
              <button v-if="canToken" class="btn primary sm" :disabled="busy" @click="signWithToken">{{ signing || 'Semnează cu MoldSign' }}</button>
              <button class="btn sm" :class="{ primary: !canToken }" :disabled="busy" @click="$refs.signed.click()">{{ busy && !signing ? 'Se încarcă…' : 'Încarcă documentul semnat' }}</button>
            </div>
          </div>
          <Modal v-if="certPick" title="Semnare cu MoldSign" ok-label="Semnează" @close="pickCert(false)" @submit="pickCert(true)">
            <p class="dialog-msg">„{{ certPick.names }}” va fi semnat electronic. După ce apăsați „Semnează”, MoldSign vă cere codul PIN al tokenului.</p>
            <div class="section-title">Certificatul de semnare</div>
            <label v-for="(c, i) in certPick.certs" :key="i" class="check certopt">
              <input type="radio" name="cert" :value="i" v-model="certPick.chosen" />
              <span><b>{{ certLabel(c) }}</b><span class="muted small"><template v-if="certIssuer(c)"> · emis de {{ certIssuer(c) }}</template></span></span>
            </label>
          </Modal>
          <SignatureCheck v-if="verifying" :file="verifying" @close="verifying = null" />
        </div>

        <div class="doc-meta">
          <template v-for="id in doc.tagIds" :key="id">
            <span v-if="tags.get(id)" class="chip" :style="chipStyle(tags.get(id).color)">{{ tags.get(id).name }}</span>
          </template>
          <span class="chip vis">{{ visLabel(doc) }}</span>
          <span v-if="doc.author" class="muted small">adăugat de {{ doc.author }}</span>
        </div>
      </div>
      <div v-if="doc.canEdit || doc.unseen" class="doc-actions">
        <button v-if="doc.unseen" class="btn link" @click="markSeen">Marchează ca văzut</button>
        <button v-if="doc.canEdit" class="btn link" @click="$emit('edit', doc)">Modifică</button>
        <button v-if="doc.canDelete" class="btn link danger" @click="remove">Șterge</button>
      </div>
    </article>`,
};

const DocsView = {
  components: { DocForm, DocCard },
  data: () => ({ sel: { type: 'all', id: null }, year: '', q: '', editing: undefined }),
  computed: {
    store: () => store,
    docs: () => store.docs,
    canAdd: () => store.me.role !== 'user',
    tags: () => tagIndex(),
    years() {
      return [...new Set(this.docs.map((d) => d.doc_date.slice(0, 4)))];
    },
    counts() {
      const tag = {};
      const cat = {};
      for (const d of this.docs) {
        const cats = new Set();
        for (const id of d.tagIds) {
          tag[id] = (tag[id] || 0) + 1;
          const t = this.tags.get(id);
          if (t) cats.add(t.category_id);
        }
        for (const c of cats) cat[c] = (cat[c] || 0) + 1;
      }
      return { tag, cat };
    },
    filtered() {
      const q = this.q.trim().toLowerCase();
      return this.docs.filter((d) => {
        if (this.year && !d.doc_date.startsWith(this.year)) return false;
        if (this.sel.type === 'tag' && !d.tagIds.includes(this.sel.id)) return false;
        if (this.sel.type === 'cat' && !d.tagIds.some((id) => (this.tags.get(id) || {}).category_id === this.sel.id)) return false;
        if (!q) return true;
        const hay = [d.title, d.number, d.description, ...d.files.map((f) => f.name), ...d.tagIds.map((id) => (this.tags.get(id) || {}).name)];
        return hay.join(' ').toLowerCase().includes(q);
      });
    },
    // Lista vine deja ordonată după data documentului (cele mai recente primele); aici doar o grupăm pe luni.
    groups() {
      const out = [];
      for (const d of this.filtered) {
        const key = d.doc_date.slice(0, 7);
        if (!out.length || out[out.length - 1].key !== key) {
          out.push({ key, label: MONTHS[Number(key.slice(5)) - 1] + ' ' + key.slice(0, 4), docs: [] });
        }
        out[out.length - 1].docs.push(d);
      }
      return out;
    },
  },
  methods: {
    isSel(type, id) {
      return this.sel.type === type && this.sel.id === id;
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <h1>Documente</h1>
      <button v-if="canAdd" class="btn primary" @click="editing = null">+ Adaugă document</button>
    </div>
    <div class="docs">
      <aside class="card side">
        <button class="side-item" :class="{ on: sel.type === 'all' }" @click="sel = { type: 'all', id: null }">
          <span>Toate documentele</span><span class="count">{{ docs.length }}</span>
        </button>
        <template v-for="c in store.categories" :key="c.id">
          <button class="side-item side-cat" :class="{ on: isSel('cat', c.id) }" @click="sel = { type: 'cat', id: c.id }">
            <span><i class="dot" :style="{ background: c.color }"></i>{{ c.name }}</span><span class="count">{{ counts.cat[c.id] || 0 }}</span>
          </button>
          <button v-for="t in c.tags" :key="t.id" class="side-item side-tag" :class="{ on: isSel('tag', t.id) }" @click="sel = { type: 'tag', id: t.id }">
            <span>{{ t.name }}</span><span class="count">{{ counts.tag[t.id] || 0 }}</span>
          </button>
        </template>
      </aside>

      <section>
        <div class="toolbar">
          <input v-model="q" type="search" placeholder="Caută după denumire, număr, descriere, fișier…" />
          <select v-model="year" aria-label="Anul">
            <option value="">Toți anii</option>
            <option v-for="y in years" :key="y">{{ y }}</option>
          </select>
        </div>

        <div v-if="store.docsLoaded && !groups.length" class="card empty">
          {{ docs.length ? 'Niciun document nu corespunde filtrelor.' : 'Încă nu există documente disponibile pentru dvs.' }}
        </div>
        <template v-for="g in groups" :key="g.key">
          <div class="month">{{ g.label }}</div>
          <DocCard v-for="d in g.docs" :key="d.id" :doc="d" @edit="editing = $event" />
        </template>
      </section>
    </div>
    <DocForm v-if="editing !== undefined" :doc="editing" @close="editing = undefined" @saved="editing = undefined" />`,
};

// ---------- notificări ----------
const InboxView = {
  components: { DocForm, DocCard },
  data: () => ({ editing: undefined }),
  computed: {
    toSign: () => store.docs.filter((d) => d.mySign === 'pending'),
    fresh: () => store.docs.filter((d) => d.unseen && d.mySign !== 'pending'),
  },
  methods: {
    seenAll() {
      run(async () => {
        await api('/api/documents/seen-all', { method: 'POST' });
        await loadDocs();
      }, 'Toate documentele au fost marcate ca văzute.');
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <h1>Notificări</h1>
      <button v-if="fresh.length" class="btn" @click="seenAll">Marchează toate ca văzute</button>
    </div>
    <div v-if="!toSign.length && !fresh.length" class="card empty">Nu aveți notificări. Sunteți la zi cu toate documentele.</div>
    <template v-if="toSign.length">
      <div class="month">Așteaptă semnătura dvs. ({{ toSign.length }})</div>
      <DocCard v-for="d in toSign" :key="d.id" :doc="d" @edit="editing = $event" />
    </template>
    <template v-if="fresh.length">
      <div class="month">Documente noi, încă nevăzute ({{ fresh.length }})</div>
      <DocCard v-for="d in fresh" :key="d.id" :doc="d" @edit="editing = $event" />
    </template>
    <DocForm v-if="editing !== undefined" :doc="editing" @close="editing = undefined" @saved="editing = undefined" />`,
};

// ---------- copie de rezervă ----------
const BackupView = {
  data: () => ({ busy: false, file: null }),
  methods: {
    fmtSize,
    async restore() {
      if (!this.file) return;
      const ok = await ask({
        title: 'Înlocuiți toate datele?',
        message: 'Importul ÎNLOCUIEȘTE toate datele actuale (utilizatori, organigramă, documente, fișiere) cu cele din arhiva „' + this.file.name + '”. Toți utilizatorii vor fi deconectați.',
        okLabel: 'Importă și înlocuiește',
        danger: true,
      });
      if (!ok) return;
      this.busy = true;
      try {
        const r = await api('/api/admin/import', { method: 'POST', raw: this.file });
        await ask({
          title: 'Import finalizat',
          message:
            r.documents + ' documente, ' + r.files + ' fișiere, ' + r.users + ' utilizatori.' +
            (r.missing ? '\n' + r.missing + ' fișiere lipseau deja la momentul exportului.' : '') +
            '\n\nAutentificați-vă din nou cu un cont din arhivă.',
          okLabel: 'Continuă',
          cancelLabel: '',
        });
        location.reload();
      } catch (e) {
        toast(e.message, true);
      }
      this.busy = false;
    },
  },
  // Afișat în pagina „Setări”, în coloana din dreapta.
  template: /*html*/ `
    <div class="settings-col">
      <section class="card panel">
        <div class="panel-head"><h2>Export complet</h2><span class="pill">Backup</span></div>
        <p class="muted small">Un singur fișier comprimat cu tot: utilizatori (parole criptate), organigramă, categorii, documente, semnături și fișiere. Fiecare element are sumă de control.</p>
        <div class="panel-foot">
          <a class="btn primary" href="/api/admin/export" download>Descarcă exportul</a>
          <span class="muted small">Păstrați-l într-un loc sigur: conține toate documentele.</span>
        </div>
      </section>
      <section class="card panel danger-panel">
        <div class="panel-head"><h2>Import (restaurare)</h2><span class="pill red">Înlocuiește tot</span></div>
        <p class="muted small">Înlocuiește toate datele actuale cu cele dintr-un export. Arhiva este verificată integral înainte; dacă este deteriorată sau incompletă, nu se schimbă nimic.</p>
        <label class="filepick" :class="{ chosen: file }">
          <input type="file" accept=".anscbackup" :disabled="busy" @change="file = $event.target.files[0] || null" />
          <span>{{ file ? file.name + ' — ' + fmtSize(file.size) : 'Alegeți fișierul .anscbackup…' }}</span>
        </label>
        <div class="panel-foot">
          <button class="btn danger-solid" :disabled="!file || busy" @click="restore">{{ busy ? 'Se importă… nu închideți pagina' : 'Importă și înlocuiește tot' }}</button>
        </div>
      </section>
    </div>`,
};

// ---------- utilizatori ----------
const UserForm = {
  components: { Modal },
  props: { user: Object, unitId: Number },
  emits: ['close', 'saved'],
  data() {
    const u = this.user;
    return {
      busy: false,
      form: {
        full_name: u ? u.full_name : '',
        username: u ? u.username : '',
        position: u ? u.position : '',
        email: u ? u.email : '',
        unit_id: u ? u.unit_id : this.unitId || null,
        role: u ? u.role : 'user',
        active: u ? !!u.active : true,
        password: '',
      },
    };
  },
  computed: { units: () => flatUnits() },
  methods: {
    // parolă inițială aleatorie, fără caractere ușor de confundat (0/O, 1/l/I)
    generate() {
      const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const bytes = crypto.getRandomValues(new Uint8Array(14));
      this.form.password = [...bytes].map((b) => abc[b % abc.length]).join('');
    },
    async submit() {
      this.busy = true;
      let r;
      const ok = await run(async () => {
        r = await api(this.user ? '/api/users/' + this.user.id : '/api/users', { method: this.user ? 'PUT' : 'POST', body: this.form });
        await loadShared();
      });
      this.busy = false;
      if (!ok) return;
      if (r && r.blockedDocs) {
        toast('Contul a fost dezactivat. ' + r.blockedDocs + ' document(e) așteaptă semnătura acestei persoane: autorii trebuie să modifice lanțul de semnare.', true);
      } else toast(this.user ? 'Utilizatorul a fost actualizat.' : 'Utilizatorul a fost adăugat.');
      this.$emit('saved');
    },
  },
  template: /*html*/ `
    <Modal :title="user ? 'Modifică utilizatorul' : 'Utilizator nou'" :busy="busy" @close="$emit('close')" @submit="submit">
      <label class="field"><span>Nume și prenume *</span><input v-model="form.full_name" maxlength="150" required autofocus /></label>
      <div class="row">
        <label class="field"><span>Funcția</span><input v-model="form.position" maxlength="150" placeholder="ex. Consultant principal" /></label>
        <label class="field"><span>E-mail</span><input v-model="form.email" type="email" maxlength="150" /></label>
      </div>
      <label class="field"><span>Subdiviziunea (locul în organigramă)</span>
        <select v-model="form.unit_id">
          <option :value="null">— fără subdiviziune —</option>
          <option v-for="u in units" :key="u.id" :value="u.id">{{ u.label }}</option>
        </select>
      </label>
      <div class="row">
        <label class="field"><span>Nume de utilizator *</span><input v-model="form.username" maxlength="40" required autocomplete="off" placeholder="ex. ion.popescu" /></label>
        <label class="field"><span>{{ user ? 'Parolă nouă (opțional)' : 'Parolă inițială *' }}</span>
          <span class="input-btn">
            <input v-model="form.password" type="text" minlength="10" maxlength="200" :required="!user" autocomplete="off" spellcheck="false" placeholder="cel puțin 10 caractere" />
            <button type="button" class="btn sm" @click="generate" title="Generează o parolă aleatorie">Generează</button>
          </span>
        </label>
      </div>
      <label class="field"><span>Rol</span>
        <select v-model="form.role">
          <option value="user">Angajat — vede documentele la care are acces</option>
          <option value="editor">Editor — poate adăuga și modifica documentele proprii</option>
          <option value="admin">Administrator — gestionează tot sistemul</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" v-model="form.active" /> Cont activ</label>
      <p class="muted small hint">La prima autentificare (sau după resetarea parolei) utilizatorul va fi obligat să își seteze o parolă proprie.</p>
    </Modal>`,
};

// ---------- import în masă al angajaților (CSV) ----------
// Coloane recunoscute (antet, fără diacritice/majuscule): Nume, Prenume, Funcția, E-mail,
// Utilizator, Subdiviziune. În locul coloanelor Nume + Prenume se acceptă și una singură,
// „Numele, prenumele” / „Nume și prenume” (ca în lista de telefoane: întâi numele de familie).
// „Subdiviziune” este calea în organigramă, de sus în jos, cu „>” între niveluri. Lipsa coloanei
// „Utilizator” = prenume.nume fără diacritice. Fișierul poate veni din Excel așa cum l-a salvat:
// UTF-8 sau ANSI (Windows-1250) sau UTF-16, cu separator ; , sau tab, cu rândul „sep=;” și cu
// un titlu deasupra antetului.
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const slugName = (s) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const BOM = String.fromCharCode(0xfeff);

async function readTextFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1250').decode(buf); // „CSV” salvat de Excel în românește
  }
}

function parseCsv(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

// Pozițiile coloanelor dintr-un rând de antet, sau null dacă rândul nu este antetul.
function headerColumns(head) {
  const keys = head.map((h) => fold(h).replace(/[^a-z]+/g, ' ').trim());
  const find = (test) => keys.findIndex(test);
  const c = {
    nume: find((k) => ['nume', 'numele', 'nume de familie', 'familia'].includes(k)),
    prenume: find((k) => ['prenume', 'prenumele'].includes(k)),
    both: find((k) => /^numele? (si )?prenumele?$/.test(k) || k === 'nume si prenume'),
    functia: find((k) => k.startsWith('functi')),
    email: find((k) => k.startsWith('e mail') || k.startsWith('email')),
    user: find((k) => ['utilizator', 'nume de utilizator', 'username', 'login'].includes(k)),
    unit: find((k) => k.startsWith('subdiviziun') || k.startsWith('unitate')),
  };
  if (c.nume >= 0 && c.prenume >= 0) c.both = -1;
  else if (c.both < 0) return null;
  return c;
}

function peopleFromCsv(text) {
  text = text.replace(BOM, '');
  let seps = [';', ',', '\t'];
  const sepLine = /^"?sep=(.)"?\r?\n/i.exec(text); // Excel scrie uneori „sep=;” pe primul rând
  if (sepLine) {
    seps = [sepLine[1]];
    text = text.slice(sepLine[0].length);
  }
  let found = null;
  for (const sep of seps) {
    const rows = parseCsv(text, sep);
    // antetul poate fi precedat de un titlu: îl căutăm în primele rânduri
    for (let i = 0; i < Math.min(rows.length, 10) && !found; i++) {
      const cols = headerColumns(rows[i]);
      if (cols) found = { cols, lines: rows.slice(i + 1) };
    }
    if (found) break;
  }
  if (!found) {
    const first = text.split(/\r?\n/, 1)[0].slice(0, 120);
    throw new Error(
      'Nu am găsit coloanele „Nume” și „Prenume” (sau „Numele, prenumele”). Primul rând din fișier este: „' +
        first +
        '”. Salvați tabelul ca CSV (UTF-8 sau „CSV separat prin virgulă”) cu antetul: Nume; Prenume; Funcția; E-mail; Utilizator; Subdiviziune.'
    );
  }
  const { cols: c, lines } = found;
  const at = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  return lines
    .map((r) => {
      let nume = at(r, c.nume);
      let prenume = at(r, c.prenume);
      if (c.both >= 0) {
        // „Munteanu Angela”: ultimul cuvânt este prenumele, restul numele de familie
        const words = at(r, c.both).split(/\s+/).filter(Boolean);
        prenume = words.length > 1 ? words.pop() : '';
        nume = words.join(' ');
      }
      return {
        full_name: [prenume, nume].filter(Boolean).join(' '),
        username: at(r, c.user) || [slugName(prenume), slugName(nume)].filter(Boolean).join('.'),
        email: at(r, c.email),
        position: at(r, c.functia),
        path: at(r, c.unit).split(/\s*[>›]\s*/).filter(Boolean),
      };
    })
    .filter((p) => p.full_name);
}

const ImportPeople = {
  components: { Modal },
  emits: ['close', 'done'],
  data: () => ({ rows: [], fileName: '', parentId: null, preview: null, result: null, busy: false, error: '' }),
  created() {
    // Cu o singură subdiviziune de nivel superior (de regulă instituția), subdiviziunile noi intră sub ea.
    const top = childUnits(null);
    if (top.length === 1) this.parentId = top[0].id;
  },
  computed: {
    units: () => flatUnits(),
    okLabel() {
      if (this.result) return 'Închide';
      return this.preview ? 'Importă ' + this.preview.created.length + ' angajați' : 'Verifică fișierul';
    },
  },
  methods: {
    async pick(e) {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      this.error = '';
      this.preview = null;
      this.fileName = file.name;
      try {
        this.rows = peopleFromCsv(await readTextFile(file));
        if (!this.rows.length) throw new Error('Fișierul nu conține angajați.');
        await this.check();
      } catch (err) {
        this.rows = [];
        this.error = err.message;
      }
    },
    async check() {
      this.busy = true;
      try {
        this.preview = await api('/api/admin/import-people', { method: 'POST', body: { rows: this.rows, parent_id: this.parentId, dry_run: true } });
      } catch (err) {
        this.error = err.message;
      }
      this.busy = false;
    },
    async submit() {
      if (this.result) return this.close();
      if (!this.rows.length) return (this.error = 'Alegeți mai întâi fișierul CSV.');
      if (!this.preview) return this.check();
      if (!this.preview.created.length) return (this.error = 'Nu este niciun angajat nou de importat.');
      this.busy = true;
      try {
        this.result = await api('/api/admin/import-people', { method: 'POST', body: { rows: this.rows, parent_id: this.parentId } });
        await loadShared();
      } catch (err) {
        this.error = err.message;
      }
      this.busy = false;
    },
    close() {
      this.$emit(this.result ? 'done' : 'close');
    },
    // Lista cu parolele temporare, de transmis angajaților (o singură dată; nu se mai pot vedea ulterior).
    downloadPasswords() {
      const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const lines = [['Nume și prenume', 'Utilizator', 'Parolă temporară', 'E-mail', 'Subdiviziune'].map(q).join(';')];
      for (const c of this.result.created) lines.push([c.full_name, c.username, c.password, c.email, c.unit].map(q).join(';'));
      const blob = new Blob([BOM + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'parole-temporare.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  },
  template: /*html*/ `
    <Modal title="Import angajați din CSV" xl :busy="busy" :ok-label="okLabel" busy-label="Se verifică…" :cancel-label="result ? '' : 'Anulează'" @close="close" @submit="submit">
      <template v-if="!result">
        <p class="dialog-msg">Coloane: <b>Nume</b>, <b>Prenume</b>, Funcția, E-mail, Utilizator, Subdiviziune (calea în organigramă, cu „&gt;” între niveluri). Subdiviziunile lipsă se creează; conturile existente nu se modifică. Fiecare cont nou primește o parolă temporară, de schimbat la prima autentificare.</p>
        <div class="row">
          <label class="field"><span>Fișierul CSV</span><input type="file" accept=".csv,.txt,text/csv,text/plain" @change="pick" /></label>
          <label class="field"><span>Plasează subdiviziunile noi de nivel superior sub</span>
            <select v-model="parentId" @change="rows.length && check()">
              <option :value="null">— nivelul superior —</option>
              <option v-for="u in units" :key="u.id" :value="u.id">{{ u.label }}</option>
            </select>
          </label>
        </div>
        <p v-if="error" class="warn">{{ error }}</p>
        <template v-if="preview">
          <p><b>{{ preview.created.length }}</b> conturi noi, <b>{{ preview.units.length }}</b> subdiviziuni noi<template v-if="preview.skipped.length">, <b>{{ preview.skipped.length }}</b> rânduri omise</template> ({{ fileName }}).</p>
          <p v-if="preview.units.length" class="small muted">Subdiviziuni noi: {{ preview.units.join('; ') }}</p>
          <div v-if="preview.skipped.length" class="small"><b>Omise:</b><ul><li v-for="s in preview.skipped" :key="s.line">rândul {{ s.line }} {{ s.name }}: {{ s.reason }}</li></ul></div>
          <div class="table-wrap import-preview">
            <table>
              <thead><tr><th>Nume și prenume</th><th>Utilizator</th><th>Funcția</th><th>E-mail</th><th>Subdiviziune</th></tr></thead>
              <tbody><tr v-for="c in preview.created" :key="c.line"><td>{{ c.full_name }}</td><td><code class="uname">{{ c.username }}</code></td><td>{{ rows[c.line - 1].position || '—' }}</td><td>{{ c.email || '—' }}</td><td>{{ c.unit || '—' }}</td></tr></tbody>
            </table>
          </div>
        </template>
      </template>
      <template v-else>
        <p><b>{{ result.created.length }}</b> conturi create și <b>{{ result.units.length }}</b> subdiviziuni adăugate în organigramă.</p>
        <p class="warn">Descărcați acum lista cu parolele temporare: după închiderea ferestrei nu mai poate fi afișată. Păstrați-o în siguranță și ștergeți-o după ce ați transmis parolele.</p>
        <button type="button" class="btn primary" @click="downloadPasswords">Descarcă parolele temporare (CSV)</button>
      </template>
    </Modal>`,
};

const UsersView = {
  components: { UserForm, ImportPeople },
  data: () => ({ users: [], editing: undefined, q: '', loaded: false, importing: false }),
  computed: {
    store: () => store,
    shown() {
      const q = this.q.trim().toLowerCase();
      if (!q) return this.users;
      return this.users.filter((u) => [u.full_name, u.username, u.position, u.email, u.unit_id ? unitName(u.unit_id) : ''].join(' ').toLowerCase().includes(q));
    },
  },
  methods: {
    unitName,
    initials,
    avatarStyle,
    role: (r) => ROLES[r],
    async load() {
      await run(async () => (this.users = await api('/api/users')));
      this.loaded = true;
    },
    async saved() {
      this.editing = undefined;
      await this.load();
    },
    async remove(u) {
      const ok = await ask({
        title: 'Ștergeți contul?',
        message: 'Contul „' + u.full_name + '” va fi șters definitiv. Documentele adăugate de această persoană rămân în sistem. Dacă persoana doar a plecat din instituție, puteți dezactiva contul în loc să îl ștergeți.',
        okLabel: 'Șterge contul',
        danger: true,
      });
      if (!ok) return;
      const done = await run(async () => {
        await api('/api/users/' + u.id, { method: 'DELETE' });
        await loadShared();
      }, 'Utilizatorul a fost șters.');
      if (done) this.load();
    },
  },
  mounted() {
    this.load();
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Utilizatori</h1>
        <p class="muted page-sub">{{ users.length }} conturi, dintre care {{ users.filter((u) => u.active).length }} active.</p>
      </div>
      <div class="head-actions">
        <input v-model="q" type="search" class="search-sm" placeholder="Caută după nume, funcție, subdiviziune…" aria-label="Caută utilizatori" />
        <button class="btn" @click="importing = true">Importă din CSV…</button>
        <button class="btn primary" @click="editing = null">+ Adaugă utilizator</button>
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Nume și prenume</th><th>Utilizator</th><th>Funcția</th><th>Subdiviziunea</th><th>Rol</th><th>Stare</th><th></th></tr></thead>
        <tbody>
          <tr v-for="u in shown" :key="u.id" :class="{ off: !u.active }">
            <td><span class="who"><span class="avatar sm" :style="avatarStyle(u.full_name)">{{ initials(u.full_name) }}</span><b>{{ u.full_name }}</b></span></td>
            <td><code class="uname">{{ u.username }}</code></td>
            <td>{{ u.position || '—' }}</td>
            <td>{{ u.unit_id ? unitName(u.unit_id) : '—' }}</td>
            <td><span class="badge" :class="{ gray: u.role === 'user', dark: u.role === 'admin' }">{{ role(u.role) }}</span></td>
            <td><span class="status" :class="{ on: u.active }">{{ u.active ? (u.must_change ? 'Activ · parolă de schimbat' : 'Activ') : 'Dezactivat' }}</span></td>
            <td class="row-actions">
              <button class="btn link" @click="editing = u">Modifică</button>
              <button v-if="u.id !== store.me.id" class="btn link danger" @click="remove(u)">Șterge</button>
            </td>
          </tr>
          <tr v-if="loaded && !shown.length"><td colspan="7" class="empty-row">{{ users.length ? 'Niciun utilizator nu corespunde căutării.' : 'Nu există utilizatori.' }}</td></tr>
        </tbody>
      </table>
    </div>
    <UserForm v-if="editing !== undefined" :user="editing" @close="editing = undefined" @saved="saved" />
    <ImportPeople v-if="importing" @close="importing = false" @done="(importing = false), load()" />`,
};

// ---------- organigramă ----------
// Vizibilă tuturor angajaților; doar administratorii văd butoanele de editare.
const ORG_PREVIEW = 5; // câte persoane se văd pe un card înainte de „încă N”
const readPref = (k, d) => {
  try {
    return localStorage.getItem(k) || d;
  } catch {
    return d;
  }
};
const writePref = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
// Starea organigramei rămâne aceeași când utilizatorul trece la alte pagini și revine.
const orgUi = reactive({
  mode: readPref('org.mode', 'chart'),
  zoom: Number(readPref('org.zoom', '1')) || 1,
  collapsed: new Set(),
  morePeople: new Set(),
  focus: null,
});

const peopleOf = (unitId) => store.users.filter((u) => u.unit_id === unitId);
function subtreeIds(unitId, out = new Set()) {
  if (out.has(unitId)) return out;
  out.add(unitId);
  for (const c of childUnits(unitId)) subtreeIds(c.id, out);
  return out;
}
const subtreePeople = (unitId) => {
  const ids = subtreeIds(unitId);
  return store.users.filter((u) => ids.has(u.unit_id)).length;
};
function unitPath(unitId) {
  const byId = new Map(store.units.map((u) => [u.id, u]));
  const out = [];
  for (let u = byId.get(unitId); u && out.length < 50; u = byId.get(u.parent_id)) out.unshift(u.name);
  return out;
}
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

const ICONS = {
  unit: '<path d="M3 7h7l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M15 14h4M17 12v4"/>',
  user: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M19 8v6M16 11h6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
};
const Icon = {
  props: { name: String },
  computed: { svg() { return ICONS[this.name] || ''; } },
  template: /*html*/ `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="svg"></svg>`,
};

// Rândul unei persoane, folosit în ambele vizualizări și în rezultatele căutării.
const OrgPerson = {
  components: { Icon },
  props: { p: Object, hit: Boolean },
  methods: { initials, avatarStyle },
  template: /*html*/ `
    <li class="person" :class="{ hit }">
      <span class="avatar" :style="avatarStyle(p.full_name)">{{ initials(p.full_name) }}</span>
      <div class="person-txt"><b :title="p.full_name">{{ p.full_name }}</b><span class="muted small" :title="p.position">{{ p.position || '—' }}</span></div>
      <a v-if="p.email" class="person-mail" :href="'mailto:' + p.email" :title="'Scrie-i un e-mail: ' + p.email" :aria-label="'E-mail către ' + p.full_name"><Icon name="mail" /></a>
    </li>`,
};

// Butoanele de administrare ale unei subdiviziuni (aceleași în schemă și în listă).
const OrgAdmin = {
  components: { Icon },
  props: { unit: Object },
  inject: ['org'],
  template: /*html*/ `
    <div class="org-admin">
      <button type="button" class="icon-btn" title="Adaugă o subdiviziune subordonată" @click="org.addUnit(unit.id)"><Icon name="unit" /></button>
      <button type="button" class="icon-btn" title="Adaugă un angajat în această subdiviziune" @click="org.addUser(unit.id)"><Icon name="user" /></button>
      <button type="button" class="icon-btn" title="Modifică subdiviziunea" @click="org.editUnit(unit)"><Icon name="edit" /></button>
      <button type="button" class="icon-btn danger" title="Șterge subdiviziunea" @click="org.removeUnit(unit)"><Icon name="trash" /></button>
    </div>`,
};

const orgNodeMixin = {
  props: { unit: Object, depth: { type: Number, default: 0 } },
  inject: ['org'],
  computed: {
    admin: isAdmin,
    ui: () => orgUi,
    children() {
      return childUnits(this.unit.id);
    },
    people() {
      return peopleOf(this.unit.id);
    },
    total() {
      return subtreePeople(this.unit.id);
    },
    collapsed() {
      return this.children.length > 0 && orgUi.collapsed.has(this.unit.id);
    },
    showAll() {
      return orgUi.morePeople.has(this.unit.id) || !!this.org.q();
    },
    shownPeople() {
      return this.showAll ? this.people : this.people.slice(0, ORG_PREVIEW);
    },
    hit() {
      return this.org.unitHit(this.unit);
    },
  },
  methods: {
    plural,
    toggle() {
      const s = orgUi.collapsed;
      s.has(this.unit.id) ? s.delete(this.unit.id) : s.add(this.unit.id);
    },
    toggleMore() {
      const s = orgUi.morePeople;
      s.has(this.unit.id) ? s.delete(this.unit.id) : s.add(this.unit.id);
    },
  },
};

// Vizualizarea „Schemă”: arbore de sus în jos, cu linii de legătură.
const OrgChartNode = {
  name: 'OrgChartNode',
  mixins: [orgNodeMixin],
  components: { OrgPerson, OrgAdmin },
  computed: {
    // subdiviziunile finale (fără alte subdiviziuni) se așază una sub alta, ca schema să nu devină foarte lată
    stacked() {
      return this.children.length > 0 && this.children.every((c) => !childUnits(c.id).length) && (this.depth >= 1 || this.children.length > 5);
    },
  },
  template: /*html*/ `
    <li>
      <div class="oc-card" :id="'unit-' + unit.id" :class="['lvl' + Math.min(depth, 3), { hit, focus: ui.focus === unit.id }]">
        <div class="oc-top">
          <span class="oc-type">{{ unit.type || 'Subdiviziune' }}</span>
          <OrgAdmin v-if="admin" :unit="unit" />
        </div>
        <div class="oc-name">{{ unit.name }}</div>
        <div class="oc-count">
          {{ plural(people.length, 'angajat', 'angajați') }}<template v-if="children.length && total !== people.length"> · {{ total }} cu subordonații</template>
        </div>
        <ul v-if="people.length" class="oc-people">
          <OrgPerson v-for="p in shownPeople" :key="p.id" :p="p" :hit="org.personHit(p)" />
        </ul>
        <button v-if="people.length > ${ORG_PREVIEW} && !org.q()" type="button" class="oc-more" @click="toggleMore">
          {{ showAll ? 'Arată mai puțin' : 'Încă ' + (people.length - ${ORG_PREVIEW}) + '…' }}
        </button>
        <button v-if="children.length" type="button" class="oc-toggle" :class="{ closed: collapsed }" @click="toggle"
          :title="collapsed ? 'Arată ' + plural(children.length, 'subdiviziunea subordonată', 'subdiviziunile subordonate') : 'Ascunde subdiviziunile subordonate'"
          :aria-expanded="!collapsed">{{ collapsed ? children.length : '−' }}</button>
      </div>
      <ul v-if="children.length && !collapsed" :class="stacked ? 'oc-stack' : 'oc-level'">
        <OrgChartNode v-for="c in children" :key="c.id" :unit="c" :depth="depth + 1" />
      </ul>
    </li>`,
};

// Vizualizarea „Listă”: ierarhie indentată, potrivită pe ecrane înguste și pentru tipărire.
const OrgListNode = {
  name: 'OrgListNode',
  mixins: [orgNodeMixin],
  components: { OrgPerson, OrgAdmin },
  template: /*html*/ `
    <div class="ol-node">
      <div class="card ol-card" :id="'unit-' + unit.id" :class="['lvl' + Math.min(depth, 3), { hit, focus: ui.focus === unit.id }]">
        <div class="ol-head">
          <button v-if="children.length" type="button" class="ol-caret" :class="{ closed: collapsed }" @click="toggle" :aria-expanded="!collapsed" :aria-label="collapsed ? 'Extinde' : 'Restrânge'">▾</button>
          <span v-else class="ol-caret-space"></span>
          <h3>{{ unit.name }}</h3>
          <span v-if="unit.type" class="badge">{{ unit.type }}</span>
          <span class="muted small">{{ plural(people.length, 'angajat', 'angajați') }}<template v-if="collapsed"> · {{ plural(children.length, 'subdiviziune ascunsă', 'subdiviziuni ascunse') }}</template></span>
          <OrgAdmin v-if="admin" :unit="unit" class="ol-admin" />
        </div>
        <ul v-if="people.length" class="people">
          <OrgPerson v-for="p in people" :key="p.id" :p="p" :hit="org.personHit(p)" />
        </ul>
      </div>
      <div v-if="children.length && !collapsed" class="ol-children">
        <OrgListNode v-for="c in children" :key="c.id" :unit="c" :depth="depth + 1" />
      </div>
    </div>`,
};

const OrgView = {
  components: { OrgChartNode, OrgListNode, OrgPerson, Modal, UserForm },
  provide() {
    return {
      org: {
        addUnit: this.addUnit,
        editUnit: this.editUnit,
        removeUnit: this.removeUnit,
        addUser: (id) => (this.userUnit = id),
        q: () => this.query,
        unitHit: this.unitHit,
        personHit: this.personHit,
      },
    };
  },
  data: () => ({ q: '', unitForm: null, userUnit: null, busy: false }),
  computed: {
    store: () => store,
    ui: () => orgUi,
    admin: isAdmin,
    query() {
      return this.q.trim().toLowerCase();
    },
    roots: () => childUnits(null),
    unassigned: () => store.users.filter((u) => !store.units.some((x) => x.id === u.unit_id)),
    stats() {
      return plural(store.units.length, 'subdiviziune', 'subdiviziuni') + ' · ' + plural(store.users.length, 'angajat', 'angajați');
    },
    results() {
      const q = this.query;
      if (!q) return null;
      const people = store.users.filter((p) => this.personHit(p));
      const units = store.units.filter((u) => this.matches(u.name + ' ' + u.type));
      return { people: people.slice(0, 60), units: units.slice(0, 30), more: people.length > 60 };
    },
    zoomPct() {
      return Math.round(orgUi.zoom * 100) + '%';
    },
    parents() {
      // o subdiviziune nu poate fi mutată sub ea însăși sau sub una din subordinea ei
      const banned = this.unitForm && this.unitForm.id ? subtreeIds(this.unitForm.id) : new Set();
      return flatUnits().filter((u) => !banned.has(u.id));
    },
  },
  watch: {
    'ui.mode'(v) {
      writePref('org.mode', v);
      if (v === 'chart') this.$nextTick(this.center);
    },
    'ui.zoom'(v) {
      writePref('org.zoom', String(v));
    },
  },
  mounted() {
    this.$nextTick(this.center);
  },
  methods: {
    plural,
    unitPath,
    matches(text) {
      return String(text || '').toLowerCase().includes(this.query);
    },
    personHit(p) {
      return !!this.query && this.matches(p.full_name + ' ' + p.position + ' ' + p.email);
    },
    unitHit(u) {
      return !!this.query && (this.matches(u.name + ' ' + u.type) || peopleOf(u.id).some(this.personHit));
    },
    setZoom(step) {
      orgUi.zoom = step ? Math.min(1.5, Math.max(0.4, Math.round((orgUi.zoom + step) * 10) / 10)) : 1;
    },
    expandAll() {
      orgUi.collapsed.clear();
    },
    collapseAll() {
      // rămâne vizibil primul nivel sub conducere
      for (const u of store.units) if (childUnits(u.id).length && !this.roots.some((r) => r.id === u.id)) orgUi.collapsed.add(u.id);
    },
    // centrează schema pe orizontală (de obicei e mai lată decât ecranul)
    center() {
      const el = this.$refs.scroll;
      if (el) el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    },
    // Deschide ramura unei subdiviziuni și o aduce în centrul ecranului.
    reveal(unitId) {
      if (!unitId) return;
      const byId = new Map(store.units.map((u) => [u.id, u]));
      for (let u = byId.get(unitId); u; u = byId.get(u.parent_id)) {
        if (u.id !== unitId) orgUi.collapsed.delete(u.id);
      }
      orgUi.focus = unitId;
      this.$nextTick(() => {
        const el = document.getElementById('unit-' + unitId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      });
      clearTimeout(this.focusTimer);
      this.focusTimer = setTimeout(() => (orgUi.focus = null), 2200);
    },
    // Schema se poate deplasa trăgând cu mausul de fundal.
    pan(e) {
      if (e.button !== 0 || e.target.closest('.oc-card, button, a, input')) return;
      const el = this.$refs.scroll;
      const sx = e.clientX, sy = e.clientY, l = el.scrollLeft, t = el.scrollTop;
      el.classList.add('panning');
      const move = (ev) => {
        el.scrollLeft = l - (ev.clientX - sx);
        el.scrollTop = t - (ev.clientY - sy);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        el.classList.remove('panning');
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up, { once: true });
      e.preventDefault();
    },
    addUnit(parentId) {
      this.unitForm = { id: null, name: '', type: '', parent_id: parentId, sort: 0 };
    },
    editUnit(u) {
      this.unitForm = { id: u.id, name: u.name, type: u.type, parent_id: u.parent_id, sort: u.sort };
    },
    async saveUnit() {
      const f = this.unitForm;
      this.busy = true;
      const ok = await run(async () => {
        await api(f.id ? '/api/units/' + f.id : '/api/units', { method: f.id ? 'PUT' : 'POST', body: f });
        await loadShared();
      }, 'Organigrama a fost actualizată.');
      this.busy = false;
      if (ok) this.unitForm = null;
    },
    async removeUnit(u) {
      const ok = await ask({ title: 'Ștergeți subdiviziunea?', message: '„' + u.name + '” va fi eliminată din organigramă.', okLabel: 'Șterge', danger: true });
      if (!ok) return;
      await run(async () => {
        await api('/api/units/' + u.id, { method: 'DELETE' });
        await loadShared();
      }, 'Subdiviziunea a fost ștearsă.');
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Organigramă</h1>
        <p class="muted page-sub">{{ stats }}</p>
      </div>
      <button v-if="admin" class="btn primary" @click="addUnit(null)">+ Adaugă subdiviziune</button>
    </div>

    <div class="org-toolbar">
      <input v-model="q" type="search" class="org-search" placeholder="Caută o persoană, o funcție sau o subdiviziune…" aria-label="Caută în organigramă" />
      <div class="seg" role="group" aria-label="Mod de afișare">
        <button type="button" :class="{ on: ui.mode === 'chart' }" @click="ui.mode = 'chart'">Schemă</button>
        <button type="button" :class="{ on: ui.mode === 'list' }" @click="ui.mode = 'list'">Listă</button>
      </div>
      <div class="seg" role="group" aria-label="Ramuri">
        <button type="button" @click="expandAll" title="Arată toate subdiviziunile">Extinde tot</button>
        <button type="button" @click="collapseAll" title="Arată doar primele niveluri">Restrânge</button>
      </div>
      <div v-if="ui.mode === 'chart'" class="seg zoom" role="group" aria-label="Mărire">
        <button type="button" @click="setZoom(-0.1)" :disabled="ui.zoom <= 0.4" aria-label="Micșorează">−</button>
        <button type="button" class="zoom-val" @click="setZoom(0)" title="Mărime normală">{{ zoomPct }}</button>
        <button type="button" @click="setZoom(0.1)" :disabled="ui.zoom >= 1.5" aria-label="Mărește">+</button>
      </div>
    </div>

    <div v-if="results" class="card org-results">
      <div v-if="!results.people.length && !results.units.length" class="muted">Nimic găsit pentru „{{ q.trim() }}”.</div>
      <template v-if="results.units.length">
        <div class="section-title">Subdiviziuni</div>
        <div class="res-units">
          <button v-for="u in results.units" :key="u.id" type="button" class="res-unit" @click="reveal(u.id)">
            <b>{{ u.name }}</b><span class="muted small">{{ unitPath(u.id).slice(0, -1).join(' › ') || u.type || 'nivel superior' }}</span>
          </button>
        </div>
      </template>
      <template v-if="results.people.length">
        <div class="section-title" :class="{ spaced: results.units.length }">Persoane</div>
        <ul class="people res-people">
          <li v-for="p in results.people" :key="p.id" class="res-person">
            <ul class="bare"><OrgPerson :p="p" /></ul>
            <button v-if="p.unit_id && store.units.some((x) => x.id === p.unit_id)" type="button" class="btn link small" @click="reveal(p.unit_id)">{{ unitPath(p.unit_id).slice(-1)[0] }} ›</button>
            <span v-else class="muted small">fără subdiviziune</span>
          </li>
        </ul>
        <p v-if="results.more" class="muted small hint">Sunt afișate primele 60 de persoane; restrângeți căutarea.</p>
      </template>
    </div>

    <div v-if="!roots.length" class="card empty">
      Organigrama nu a fost încă definită.
      <div v-if="admin" class="mt10"><button class="btn primary" @click="addUnit(null)">+ Adaugă prima subdiviziune</button></div>
    </div>

    <div v-else-if="ui.mode === 'chart'" ref="scroll" class="oc-scroll card" @mousedown="pan">
      <div class="oc-canvas" :style="{ zoom: ui.zoom }">
        <ul class="oc-level oc-root">
          <OrgChartNode v-for="u in roots" :key="u.id" :unit="u" :depth="0" />
        </ul>
      </div>
    </div>

    <div v-else class="ol-tree">
      <OrgListNode v-for="u in roots" :key="u.id" :unit="u" :depth="0" />
    </div>

    <div v-if="admin && unassigned.length" class="card ol-card unassigned">
      <div class="ol-head"><h3>Fără subdiviziune</h3><span class="muted small">{{ plural(unassigned.length, 'persoană', 'persoane') }} · atribuiți-le din pagina „Utilizatori”</span></div>
      <ul class="people">
        <OrgPerson v-for="p in unassigned" :key="p.id" :p="p" />
      </ul>
    </div>

    <Modal v-if="unitForm" :title="unitForm.id ? 'Modifică subdiviziunea' : 'Subdiviziune nouă'" :busy="busy" @close="unitForm = null" @submit="saveUnit">
      <label class="field"><span>Denumirea *</span><input v-model="unitForm.name" maxlength="200" required autofocus placeholder="ex. Direcția juridică" /></label>
      <div class="row">
        <label class="field"><span>Tipul</span>
          <input v-model="unitForm.type" maxlength="60" list="unit-types" placeholder="ex. Direcție" />
          <datalist id="unit-types"><option>Conducere</option><option>Direcție</option><option>Serviciu</option><option>Secție</option></datalist>
        </label>
        <label class="field"><span>Ordinea de afișare</span><input v-model.number="unitForm.sort" type="number" /></label>
      </div>
      <label class="field"><span>Subordonată față de</span>
        <select v-model="unitForm.parent_id">
          <option :value="null">— nivelul superior —</option>
          <option v-for="u in parents" :key="u.id" :value="u.id">{{ u.label }}</option>
        </select>
      </label>
    </Modal>
    <UserForm v-if="userUnit" :unit-id="userUnit" @close="userUnit = null" @saved="userUnit = null" />`,
};

// ---------- categorii și etichete ----------
const CategoriesView = {
  components: { Modal },
  data: () => ({ catForm: null, newTag: {}, busy: false }),
  computed: { store: () => store },
  methods: {
    act(fn, msg) {
      return run(async () => {
        await fn();
        store.categories = await api('/api/categories');
      }, msg);
    },
    async saveCat() {
      const f = this.catForm;
      this.busy = true;
      const ok = await this.act(() => api(f.id ? '/api/categories/' + f.id : '/api/categories', { method: f.id ? 'PUT' : 'POST', body: f }), 'Categoria a fost salvată.');
      this.busy = false;
      if (ok) this.catForm = null;
    },
    async removeCat(c) {
      const ok = await ask({
        title: 'Ștergeți categoria?',
        message: '„' + c.name + '” va fi ștearsă împreună cu toate etichetele ei. Documentele rămân, dar pierd aceste etichete.',
        okLabel: 'Șterge categoria',
        danger: true,
      });
      if (ok) this.act(() => api('/api/categories/' + c.id, { method: 'DELETE' }), 'Categoria a fost ștearsă.');
    },
    async addTag(c) {
      const name = (this.newTag[c.id] || '').trim();
      if (!name) return;
      if (await this.act(() => api('/api/tags', { method: 'POST', body: { category_id: c.id, name } }))) this.newTag[c.id] = '';
    },
    async renameTag(t) {
      const name = await ask({ title: 'Redenumește eticheta', input: true, label: 'Denumirea etichetei', value: t.name, maxlength: 80, okLabel: 'Salvează' });
      if (name && name !== t.name) this.act(() => api('/api/tags/' + t.id, { method: 'PUT', body: { name } }), 'Eticheta a fost redenumită.');
    },
    async removeTag(t) {
      const ok = await ask({
        title: 'Ștergeți eticheta?',
        message: '„' + t.name + '” va fi ștearsă. Documentele rămân, dar pierd această etichetă.',
        okLabel: 'Șterge eticheta',
        danger: true,
      });
      if (ok) this.act(() => api('/api/tags/' + t.id, { method: 'DELETE' }), 'Eticheta a fost ștearsă.');
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Categorii și etichete</h1>
        <p class="muted page-sub">Categoriile grupează etichetele (ex. „Resurse umane” → „Concedii”). La adăugarea unui document se aleg una sau mai multe etichete.</p>
      </div>
      <button class="btn primary" @click="catForm = { id: null, name: '', color: '#1d4e89', sort: 0 }">+ Adaugă categorie</button>
    </div>
    <div class="cats">
      <div v-for="c in store.categories" :key="c.id" class="card cat" :style="{ borderTopColor: c.color }">
        <div class="cat-head">
          <h2>{{ c.name }}</h2>
          <button class="btn link" @click="catForm = { id: c.id, name: c.name, color: c.color, sort: c.sort }">Modifică</button>
          <button class="btn link danger" @click="removeCat(c)">Șterge</button>
        </div>
        <div v-for="t in c.tags" :key="t.id" class="tagrow">
          <span>{{ t.name }}</span>
          <span><button class="btn link" @click="renameTag(t)">Redenumește</button><button class="btn link danger" @click="removeTag(t)">Șterge</button></span>
        </div>
        <div v-if="!c.tags.length" class="muted small">Nicio etichetă încă.</div>
        <form class="addrow" @submit.prevent="addTag(c)">
          <input v-model="newTag[c.id]" maxlength="80" placeholder="Etichetă nouă…" />
          <button class="btn">Adaugă</button>
        </form>
      </div>
    </div>
    <div v-if="!store.categories.length" class="card empty">Nicio categorie. Adăugați prima categorie pentru a putea eticheta documentele.</div>

    <Modal v-if="catForm" :title="catForm.id ? 'Modifică categoria' : 'Categorie nouă'" :busy="busy" @close="catForm = null" @submit="saveCat">
      <label class="field"><span>Denumirea *</span><input v-model="catForm.name" maxlength="80" required autofocus placeholder="ex. Resurse umane" /></label>
      <div class="row">
        <label class="field"><span>Culoarea</span><input v-model="catForm.color" type="color" /></label>
        <label class="field"><span>Ordinea de afișare</span><input v-model.number="catForm.sort" type="number" /></label>
      </div>
    </Modal>`,
};

// ---------- jurnal de audit ----------
const yesterday = () => {
  const d = new Date(Date.now() - 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const AuditView = {
  data: () => ({ rows: [], total: 0, oldest: null, retention: 90, q: '', until: yesterday(), busy: false, loaded: false }),
  computed: {
    shown() {
      const q = this.q.trim().toLowerCase();
      return q ? this.rows.filter((r) => (r.username + ' ' + r.action + ' ' + r.details + ' ' + r.ip).toLowerCase().includes(q)) : this.rows;
    },
    maxDate: yesterday,
  },
  methods: {
    fmtDateTime,
    async load() {
      await run(async () => {
        const r = await api('/api/admin/audit');
        Object.assign(this, { rows: r.rows, total: r.total, oldest: r.oldest, retention: r.retentionDays });
      });
      this.loaded = true;
    },
    async prune() {
      if (!this.until) return;
      const shown = this.until.split('-').reverse().join('.');
      const ok = await ask({
        title: 'Curățați jurnalul?',
        message: 'Toate înregistrările până la ' + shown + ' inclusiv vor fi șterse definitiv. Ștergerea va rămâne consemnată în jurnal.',
        okLabel: 'Șterge înregistrările',
        danger: true,
      });
      if (!ok) return;
      this.busy = true;
      let r;
      if (await run(async () => (r = await api('/api/admin/audit/prune', { method: 'POST', body: { until: this.until } })))) {
        toast(r.deleted ? r.deleted + ' înregistrări au fost șterse.' : 'Nu existau înregistrări până la această dată.');
        await this.load();
      }
      this.busy = false;
    },
  },
  mounted() {
    this.load();
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Jurnal de activitate</h1>
        <p class="muted page-sub">
          Autentificări, descărcări, semnări și modificări. {{ total }} înregistrări<template v-if="oldest">, începând cu {{ fmtDateTime(oldest) }}</template><template v-if="total > rows.length"> (sunt afișate ultimele {{ rows.length }})</template>.
          Înregistrările mai vechi de {{ retention }} de zile se șterg automat.
        </p>
      </div>
      <div class="head-actions">
        <input v-model="q" type="search" placeholder="Filtrează după utilizator, acțiune, document…" class="search-sm" aria-label="Filtrează jurnalul" />
        <form class="prune" @submit.prevent="prune">
          <label class="prune-label" for="prune-until">Șterge până la</label>
          <input id="prune-until" v-model="until" type="date" :max="maxDate" required />
          <button class="btn danger" :disabled="busy || !until">{{ busy ? 'Se șterge…' : 'Curăță' }}</button>
        </form>
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Data</th><th>Utilizator</th><th>Acțiune</th><th>Detalii</th><th>Adresă IP</th></tr></thead>
        <tbody>
          <tr v-for="r in shown" :key="r.id">
            <td class="nowrap">{{ fmtDateTime(r.at) }}</td>
            <td><b>{{ r.username || '—' }}</b></td>
            <td>{{ r.action }}</td>
            <td>{{ r.details }}</td>
            <td class="muted small">{{ r.ip }}</td>
          </tr>
          <tr v-if="loaded && !shown.length"><td colspan="5" class="empty-row">{{ rows.length ? 'Nicio înregistrare nu corespunde filtrului.' : 'Jurnalul este gol.' }}</td></tr>
        </tbody>
      </table>
    </div>`,
};

// ---------- setări ----------
const SettingsView = {
  components: { BackupView },
  data: () => ({ f: null, busy: false, testTo: '' }),
  async mounted() {
    await run(async () => this.fill(await api('/api/admin/settings')));
    this.testTo = store.me.email || '';
  },
  methods: {
    fill(s) {
      this.f = { ...s, smtp_pass: '', clear_password: false };
      store.me.mailEnabled = !!s.smtp_host;
    },
    async save() {
      this.busy = true;
      await run(async () => this.fill(await api('/api/admin/settings', { method: 'PUT', body: this.f })), 'Setările au fost salvate.');
      this.busy = false;
    },
    async test() {
      this.busy = true;
      await run(() => api('/api/admin/settings/test', { method: 'POST', body: { to: this.testTo } }), 'E-mailul de test a fost trimis către ' + this.testTo + '.');
      this.busy = false;
    },
  },
  template: /*html*/ `
    <div class="settings-page">
      <div class="page-head">
        <div>
          <h1>Setări</h1>
          <p class="muted page-sub">E-mailul pentru notificările de semnare și copia de rezervă a datelor.</p>
        </div>
      </div>
      <div class="settings-grid">
        <form v-if="f" class="card panel" @submit.prevent="save">
          <div class="panel-head">
            <h2>E-mail (SMTP)</h2>
            <span class="pill" :class="f.smtp_host ? 'green' : 'gray'">{{ f.smtp_host ? 'Activ' : 'Dezactivat' }}</span>
          </div>
          <p class="muted small">Setările sunt păstrate în baza de date și rămân la actualizarea aplicației. Lăsați serverul gol pentru a dezactiva e-mailurile.</p>
          <div class="row">
            <label class="field grow2"><span>Server SMTP</span><input v-model="f.smtp_host" maxlength="200" placeholder="ex. mail.ansc.md" /></label>
            <label class="field"><span>Port</span><input v-model="f.smtp_port" inputmode="numeric" maxlength="5" placeholder="587" /></label>
            <label class="field"><span>Securitate</span>
              <select v-model="f.smtp_secure"><option value="">STARTTLS / automat</option><option value="tls">TLS direct (465)</option></select>
            </label>
          </div>
          <div class="row">
            <label class="field"><span>Utilizator</span><input v-model="f.smtp_user" maxlength="200" autocomplete="off" /></label>
            <label class="field"><span>Parolă</span>
              <input v-model="f.smtp_pass" type="password" autocomplete="new-password" :disabled="f.clear_password" :placeholder="f.has_password ? '•••••••• (salvată)' : ''" />
            </label>
          </div>
          <label v-if="f.has_password" class="check pull-up"><input type="checkbox" v-model="f.clear_password" /> Șterge parola salvată</label>
          <div class="row">
            <label class="field"><span>Expeditor</span><input v-model="f.smtp_from" maxlength="200" placeholder="e-Management ANSC <notificari@ansc.md>" /></label>
            <label class="field"><span>Adresa aplicației (linkuri în e-mailuri)</span><input v-model="f.app_url" maxlength="200" placeholder="ex. https://documente.ansc.md" /></label>
          </div>
          <div class="panel-foot">
            <button class="btn primary" :disabled="busy">Salvează setările</button>
          </div>
          <div class="test-box">
            <div><b>Verificare</b> <span class="muted small">— salvați setările, apoi trimiteți un e-mail de test.</span></div>
            <div class="addrow">
              <input v-model="testTo" type="email" placeholder="adresa@exemplu.md" aria-label="Adresa pentru e-mailul de test" />
              <button type="button" class="btn" :disabled="busy || !testTo || !f.smtp_host" @click="test">Trimite test</button>
            </div>
          </div>
        </form>
        <div v-else class="card panel boot-panel"><span class="spinner"></span></div>
        <BackupView />
      </div>
    </div>`,
};

// ---------- aplicația ----------
const App = {
  components: { Login, ForcedPassword, Brand, Modal, DialogHost, PasswordFields, DocsView, InboxView, OrgView, UsersView, CategoriesView, SettingsView, AuditView },
  data: () => ({ pass: null, passBusy: false, bump: false }),
  computed: {
    store: () => store,
    inbox: inboxCount,
    // [adresă, denumire, componentă]; notificările au propriul buton (cutia poștală) în dreapta barei
    routes() {
      const items = [['documente', 'Documente', 'DocsView'], ['organigrama', 'Organigramă', 'OrgView'], ['notificari', 'Notificări', 'InboxView']];
      if (isAdmin()) items.push(['utilizatori', 'Utilizatori', 'UsersView'], ['categorii', 'Categorii', 'CategoriesView'], ['setari', 'Setări', 'SettingsView'], ['jurnal', 'Jurnal', 'AuditView']);
      return items;
    },
    nav() {
      return this.routes.filter((n) => n[0] !== 'notificari');
    },
    view() {
      // adresa veche „#backup” duce acum la Setări, unde se află și copia de rezervă
      const route = store.route === 'backup' ? 'setari' : store.route;
      const item = this.routes.find((n) => n[0] === route);
      return item ? item[2] : 'DocsView';
    },
    pageClass() {
      return { wide: this.view === 'CategoriesView', fit: this.view === 'SettingsView' };
    },
    inboxLabel() {
      return this.inbox ? 'Notificări: ' + this.inbox + (this.inbox === 1 ? ' nouă' : ' noi') : 'Notificări: nicio notificare nouă';
    },
    title() {
      const item = store.me && !store.me.must_change && this.routes.find((n) => n[2] === this.view);
      return (item && this.inbox ? '(' + this.inbox + ') ' : '') + (item ? item[1] + ' · ' : '') + 'e-Management ANSC';
    },
  },
  methods: {
    async logout() {
      // chiar dacă serverul nu răspunde, pagina nu mai afișează datele contului
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      clearSession();
      this.pass = null;
    },
    async savePass() {
      this.passBusy = true;
      if (await changePassword(this.pass)) this.pass = null;
      this.passBusy = false;
    },
  },
  watch: {
    // titlul ferestrei arată pagina curentă și numărul de notificări
    title: {
      handler(t) {
        document.title = t;
      },
      immediate: true,
    },
    // o notificare nouă face cutia poștală să „sară” o dată, pe lângă animația continuă
    inbox(n, old) {
      if (n > old) {
        this.bump = false;
        requestAnimationFrame(() => (this.bump = true));
        setTimeout(() => (this.bump = false), 900);
      }
    },
  },
  template: /*html*/ `
    <template v-if="store.ready">
      <Login v-if="!store.me" />
      <ForcedPassword v-else-if="store.me.must_change" />
      <template v-else>
        <header class="topbar">
          <div class="topbar-in">
            <Brand />
            <nav class="nav">
              <a v-for="n in nav" :key="n[0]" :href="'#' + n[0]" :class="{ on: view === n[2], sep: n[0] === 'utilizatori' }">{{ n[1] }}</a>
            </nav>
            <div class="userbox">
              <a href="#notificari" class="mailbox" :class="{ on: view === 'InboxView', has: inbox, bump }" :title="inboxLabel" :aria-label="inboxLabel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 8.5 12 14l9-5.5"/><rect x="3" y="5" width="18" height="14" rx="2.5"/>
                </svg>
                <span v-if="inbox" class="mailbox-count">{{ inbox > 99 ? '99+' : inbox }}</span>
              </a>
              <span class="name">{{ store.me.full_name }}</span>
              <button class="btn sm" @click="pass = { current: '', next: '', again: '' }">Parolă</button>
              <button class="btn sm" @click="logout">Ieșire</button>
            </div>
          </div>
        </header>
        <main class="page" :class="pageClass"><component :is="view" /></main>
        <Modal v-if="pass" title="Schimbă parola" :busy="passBusy" @close="pass = null" @submit="savePass"><PasswordFields v-model="pass" /></Modal>
      </template>
    </template>
    <div v-else class="boot" aria-live="polite"><span class="spinner"></span>Se încarcă…</div>
    <DialogHost />
    <div v-if="store.toast" class="toast" :class="{ err: store.toast.err }" :role="store.toast.err ? 'alert' : 'status'" @click="store.toast = null">{{ store.toast.msg }}</div>`,
};

createApp(App).mount('#app');
loadSession();
