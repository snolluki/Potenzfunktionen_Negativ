'use strict';
/*
 * Potenzfunktionen f(x) = x^n mit negativem Exponenten n – Placemat-Erkundung (UB Mathe 4)
 *
 * Start lokal:  npm install  &&  npm start   ->  http://localhost:3000
 * Lernende:     /?c=CODE     (QR-Code am Smartboard)
 * Lehrkraft:    /lehrkraft   (Smartboard)
 * Frei:         /?frei       (ohne Anmeldung, z. B. zu Hause)
 *
 * Phasen: Ich (Einzelarbeit) – Du (Vorstellen in der Gruppe) – Zeichnung (Graph der Gruppenfunktion
 * in der Mitte des Placemats). Die anschließende Galerie läuft ohne Geräte.
 *
 * Umgebungsvariable (bei Render unter "Environment" setzen):
 *   LEHRER_PASSWORT   Passwort zum Anlegen einer Stunde (dringend empfohlen)
 *
 * Datenschutz: Es werden keine Namen erhoben. Gespeichert werden nur
 * Gruppennummer und Schwerpunkt je Gerät, nur im Arbeitsspeicher, und
 * spätestens nach 12 Stunden gelöscht.
 */

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const PASSWORT = String(process.env.LEHRER_PASSWORT || '').trim();
const LEBENSDAUER_MS = 12 * 60 * 60 * 1000;
const MAX_GRUPPEN = 8;
const MAX_PRO_GRUPPE = 5;
const SCHWERPUNKTE = 5;
const PHASEN = ['ich', 'du', 'zeichnung'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const INDEX = path.join(__dirname, 'index.html');
app.disable('x-powered-by');
app.get(['/', '/lehrkraft'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(INDEX);
});
app.get('/health', (req, res) => res.type('text/plain').send('ok'));
app.get('/config.json', (req, res) => res.json({ passwortNoetig: PASSWORT !== '' }));
app.get('/lib/qrcode.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')));

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                     */
/* ------------------------------------------------------------------ */

const stunden = new Map();
const ganz = (v, min, max) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const mischen = a => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
function neuerCode() {
  const z = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += z[crypto.randomInt(z.length)];
  } while (stunden.has(c));
  return c;
}
const neueId = () => crypto.randomBytes(8).toString('hex');

function neueStunde(gruppen) {
  return {
    code: neuerCode(),
    token: crypto.randomBytes(16).toString('hex'),
    gruppen,
    phase: 'ich',
    pause: false,
    lernende: {},          // id -> { id, gruppe, sp, seit }
    duSchritt: {},         // gruppe -> 1..6 (6 = fertig)
    funktion: {},          // gruppe -> Betrag des Exponenten (Funktion x^-k) für die Zeichnung
    updatedAt: Date.now(),
  };
}

function belegung(s, g) {
  return Object.values(s.lernende).filter(l => l.gruppe === g).map(l => l.sp);
}

