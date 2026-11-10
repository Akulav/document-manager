import { createApp, reactive } from 'vue';

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
  route: location.hash.slice(1) || 'documente',
});
window.addEventListener('hashchange', () => (store.route = location.hash.slice(1) || 'documente'));

let toastTimer;
function toast(msg, err = false) {
  store.toast = { msg, err };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (store.toast = null), err ? 5000 : 2500);
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
  const r = await fetch(url, init);
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401 && store.me) store.me = null;
    throw new Error((data && data.error) || 'Eroare de server.');
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
  try {
    store.me = await api('/api/me');
    if (!store.me.must_change) await Promise.all([loadShared(), loadDocs()]);
  } catch {
    store.me = null;
  }
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
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

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
const Modal = {
  props: { title: String, wide: Boolean, xl: Boolean, busy: Boolean, okLabel: { type: String, default: 'Salvează' } },
  emits: ['close', 'submit'],
  template: /*html*/ `
    <div class="overlay" @mousedown.self="$emit('close')">
      <form class="modal" :class="{ wide, xl }" @submit.prevent="$emit('submit')">
        <div class="modal-head"><h2>{{ title }}</h2><button type="button" class="x" @click="$emit('close')" aria-label="Închide">×</button></div>
        <div class="modal-body"><slot /></div>
        <div class="modal-foot">
          <button type="button" class="btn" @click="$emit('close')">Anulează</button>
          <button class="btn primary" :disabled="busy">{{ busy ? 'Se salvează…' : okLabel }}</button>
        </div>
      </form>
    </div>`,
};

const Brand = { template: /*html*/ `<div class="brand"><span class="brand-mark">ANSC</span><span>e-Management</span></div>` };

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
        <p class="muted small" style="margin:0 0 16px">Agenția Națională pentru Soluționarea Contestațiilor</p>
        <div v-if="error" class="error">{{ error }}</div>
        <label class="field"><span>Utilizator</span><input v-model="username" autocomplete="username" autofocus required /></label>
        <label class="field"><span>Parolă</span><input v-model="password" type="password" autocomplete="current-password" required /></label>
        <button class="btn primary" style="width:100%;justify-content:center" :disabled="busy">Intră în sistem</button>
      </form>
    </div>`,
};

const PasswordFields = {
  props: { modelValue: Object },
  template: /*html*/ `
    <label class="field"><span>Parola curentă</span><input v-model="modelValue.current" type="password" autocomplete="current-password" required /></label>
    <label class="field"><span>Parola nouă (cel puțin 8 caractere)</span><input v-model="modelValue.next" type="password" autocomplete="new-password" minlength="8" required /></label>
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
  data: () => ({ f: { current: '', next: '', again: '' } }),
  methods: {
    async submit() {
      if (await changePassword(this.f)) await loadSession();
    },
  },
  template: /*html*/ `
    <div class="login-wrap">
      <form class="login" @submit.prevent="submit">
        <Brand />
        <h1>Setați o parolă nouă</h1>
        <p class="muted small" style="margin:0 0 16px">Înainte de a continua, schimbați parola primită de la administrator.</p>
        <PasswordFields v-model="f" />
        <button class="btn primary" style="width:100%;justify-content:center">Salvează parola</button>
      </form>
    </div>`,
};

