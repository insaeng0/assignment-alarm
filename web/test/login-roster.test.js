const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const candidate = (n, class_number) => ({ roster_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: '테스트학생', grade: 1, class_number });
const profile = { name: '테스트학생', email: '26_99999@bssm.hs.kr' };
function page() {
  const nodes = new Map(), listeners = new Map(), sent = [], routes = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, hidden: false, disabled: false, value: ['googleGrade', 'googleClass'].includes(id) ? '1' : '', innerHTML: '', textContent: '', required: false,
      addEventListener(kind, callback) { listeners.set(id + ':' + kind, callback); }
    });
    return nodes.get(id);
  };
  const API = { normalizeUser: user => user, setUser() {}, landingPage: () => 'calendar.html',
    ensureUser: async () => null, publicConfig: () => new Promise(() => {}),
    googleRegister: async payload => { sent.push(payload); return { user: { id: 7, grade: 1, class_number: payload.class_number } }; }
  };
  const context = vm.createContext({ API, document: { getElementById: node }, window: { location: { replace: url => routes.push(url) } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/login.js'), 'utf8'), context);
  const show = response => {
    context.response = response;
    context.profile = profile;
    vm.runInContext("showGoogleProfileForm(profile, 'signed-setup', response); setGoogleUiBusy(false)", context);
  };
  return { node, show, sent, routes, context, listeners,
    submit: () => listeners.get('googleProfileForm:submit')({ preventDefault() {} }) };
}

test('one roster match preselects the class and ignores tampered manual fields', async () => {
  const app = page();
  app.show({ rosterRequired: true, rosterCandidates: [candidate(1, 3)] });
  assert.equal(app.node('googleManualScope').hidden, true);
  assert.equal(app.node('googleRosterChoice').hidden, true);
  assert.match(app.node('googleRosterHint').textContent, /1학년 3반/);
  app.node('googleGrade').value = '2';
  app.node('googleClass').value = '4';
  await app.submit();
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].grade, 1);
  assert.equal(app.sent[0].class_number, 3);
  assert.equal(app.sent[0].roster_id, candidate(1, 3).roster_id);
  assert.deepEqual(app.routes, ['calendar.html']);
});

test('same-name matches require an explicit class selection and expose no other names', async () => {
  const app = page();
  app.show({ rosterRequired: true, rosterCandidates: [candidate(1, 3), candidate(2, 4)] });
  const choice = app.node('googleRosterChoice');
  assert.equal(choice.hidden, false);
  assert.equal(choice.value, '');
  assert.match(choice.innerHTML, /1학년 3반/);
  assert.match(choice.innerHTML, /1학년 4반/);
  assert.ok(!choice.innerHTML.includes('테스트학생'));
  await app.submit();
  assert.equal(app.sent.length, 0);
  assert.match(app.node('authError').textContent, /선택/);
  choice.value = candidate(2, 4).roster_id;
  await app.submit();
  assert.equal(app.sent[0].class_number, 4);
});

test('claimed or malformed roster choices never fall through to manual enrollment', async () => {
  for (const choices of [[], [candidate(1, 3), candidate(1, 3)], [{ ...candidate(1, 3), name: '다른학생' }], [{ ...candidate(1, 3), roster_id: '"><script>' }]]) {
    const app = page();
    app.show({ rosterRequired: true, rosterCandidates: choices });
    assert.equal(app.node('googleProfileBtn').disabled, true);
    await app.submit();
    assert.equal(app.sent.length, 0);
    assert.ok(!app.node('googleRosterChoice').innerHTML.includes('<script>'));
  }
});

test('an ambiguous name still requires a choice when only one unclaimed class remains', async () => {
  const app = page();
  app.show({ rosterRequired: true, rosterAmbiguous: true, rosterCandidates: [candidate(2, 4)] });
  assert.equal(app.node('googleRosterChoice').hidden, false);
  assert.equal(app.node('googleRosterChoice').value, '');
  await app.submit();
  assert.equal(app.sent.length, 0);
  app.node('googleRosterChoice').value = candidate(2, 4).roster_id;
  await app.submit();
  assert.equal(app.sent[0].class_number, 4);
});

test('old servers and unmatched names retain the previous manual class form', async () => {
  for (const response of [{}, { rosterRequired: false, rosterCandidates: [] }]) {
    const app = page();
    app.show(response);
    app.node('googleGrade').value = '2'; app.node('googleClass').value = '4';
    assert.equal(app.node('googleManualScope').hidden, false);
    assert.equal(app.node('googleGrade').disabled, false);
    await app.submit();
    assert.equal(app.sent[0].grade, 2);
    assert.equal(app.sent[0].class_number, 4);
    assert.equal(app.sent[0].roster_id, undefined);
  }
});

test('returning to sign-in clears a previous roster selection before the next account', async () => {
  const app = page();
  app.show({ rosterRequired: true, rosterCandidates: [candidate(1, 3)] });
  app.listeners.get('cancelGoogleSetup:click')();
  assert.equal(app.node('googleRosterChoice').value, '');
  assert.equal(app.node('googleRosterBox').hidden, true);
  app.show({});
  await app.submit();
  assert.equal(app.sent[0].roster_id, undefined);
  assert.equal(app.sent[0].class_number, 1);
});