/** Prüft, ob ein Schwerpunkt in einer Gruppe gewählt werden darf. */
function wahlPruefen(s, g, sp, eigeneId) {
  if (!ganz(g, 1, s.gruppen)) return 'Diese Gruppe gibt es nicht.';
  if (!ganz(sp, 1, SCHWERPUNKTE)) return 'Diesen Schwerpunkt gibt es nicht.';
  const andere = Object.values(s.lernende).filter(l => l.gruppe === g && l.id !== eigeneId);
  if (andere.some(l => l.sp === sp)) return `Schwerpunkt ${sp} ist in Gruppe ${g} schon vergeben. Wähle einen anderen.`;
  if (andere.length >= MAX_PRO_GRUPPE) return `Gruppe ${g} ist schon voll.`;
  if (sp === 5) {
    const belegt = new Set(andere.map(l => l.sp));
    if (![1, 2, 3, 4].every(k => belegt.has(k))) {
      return 'Schwerpunkt 5 gibt es nur in Fünfergruppen. Wählt zuerst die Schwerpunkte 1 bis 4.';
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Ansichten                                                           */
/* ------------------------------------------------------------------ */

const online = new Map(); // lernenden-id -> Anzahl verbundener Sockets
const istOnline = id => (online.get(id) || 0) > 0;

function lehrkraftAnsicht(s) {
  return {
    code: s.code,
    gruppen: s.gruppen,
    phase: s.phase,
    pause: s.pause,
    lernende: Object.values(s.lernende)
      .sort((a, b) => a.gruppe - b.gruppe || a.sp - b.sp)
      .map(l => ({ id: l.id, gruppe: l.gruppe, sp: l.sp, online: istOnline(l.id) })),
    duSchritt: s.duSchritt,
    funktion: s.funktion,
  };
}

function schuelerAnsicht(s, id) {
  const ich = id ? s.lernende[id] : null;
  const vergeben = {};
  for (let g = 1; g <= s.gruppen; g++) vergeben[g] = belegung(s, g);
  const v = { phase: s.phase, pause: s.pause, gruppen: s.gruppen, vergeben, ich: null };
  if (ich) {
    v.ich = { gruppe: ich.gruppe, sp: ich.sp };
    const schritt = s.duSchritt[ich.gruppe] || 1;
    v.du = { schritt, experte: vergeben[ich.gruppe].includes(schritt) };
    v.funktion = s.funktion[ich.gruppe] || null;
  }
  return v;
}

async function verteilen(s) {
  s.updatedAt = Date.now();
  io.to('t:' + s.code).emit('lk:zustand', lehrkraftAnsicht(s));
  const sockets = await io.in('s:' + s.code).fetchSockets();
  for (const so of sockets) so.emit('s:ansicht', schuelerAnsicht(s, so.data.id));
}

/* ------------------------------------------------------------------ */
/* Lehrkraft-Aktionen                                                  */
/* ------------------------------------------------------------------ */

function funktionenVerteilen(s) {
  const exps = mischen([5, 6, 7, 8, 9]);
  s.funktion = {};
  for (let g = 1; g <= s.gruppen; g++) s.funktion[g] = exps[(g - 1) % exps.length];
}

function aktion(s, d) {
  switch (d.typ) {
    case 'phase': {
      if (!PHASEN.includes(d.phase)) return 'Unbekannte Phase.';
      s.phase = d.phase;
      s.pause = false;
      if (d.phase === 'du') {
        for (let g = 1; g <= s.gruppen; g++) if (!s.duSchritt[g]) s.duSchritt[g] = 1;
      }
      if (d.phase === 'zeichnung' && !Object.keys(s.funktion).length) funktionenVerteilen(s);
      return null;
    }
    case 'pause':
      s.pause = !!d.an;
      return null;
    case 'gruppenzahl': {
      const n = ganz(d.n, 1, MAX_GRUPPEN);
      if (!n) return 'Ungültige Gruppenzahl.';
      if (Object.values(s.lernende).some(l => l.gruppe > n)) {
        return `In Gruppe ${n + 1} oder höher sind noch Geräte angemeldet. Entferne sie zuerst.`;
      }
      s.gruppen = n;
      if (Object.keys(s.funktion).length) funktionenVerteilen(s);
      return null;
    }
    case 'entfernen':
      delete s.lernende[d.id];
      return null;
    case 'duSetzen': {
      const g = ganz(d.gruppe, 1, s.gruppen);
      const k = ganz(d.schritt, 1, SCHWERPUNKTE + 1);
      if (!g || !k) return null;
      s.duSchritt[g] = k;
      return null;
    }
    case 'duAlleNeu':
      s.duSchritt = {};
      for (let g = 1; g <= s.gruppen; g++) s.duSchritt[g] = 1;
      return null;
    case 'funktionenVerteilen':
      funktionenVerteilen(s);
      return null;
    default:
      return 'Unbekannte Aktion.';
  }
}

/* ------------------------------------------------------------------ */
/* Wiederherstellung nach Server-Neustart                              */
/* ------------------------------------------------------------------ */

function ausSicherung(snap) {
  const code = String(snap && snap.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code) || typeof snap.token !== 'string' || snap.token.length < 16) return null;
  const s = neueStunde(ganz(snap.gruppen, 1, MAX_GRUPPEN) || 5);
  s.code = code;
  s.token = snap.token;
  s.phase = PHASEN.includes(snap.phase) ? snap.phase : 'ich';
  for (const l of Array.isArray(snap.lernende) ? snap.lernende : []) {
    if (!l || typeof l.id !== 'string' || !/^[a-f0-9]{16}$/.test(l.id)) continue;
    const g = ganz(l.gruppe, 1, s.gruppen);
    const sp = ganz(l.sp, 1, SCHWERPUNKTE);
    if (!g || !sp || belegung(s, g).includes(sp)) continue;
    s.lernende[l.id] = { id: l.id, gruppe: g, sp, seit: Date.now() };
  }
  const zahlMap = (o, min, max, wmin, wmax) => {
    const r = {};
    for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) {
      const kk = ganz(k, min, max);
      const vv = ganz(v, wmin, wmax);
      if (kk && vv) r[kk] = vv;
    }
    return r;
  };
  s.duSchritt = zahlMap(snap.duSchritt, 1, s.gruppen, 1, SCHWERPUNKTE + 1);
  s.funktion = zahlMap(snap.funktion, 1, s.gruppen, 1, 20);
  return s;
}

/* ------------------------------------------------------------------ */
/* Socket-Verbindungen                                                 */
/* ------------------------------------------------------------------ */

function lkStunde(d) {
  const s = stunden.get(String(d && d.code || '').toUpperCase());
  return s && d && s.token === d.token ? s : null;
}
function raeumeVerlassen(socket) {
  for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
}
function abmeldenOnline(socket) {
  const id = socket.data.id;
  if (!id) return;
  const n = (online.get(id) || 1) - 1;
  if (n > 0) online.set(id, n); else online.delete(id);
  socket.data.id = null;
}
function anmeldenOnline(socket, id) {
  abmeldenOnline(socket);
  socket.data.id = id;
  if (id) online.set(id, (online.get(id) || 0) + 1);
}

io.on('connection', socket => {
  const ok = fn => (typeof fn === 'function' ? fn : () => {});

  /* ----- Lehrkraft ----- */

  socket.on('lk:anlegen', (d, ack) => {
    ack = ok(ack);
    if (PASSWORT && (!d || d.passwort !== PASSWORT)) return ack({ ok: false, fehler: 'Das Passwort ist falsch.' });
    const s = neueStunde(ganz(d && d.gruppen, 1, MAX_GRUPPEN) || 5);
    stunden.set(s.code, s);
    raeumeVerlassen(socket);
    socket.join('t:' + s.code);
    ack({ ok: true, code: s.code, token: s.token, zustand: lehrkraftAnsicht(s) });
  });

  socket.on('lk:beitreten', (d, ack) => {
    ack = ok(ack);
    const s = lkStunde(d);
    if (!s) return ack({ ok: false, grund: stunden.has(String(d && d.code || '').toUpperCase()) ? 'verboten' : 'unbekannt' });
    raeumeVerlassen(socket);
    socket.join('t:' + s.code);
    ack({ ok: true, zustand: lehrkraftAnsicht(s) });
  });

  socket.on('lk:wiederherstellen', (d, ack) => {
    ack = ok(ack);
    if (PASSWORT && (!d || d.passwort !== PASSWORT)) return ack({ ok: false, fehler: 'passwort' });
    const neu = d && d.snapshot ? ausSicherung(d.snapshot) : null;
    if (!neu) return ack({ ok: false, fehler: 'Die Sicherung ist unvollständig.' });
    const alt = stunden.get(neu.code);
    if (alt && alt.token !== neu.token) return ack({ ok: false, fehler: 'Der Code wird bereits verwendet.' });
    const s = alt || neu;
    if (!alt) stunden.set(s.code, s);
    raeumeVerlassen(socket);
    socket.join('t:' + s.code);
    ack({ ok: true, zustand: lehrkraftAnsicht(s) });
    verteilen(s);
  });

  socket.on('lk:aktion', (d, ack) => {
    ack = ok(ack);
    const s = lkStunde(d);
    if (!s) return ack({ ok: false, fehler: 'Die Stunde wurde nicht gefunden.' });
    if (d.typ === 'beenden') {
      io.to('s:' + s.code).emit('s:beendet');
      io.to('t:' + s.code).emit('lk:beendet');
      stunden.delete(s.code);
      return ack({ ok: true });
    }
    let fehler;
    try { fehler = aktion(s, d); } catch (e) { console.error(e); fehler = 'Interner Fehler.'; }
    ack(fehler ? { ok: false, fehler } : { ok: true });
    verteilen(s);
  });

  /* ----- Lernende ----- */

  socket.on('s:beitreten', (d, ack) => {
    ack = ok(ack);
    const code = String(d && d.code || '').toUpperCase();
    const s = stunden.get(code);
    if (!s) return ack({ ok: false, grund: 'unbekannt' });
    raeumeVerlassen(socket);
    socket.join('s:' + code);
    socket.data.code = code;
    let id = d && typeof d.id === 'string' && /^[a-f0-9]{16}$/.test(d.id) ? d.id : null;
    // Nach einem Server-Neustart: frühere Wahl dieses Geräts wieder eintragen, wenn sie frei ist.
    if (id && !s.lernende[id] && d.wahl) {
      const g = ganz(d.wahl.gruppe, 1, s.gruppen);
      const sp = ganz(d.wahl.sp, 1, SCHWERPUNKTE);
      if (g && sp && !wahlPruefen(s, g, sp, id)) s.lernende[id] = { id, gruppe: g, sp, seit: Date.now() };
    }
    if (id && !s.lernende[id]) id = null;
    anmeldenOnline(socket, id);
    ack({ ok: true, ansicht: schuelerAnsicht(s, id) });
    if (id) verteilen(s);
  });

  socket.on('s:waehlen', (d, ack) => {
    ack = ok(ack);
    const s = stunden.get(socket.data.code);
    if (!s) return ack({ ok: false, fehler: 'Die Stunde wurde nicht gefunden.' });
    if (s.phase !== 'ich') {
      return ack({ ok: false, fehler: 'Die Wahl ist gerade geschlossen. Melde dich bei deiner Lehrkraft.' });
    }
    const g = ganz(d && d.gruppe, 1, s.gruppen);
    const sp = ganz(d && d.sp, 1, SCHWERPUNKTE);
    const id = socket.data.id && s.lernende[socket.data.id] ? socket.data.id : neueId();
    const fehler = wahlPruefen(s, g, sp, id);
    if (fehler) return ack({ ok: false, fehler });
    s.lernende[id] = { id, gruppe: g, sp, seit: s.lernende[id] ? s.lernende[id].seit : Date.now() };
    anmeldenOnline(socket, id);
    ack({ ok: true, id });
    verteilen(s);
  });

  socket.on('s:abmelden', (d, ack) => {
    ack = ok(ack);
    const s = stunden.get(socket.data.code);
    if (!s || !socket.data.id) return ack({ ok: true });
    if (s.phase !== 'ich') return ack({ ok: false, fehler: 'Die Wahl ist gerade geschlossen.' });
    delete s.lernende[socket.data.id];
    abmeldenOnline(socket);
    ack({ ok: true });
    verteilen(s);
  });

  socket.on('s:weiter', (d, ack) => {
    ack = ok(ack);
    const s = stunden.get(socket.data.code);
    const ich = s && socket.data.id ? s.lernende[socket.data.id] : null;
    if (!ich || s.phase !== 'du') return ack({ ok: false });
    const akt = s.duSchritt[ich.gruppe] || 1;
    // nur weiterschalten, wenn das Gerät denselben Schritt sieht (verhindert Doppeltippen)
    if (ganz(d && d.von, 1, SCHWERPUNKTE) !== akt) return ack({ ok: true });
    s.duSchritt[ich.gruppe] = Math.min(akt + 1, SCHWERPUNKTE + 1);
    ack({ ok: true });
    verteilen(s);
  });

  socket.on('disconnect', () => {
    const s = stunden.get(socket.data.code);
    const hatte = socket.data.id;
    abmeldenOnline(socket);
    if (s && hatte) io.to('t:' + s.code).emit('lk:zustand', lehrkraftAnsicht(s));
  });
});

setInterval(() => {
  const grenze = Date.now() - LEBENSDAUER_MS;
  for (const [code, s] of stunden) if (s.updatedAt < grenze) stunden.delete(code);
}, 30 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Potenzfunktionen-Tool läuft auf Port ${PORT}`);
  if (!PASSWORT) console.log('Hinweis: LEHRER_PASSWORT ist nicht gesetzt – jeder kann eine Stunde anlegen.');
});