// ---------- documente ----------
const docDay = (d) => Number(d.doc_date.slice(8));
const docMon = (d) => MONTHS[Number(d.doc_date.slice(5, 7)) - 1].slice(0, 3) + ' ' + d.doc_date.slice(0, 4);
function visLabel(d) {
  if (d.visibility === 'all') return 'Toți angajații';
  const names = [...d.unitIds.map(unitName), ...d.userIds.map((id) => (store.users.find((u) => u.id === id) || {}).full_name || '—')];
  return names.length ? 'Vizibil pentru: ' + names.join(', ') : 'Privat (autor și administratori)';
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
    signPeople() {
      return this.match(this.signFilter, this.form.signerIds);
    },
    keptFiles() {
      return this.doc ? this.doc.files.filter((f) => !this.form.removeFileIds.includes(f.id)) : [];
    },
    mailHint() {
      return store.me.mailEnabled
        ? 'Semnatarii nou adăugați primesc un e-mail și o notificare în aplicație. Ei văd documentul indiferent de setările de vizibilitate.'
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
          <div class="drop" :class="{ over: dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="drop">
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

          <div class="section-title" style="margin-top:18px">Cine poate vedea documentul</div>
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
                <input v-model="userFilter" placeholder="Caută după nume…" style="margin-top:6px" />
                <div class="scroll">
                  <label v-for="u in people" :key="u.id" class="check">
                    <input type="checkbox" :checked="form.userIds.includes(u.id)" @change="toggle(form.userIds, u.id)" /> {{ u.full_name }}
                  </label>
                </div>
              </div>
            </div>
            <p class="muted small" style="margin:8px 0 0">O subdiviziune include automat și cele din subordinea ei. Autorul și administratorii văd documentul întotdeauna.</p>
          </div>

          <div class="section-title" style="margin-top:18px">Semnare</div>
          <label class="check"><input type="checkbox" v-model="needsSign" /> Documentul așteaptă să fie semnat</label>
          <div v-if="needsSign" class="vis-box">
            <b class="small">Cine trebuie să semneze</b>
            <input v-model="signFilter" placeholder="Caută după nume…" style="margin-top:6px" />
            <div class="scroll">
              <label v-for="u in signPeople" :key="u.id" class="check">
                <input type="checkbox" :checked="form.signerIds.includes(u.id)" @change="toggle(form.signerIds, u.id)" /> {{ u.full_name }}
                <span v-if="!u.email" class="muted small">(fără e-mail)</span>
              </label>
            </div>
            <p class="muted small" style="margin:8px 0 0">{{ mailHint }}</p>
          </div>
        </div>
      </div>
    </Modal>`,
};

const DocCard = {
  props: { doc: Object },
  emits: ['edit'],
  computed: {
    tags: () => tagIndex(),
    pending() {
      return this.doc.signers.filter((s) => !s.signed_at).length;
    },
  },
  methods: {
    chipStyle,
    fmtSize,
    docDay,
    docMon,
    visLabel,
    // serverul marchează documentul ca văzut când se deschide un fișier; reîmprospătăm lista puțin mai târziu
    opened() {
      if (this.doc.unseen) setTimeout(() => loadDocs().catch(() => {}), 800);
    },
    act(url, msg) {
      return run(async () => {
        await api(url, { method: 'POST' });
        await loadDocs();
      }, msg);
    },
    sign() {
      if (confirm('Confirmați că ați semnat documentul „' + this.doc.title + '”?')) this.act('/api/documents/' + this.doc.id + '/sign', 'Semnarea a fost confirmată.');
    },
    async remind() {
      try {
        const r = await api('/api/documents/' + this.doc.id + '/remind', { method: 'POST' });
        const note = mailNote(r.mail);
        toast(note || 'Notificarea a fost retrimisă pe e-mail.', !!note);
      } catch (e) {
        toast(e.message, true);
      }
    },
    async remove() {
      if (!confirm('Ștergeți definitiv documentul „' + this.doc.title + '” împreună cu fișierele atașate?')) return;
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
        <div v-if="doc.files.length" class="files">
          <a v-for="f in doc.files" :key="f.id" class="file" :href="'/api/files/' + f.id" target="_blank" rel="noopener" @click="opened">
            {{ f.name }} <span class="muted small">{{ fmtSize(f.size) }}</span>
          </a>
        </div>
        <div v-if="doc.signers.length" class="signbox" :class="{ done: !pending }">
          <b>{{ pending ? 'În așteptarea semnării' : 'Semnat de toți' }}</b>
          <span class="small">{{ doc.signers.length - pending }}/{{ doc.signers.length }}</span>
          <span v-for="s in doc.signers" :key="s.id" class="signer" :class="{ ok: s.signed_at }">{{ s.signed_at ? '✓' : '○' }} {{ s.name }}</span>
          <button v-if="doc.mySign === 'pending'" class="btn primary sm" @click="sign">Confirm că am semnat</button>
          <button v-if="doc.canEdit && pending" class="btn link" @click="remind">Retrimite e-mail</button>
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
        <button v-if="doc.unseen" class="btn link" @click="act('/api/documents/' + doc.id + '/seen')">Marchează ca văzut</button>
        <button v-if="doc.canEdit" class="btn link" @click="$emit('edit', doc)">Modifică</button>
        <button v-if="doc.canEdit" class="btn link danger" @click="remove">Șterge</button>
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
      if (!confirm('Importul ÎNLOCUIEȘTE toate datele actuale (utilizatori, organigramă, documente, fișiere) cu cele din arhivă. Continuați?')) return;
      this.busy = true;
      try {
        const r = await api('/api/admin/import', { method: 'POST', raw: this.file });
        alert(
          'Import finalizat: ' + r.documents + ' documente, ' + r.files + ' fișiere, ' + r.users + ' utilizatori.' +
            (r.missing ? '\n' + r.missing + ' fișiere lipseau deja la momentul exportului.' : '') +
            '\n\nAutentificați-vă din nou cu un cont din arhivă.'
        );
        location.reload();
      } catch (e) {
        toast(e.message, true);
      }
      this.busy = false;
    },
  },
  template: /*html*/ `
    <div class="page-head"><h1>Copie de rezervă</h1></div>
    <div class="cats">
      <div class="card cat" style="border-top-color:var(--accent)">
        <h2>Export complet</h2>
        <p class="muted">Un singur fișier comprimat cu absolut tot: utilizatori (cu parolele criptate), organigramă, categorii, documente, semnături și toate fișierele atașate. Fiecare element are sumă de control.</p>
        <a class="btn primary" href="/api/admin/export" download>Descarcă exportul</a>
        <p class="muted small" style="margin-bottom:0">Păstrați fișierul într-un loc sigur: conține toate documentele, indiferent de vizibilitate.</p>
      </div>
      <div class="card cat" style="border-top-color:var(--danger)">
        <h2>Import (restaurare)</h2>
        <p class="muted">Înlocuiește toate datele actuale cu cele dintr-un export. Arhiva este verificată integral înainte de a modifica ceva; dacă este deteriorată sau incompletă, nu se schimbă nimic.</p>
        <input type="file" accept=".anscbackup" @change="file = $event.target.files[0] || null" />
        <p v-if="file" class="muted small">{{ file.name }} — {{ fmtSize(file.size) }}</p>
        <button class="btn danger" style="margin-top:10px" :disabled="!file || busy" @click="restore">{{ busy ? 'Se importă… nu închideți pagina' : 'Importă și înlocuiește tot' }}</button>
      </div>
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
    async submit() {
      this.busy = true;
      const ok = await run(async () => {
        await api(this.user ? '/api/users/' + this.user.id : '/api/users', { method: this.user ? 'PUT' : 'POST', body: this.form });
        await loadShared();
      }, this.user ? 'Utilizatorul a fost actualizat.' : 'Utilizatorul a fost adăugat.');
      this.busy = false;
      if (ok) this.$emit('saved');
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
          <input v-model="form.password" type="text" minlength="8" :required="!user" autocomplete="off" placeholder="cel puțin 8 caractere" />
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
      <p class="muted small" style="margin:8px 0 0">La prima autentificare (sau după resetarea parolei) utilizatorul va fi obligat să își seteze o parolă proprie.</p>
    </Modal>`,
};

const UsersView = {
  components: { UserForm },
  data: () => ({ users: [], editing: undefined }),
  methods: {
    unitName,
    role: (r) => ROLES[r],
    async load() {
      await run(async () => (this.users = await api('/api/users')));
    },
    async saved() {
      this.editing = undefined;
      await this.load();
    },
    async remove(u) {
      if (!confirm('Ștergeți definitiv contul „' + u.full_name + '”? Documentele adăugate de această persoană rămân în sistem.')) return;
      const ok = await run(async () => {
        await api('/api/users/' + u.id, { method: 'DELETE' });
        await loadShared();
      }, 'Utilizatorul a fost șters.');
      if (ok) this.load();
    },
  },
  mounted() {
    this.load();
  },
  template: /*html*/ `
    <div class="page-head">
      <h1>Utilizatori</h1>
      <button class="btn primary" @click="editing = null">+ Adaugă utilizator</button>
    </div>
    <div class="card" style="overflow:auto">
      <table>
        <thead><tr><th>Nume și prenume</th><th>Utilizator</th><th>Funcția</th><th>Subdiviziunea</th><th>Rol</th><th>Stare</th><th></th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id" :class="{ off: !u.active }">
            <td><b>{{ u.full_name }}</b></td>
            <td>{{ u.username }}</td>
            <td>{{ u.position || '—' }}</td>
            <td>{{ u.unit_id ? unitName(u.unit_id) : '—' }}</td>
            <td><span class="badge" :class="{ gray: u.role === 'user' }">{{ role(u.role) }}</span></td>
            <td>{{ u.active ? 'Activ' : 'Dezactivat' }}</td>
            <td style="white-space:nowrap;text-align:right">
              <button class="btn link" @click="editing = u">Modifică</button>
              <button class="btn link danger" @click="remove(u)">Șterge</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <UserForm v-if="editing !== undefined" :user="editing" @close="editing = undefined" @saved="saved" />`,
};

// ---------- organigramă ----------
const OrgNode = {
  name: 'OrgNode',
  props: { unit: Object },
  inject: ['org'],
  computed: {
    admin: isAdmin,
    children() {
      return childUnits(this.unit.id);
    },
    people() {
      return store.users.filter((u) => u.unit_id === this.unit.id);
    },
  },
  methods: { initials },
  template: /*html*/ `
    <div class="org-node">
      <div class="card org-card">
        <div class="org-head">
          <h3>{{ unit.name }}</h3>
          <span v-if="unit.type" class="badge">{{ unit.type }}</span>
          <span class="muted small">{{ people.length }} {{ people.length === 1 ? 'angajat' : 'angajați' }}</span>
          <div v-if="admin" class="org-actions">
            <button class="btn link" @click="org.addUnit(unit.id)">+ Subdiviziune</button>
            <button class="btn link" @click="org.addUser(unit.id)">+ Angajat</button>
            <button class="btn link" @click="org.editUnit(unit)">Modifică</button>
            <button class="btn link danger" @click="org.removeUnit(unit)">Șterge</button>
          </div>
        </div>
        <ul v-if="people.length" class="people">
          <li v-for="p in people" :key="p.id" class="person">
            <span class="avatar">{{ initials(p.full_name) }}</span>
            <div><b>{{ p.full_name }}</b><span class="muted small">{{ p.position || '—' }}</span></div>
          </li>
        </ul>
      </div>
      <div v-if="children.length" class="org-children">
        <OrgNode v-for="c in children" :key="c.id" :unit="c" />
      </div>
    </div>`,
};

const OrgView = {
  components: { OrgNode, Modal, UserForm },
  provide() {
    return { org: { addUnit: this.addUnit, editUnit: this.editUnit, removeUnit: this.removeUnit, addUser: (id) => (this.userUnit = id) } };
  },
  data: () => ({ unitForm: null, userUnit: null, busy: false }),
  computed: {
    admin: isAdmin,
    roots: () => childUnits(null),
    unassigned: () => store.users.filter((u) => !store.units.some((x) => x.id === u.unit_id)),
    parents() {
      // o subdiviziune nu poate fi mutată sub ea însăși sau sub una din subordinea ei
      const banned = new Set();
      const mark = (id) => {
        banned.add(id);
        childUnits(id).forEach((c) => mark(c.id));
      };
      if (this.unitForm && this.unitForm.id) mark(this.unitForm.id);
      return flatUnits().filter((u) => !banned.has(u.id));
    },
  },
  methods: {
    initials,
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
      if (!confirm('Ștergeți subdiviziunea „' + u.name + '”?')) return;
      await run(async () => {
        await api('/api/units/' + u.id, { method: 'DELETE' });
        await loadShared();
      }, 'Subdiviziunea a fost ștearsă.');
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <h1>Organigramă</h1>
      <button v-if="admin" class="btn primary" @click="addUnit(null)">+ Adaugă subdiviziune</button>
    </div>
    <div v-if="!roots.length" class="card empty">Organigrama nu a fost încă definită.</div>
    <OrgNode v-for="u in roots" :key="u.id" :unit="u" />

    <div v-if="admin && unassigned.length" class="card org-card" style="margin-top:24px">
      <div class="org-head"><h3>Fără subdiviziune</h3><span class="muted small">atribuiți-i din pagina „Utilizatori”</span></div>
      <ul class="people">
        <li v-for="p in unassigned" :key="p.id" class="person">
          <span class="avatar">{{ initials(p.full_name) }}</span>
          <div><b>{{ p.full_name }}</b><span class="muted small">{{ p.position || '—' }}</span></div>
        </li>
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
    removeCat(c) {
      if (!confirm('Ștergeți categoria „' + c.name + '” cu toate etichetele ei? Documentele rămân, dar pierd aceste etichete.')) return;
      this.act(() => api('/api/categories/' + c.id, { method: 'DELETE' }), 'Categoria a fost ștearsă.');
    },
    async addTag(c) {
      const name = (this.newTag[c.id] || '').trim();
      if (!name) return;
      if (await this.act(() => api('/api/tags', { method: 'POST', body: { category_id: c.id, name } }))) this.newTag[c.id] = '';
    },
    renameTag(t) {
      const name = prompt('Denumirea etichetei:', t.name);
      if (name && name.trim() && name.trim() !== t.name) this.act(() => api('/api/tags/' + t.id, { method: 'PUT', body: { name } }));
    },
    removeTag(t) {
      if (!confirm('Ștergeți eticheta „' + t.name + '”? Documentele rămân, dar pierd această etichetă.')) return;
      this.act(() => api('/api/tags/' + t.id, { method: 'DELETE' }));
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Categorii și etichete</h1>
        <p class="muted" style="margin:4px 0 0">Categoriile grupează etichetele (ex. „Resurse umane” → „Concedii”). La adăugarea unui document se aleg una sau mai multe etichete.</p>
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

// ---------- setări ----------
const SettingsView = {
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
    <div class="page-head"><h1>Setări</h1></div>
    <form v-if="f" class="card" style="padding:20px;max-width:760px" @submit.prevent="save">
      <h2>E-mail (SMTP)</h2>
      <p class="muted" style="margin:4px 0 14px">Folosit pentru notificările de semnare. Setările sunt păstrate în baza de date, deci rămân neschimbate la actualizarea aplicației. Lăsați serverul gol pentru a dezactiva e-mailurile.</p>
      <div class="row">
        <label class="field" style="flex:2"><span>Server SMTP</span><input v-model="f.smtp_host" maxlength="200" placeholder="ex. mail.ansc.md" /></label>
        <label class="field"><span>Port</span><input v-model="f.smtp_port" inputmode="numeric" maxlength="5" placeholder="587" /></label>
        <label class="field"><span>Securitate</span>
          <select v-model="f.smtp_secure"><option value="">STARTTLS / automat</option><option value="tls">TLS direct (465)</option></select>
        </label>
      </div>
      <div class="row">
        <label class="field"><span>Utilizator</span><input v-model="f.smtp_user" maxlength="200" autocomplete="off" /></label>
        <label class="field"><span>Parolă</span>
          <input v-model="f.smtp_pass" type="password" autocomplete="new-password" :placeholder="f.has_password ? '•••••••• (salvată; completați doar pentru a o schimba)' : ''" />
        </label>
      </div>
      <label v-if="f.has_password" class="check" style="margin:-6px 0 10px"><input type="checkbox" v-model="f.clear_password" /> Șterge parola salvată</label>
      <label class="field"><span>Expeditor</span><input v-model="f.smtp_from" maxlength="200" placeholder="e-Management ANSC <notificari@ansc.md>" /></label>
      <label class="field"><span>Adresa aplicației (pentru linkurile din e-mailuri)</span><input v-model="f.app_url" maxlength="200" placeholder="ex. https://documente.ansc.md — implicit, adresa de la care lucrați" /></label>
      <button class="btn primary" :disabled="busy">Salvează setările</button>

      <h2 style="margin-top:24px">Verificare</h2>
      <p class="muted" style="margin:4px 0 10px">Salvați setările, apoi trimiteți un e-mail de test.</p>
      <div class="addrow" style="max-width:480px">
        <input v-model="testTo" type="email" placeholder="adresa@exemplu.md" />
        <button type="button" class="btn" :disabled="busy || !testTo" @click="test">Trimite test</button>
      </div>
    </form>`,
};

// ---------- aplicația ----------
const App = {
  components: { Login, ForcedPassword, Brand, Modal, PasswordFields, DocsView, InboxView, OrgView, UsersView, CategoriesView, BackupView, SettingsView },
  data: () => ({ pass: null }),
  computed: {
    store: () => store,
    inbox: inboxCount,
    nav() {
      const items = [['documente', 'Documente', 'DocsView'], ['notificari', 'Notificări', 'InboxView'], ['organigrama', 'Organigramă', 'OrgView']];
      if (isAdmin()) items.push(['utilizatori', 'Utilizatori', 'UsersView'], ['categorii', 'Categorii', 'CategoriesView'], ['backup', 'Backup', 'BackupView'], ['setari', 'Setări', 'SettingsView']);
      return items;
    },
    view() {
      const item = this.nav.find((n) => n[0] === store.route);
      return item ? item[2] : 'DocsView';
    },
  },
  methods: {
    async logout() {
      await run(() => api('/api/logout', { method: 'POST' }));
      store.me = null;
    },
    async savePass() {
      if (await changePassword(this.pass)) this.pass = null;
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
              <a v-for="n in nav" :key="n[0]" :href="'#' + n[0]" :class="{ on: view === n[2] }">{{ n[1] }}<span v-if="n[0] === 'notificari' && inbox" class="nav-count">{{ inbox }}</span></a>
            </nav>
            <div class="userbox">
              <span class="name">{{ store.me.full_name }}</span>
              <button class="btn sm" @click="pass = { current: '', next: '', again: '' }">Parolă</button>
              <button class="btn sm" @click="logout">Ieșire</button>
            </div>
          </div>
        </header>
        <main class="page"><component :is="view" /></main>
        <Modal v-if="pass" title="Schimbă parola" @close="pass = null" @submit="savePass"><PasswordFields v-model="pass" /></Modal>
      </template>
    </template>
    <div v-if="store.toast" class="toast" :class="{ err: store.toast.err }" role="status">{{ store.toast.msg }}</div>`,
};

createApp(App).mount('#app');
loadSession();
