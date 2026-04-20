import { state, SPEAKER_GROUPS, groupById, expandSources } from '../app-state.js';
import { emit, on } from './events.js';

let catalogRef;

export function mountSourcesPanel({ speakerCatalog }) {
  catalogRef = speakerCatalog;
  const root = document.getElementById('panel-sources');
  root.innerHTML = `
    <h2>Sources</h2>
    <div id="master-eq"></div>
    <div id="sources-list"></div>
    <div class="source-actions">
      <button id="add-source-btn" class="btn-add">+ Add speaker</button>
      <button id="add-array-btn" class="btn-add">+ Add line array</button>
    </div>
  `;
  root.querySelector('#add-source-btn').addEventListener('click', addSource);
  root.querySelector('#add-array-btn').addEventListener('click', addLineArray);
  renderMasterEQ();
  render();
  on('scene:reset', () => { renderMasterEQ(); render(); });
}

// ---- Master EQ — 10-band graphic EQ applied to the source signal before
// physical propagation. Global (one per scene, applies to all speakers).
// When bypassed, the EQ has zero effect on physics; the Probe tool also
// suppresses its frequency-response curve.
function renderMasterEQ() {
  const root = document.getElementById('master-eq');
  if (!root) return;
  const eq = state.physics?.eq;
  if (!eq) { root.innerHTML = ''; return; }
  const sliders = eq.bands.map((b, i) => {
    const label = b.freq_hz >= 1000 ? `${b.freq_hz / 1000}k` : `${b.freq_hz}`;
    return `
      <div class="eq-band">
        <div class="eq-band-readout" data-eq-readout="${i}">${b.gain_db >= 0 ? '+' : ''}${b.gain_db.toFixed(1)}</div>
        <input type="range" class="eq-slider" data-eq-band="${i}"
               min="-12" max="12" step="0.5" value="${b.gain_db}"
               orient="vertical" ${eq.enabled ? '' : 'disabled'} />
        <div class="eq-band-label">${label}</div>
      </div>
    `;
  }).join('');
  root.innerHTML = `
    <div class="eq-section${eq.enabled ? ' enabled' : ' bypassed'}">
      <div class="eq-header">
        <span class="eq-title">Master EQ</span>
        <span class="eq-sub">20 Hz – 20 kHz · ±12 dB</span>
        <button class="eq-bypass ${eq.enabled ? 'on' : ''}" id="eq-bypass-btn"
                title="Toggle master EQ. When bypassed, the Probe tool does not show the frequency-response curve.">
          ${eq.enabled ? '● ON' : '○ BYPASS'}
        </button>
        <button class="eq-flatten" id="eq-flatten-btn" title="Reset all bands to 0 dB">Flatten</button>
      </div>
      <div class="eq-sliders">${sliders}</div>
    </div>
  `;
  root.querySelector('#eq-bypass-btn')?.addEventListener('click', () => {
    state.physics.eq.enabled = !state.physics.eq.enabled;
    renderMasterEQ();
    emit('physics:eq_changed');
  });
  root.querySelector('#eq-flatten-btn')?.addEventListener('click', () => {
    for (const b of state.physics.eq.bands) b.gain_db = 0;
    renderMasterEQ();
    emit('physics:eq_changed');
  });
  root.querySelectorAll('.eq-slider').forEach(el => {
    el.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.eqBand, 10);
      const val = parseFloat(e.target.value);
      if (!Number.isFinite(val)) return;
      state.physics.eq.bands[idx].gain_db = val;
      const readout = root.querySelector(`[data-eq-readout="${idx}"]`);
      if (readout) readout.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(1)}`;
      emit('physics:eq_changed');
    });
  });
}

function addSource() {
  const defaultModel = catalogRef[0].url;
  state.sources.push({
    modelUrl: defaultModel,
    position: {
      x: state.room.width_m / 2,
      y: Math.min(1.5 + state.sources.length * 0.8, state.room.depth_m - 0.5),
      z: Math.min(state.room.height_m - 0.3, 2.5),
    },
    aim: { yaw: 0, pitch: -15, roll: 0 },
    power_watts: 100,
  });
  render();
  emit('source:changed');
}

// Creates a new line-array source with reasonable defaults. Splay values come
// from the speaker-expert audit: progressive J-curve 2°-3°-5°-8° is the
// industry-standard starting point (K2/J8 SOUNDVISION-style), giving even
// coverage from near to far field for a mid-size venue.
function addLineArray() {
  const lineArrayModel = catalogRef.find(c => /line-array/i.test(c.url))?.url ?? catalogRef[0].url;
  const count = 1 + state.sources.filter(s => s.kind === 'line-array').length;
  state.sources.push({
    kind: 'line-array',
    id: `LA${count}`,
    modelUrl: lineArrayModel,
    origin: {
      x: state.room.width_m / 2,
      y: state.room.depth_m * 0.25,
      z: Math.min(state.room.height_m - 1, 8),
    },
    baseYaw_deg: 0,
    topTilt_deg: -5,
    splayAnglesDeg: [2, 3, 5, 8],   // 5 elements, progressive J
    elementSpacing_m: 0.42,
    power_watts_each: 500,
    groupId: null,
  });
  render();
  emit('source:changed');
}

function removeSource(idx) {
  state.sources.splice(idx, 1);
  render();
  emit('source:changed');
}

function render() {
  const listRoot = document.getElementById('sources-list');
  if (!listRoot) return;

  if (state.sources.length === 0) {
    listRoot.innerHTML = '<div class="phase-placeholder">No loudspeakers yet — click "+ Add speaker" or "+ Add line array" below.</div>';
    return;
  }

  listRoot.innerHTML = state.sources.map((src, i) =>
    src.kind === 'line-array' ? renderLineArrayCard(src, i) : renderSpeakerCard(src, i),
  ).join('');

  listRoot.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeSource(parseInt(btn.dataset.removeIdx, 10)));
  });

  listRoot.querySelectorAll('.source-card').forEach(card => {
    const idx = parseInt(card.dataset.sourceIdx, 10);
    card.querySelectorAll('[data-f]').forEach(input => {
      const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(eventName, e => {
        const src = state.sources[idx];
        if (src?.kind === 'line-array') {
          updateLineArray(idx, e.target.dataset.f, e.target.value);
        } else {
          updateSource(idx, e.target.dataset.f, e.target.value);
        }
      });
    });
  });
}

function renderSpeakerCard(src, i) {
  const grp = groupById(src.groupId);
  const groupBadge = grp
    ? `<span class="group-badge" style="background:${escapeAttr(grp.color)}">${escapeHtml(grp.id)}</span>`
    : '';
  const grpBorder = grp ? `style="border-left: 4px solid ${escapeAttr(grp.color)}"` : '';
  return `
    <div class="source-card" data-source-idx="${i}" ${grpBorder}>
      <div class="source-header">
        <span>Speaker ${i + 1} ${groupBadge}</span>
        <button class="btn-remove" data-remove-idx="${i}" title="Remove this speaker" aria-label="Remove speaker ${i + 1}">×</button>
      </div>
      <div class="field-group">
        <label>Model
          <select data-f="model">
            ${catalogRef.map(c => `<option value="${escapeAttr(c.url)}" ${c.url === src.modelUrl ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
          </select>
        </label>
        <label>Group
          <select data-f="groupId">
            <option value="">— None —</option>
            ${SPEAKER_GROUPS.map(g => `<option value="${escapeAttr(g.id)}" ${g.id === src.groupId ? 'selected' : ''}>${escapeHtml(g.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="source-row triplet">
        <label>X <input type="number" data-f="x" value="${src.position.x.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
        <label>Y <input type="number" data-f="y" value="${src.position.y.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
        <label>Z <input type="number" data-f="z" value="${src.position.z.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
      </div>
      <div class="source-row duo">
        <label>Yaw <input type="number" data-f="yaw" value="${src.aim.yaw}" step="5" /><span class="unit">°</span></label>
        <label>Pitch <input type="number" data-f="pitch" value="${src.aim.pitch}" step="5" /><span class="unit">°</span></label>
      </div>
      <div class="field-group">
        <label>Input power <input type="number" data-f="watts" value="${src.power_watts}" min="0.1" step="10" /><span class="unit">W</span></label>
      </div>
    </div>
  `;
}

// Line-array card: shows the compound source + controls that expand into N
// physical elements at SPL-compute time. We display cumulative pitch per
// element (topTilt + Σsplay[0..i-1]) so the user can see the J-curve shape.
function renderLineArrayCard(src, i) {
  const grp = groupById(src.groupId);
  const groupBadge = grp
    ? `<span class="group-badge" style="background:${escapeAttr(grp.color)}">${escapeHtml(grp.id)}</span>`
    : '';
  const grpBorder = grp ? `style="border-left: 4px solid ${escapeAttr(grp.color)}"` : '';
  const splays = src.splayAnglesDeg || [];
  const elementCount = splays.length + 1;
  const splayStr = splays.map(v => v.toFixed(1)).join(', ');
  // Preview cumulative pitch per element for the user's reference.
  let cum = src.topTilt_deg ?? 0;
  const perElement = [`#1: ${cum.toFixed(1)}°`];
  for (let k = 0; k < splays.length; k++) {
    cum += splays[k];
    perElement.push(`#${k + 2}: ${cum.toFixed(1)}°`);
  }
  return `
    <div class="source-card line-array-card" data-source-idx="${i}" ${grpBorder}>
      <div class="source-header">
        <span>Line array ${escapeHtml(src.id ?? i + 1)} ${groupBadge} <span class="sub">${elementCount} elements</span></span>
        <button class="btn-remove" data-remove-idx="${i}" title="Remove this line array">×</button>
      </div>
      <div class="field-group">
        <label>Model
          <select data-f="model">
            ${catalogRef.map(c => `<option value="${escapeAttr(c.url)}" ${c.url === src.modelUrl ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
          </select>
        </label>
        <label>Group
          <select data-f="groupId">
            <option value="">— None —</option>
            ${SPEAKER_GROUPS.map(g => `<option value="${escapeAttr(g.id)}" ${g.id === src.groupId ? 'selected' : ''}>${escapeHtml(g.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="source-row triplet">
        <label>Rig X <input type="number" data-f="ox" value="${src.origin.x.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
        <label>Rig Y <input type="number" data-f="oy" value="${src.origin.y.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
        <label>Rig Z <input type="number" data-f="oz" value="${src.origin.z.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
      </div>
      <div class="source-row duo">
        <label>Base yaw <input type="number" data-f="baseYaw" value="${src.baseYaw_deg}" step="5" /><span class="unit">°</span></label>
        <label>Top tilt <input type="number" data-f="topTilt" value="${src.topTilt_deg}" step="1" /><span class="unit">°</span></label>
      </div>
      <div class="field-group">
        <label># elements <input type="number" data-f="elementCount" value="${elementCount}" min="1" max="24" step="1" /></label>
        <label>Spacing <input type="number" data-f="spacing" value="${src.elementSpacing_m}" min="0.2" max="1" step="0.01" /><span class="unit">m</span></label>
      </div>
      <label class="splay-label">Splay angles (° between adjacent elements, comma-separated)
        <input type="text" data-f="splays" value="${splayStr}" />
      </label>
      <div class="splay-preview"><span class="sub">Cumulative pitch: ${perElement.join(' · ')}</span></div>
      <div class="field-group">
        <label>Power / element <input type="number" data-f="wattsEach" value="${src.power_watts_each}" min="1" step="50" /><span class="unit">W</span></label>
      </div>
    </div>
  `;
}

function updateSource(idx, field, value) {
  const src = state.sources[idx];
  if (!src) return;
  switch (field) {
    case 'x': src.position.x = parseFloat(value); break;
    case 'y': src.position.y = parseFloat(value); break;
    case 'z': src.position.z = parseFloat(value); break;
    case 'yaw': src.aim.yaw = parseFloat(value); break;
    case 'pitch': src.aim.pitch = parseFloat(value); break;
    case 'watts': src.power_watts = parseFloat(value); break;
    case 'model':
      src.modelUrl = value;
      emit('source:model_changed', { idx, url: value });
      return;
    case 'groupId':
      src.groupId = value || null;
      render();
      emit('source:changed');
      return;
  }
  emit('source:changed');
}

function updateLineArray(idx, field, value) {
  const src = state.sources[idx];
  if (!src || src.kind !== 'line-array') return;
  switch (field) {
    case 'ox': src.origin.x = parseFloat(value); break;
    case 'oy': src.origin.y = parseFloat(value); break;
    case 'oz': src.origin.z = parseFloat(value); break;
    case 'baseYaw': src.baseYaw_deg = parseFloat(value); break;
    case 'topTilt': src.topTilt_deg = parseFloat(value); render(); break;
    case 'spacing': src.elementSpacing_m = parseFloat(value); break;
    case 'wattsEach': src.power_watts_each = parseFloat(value); break;
    case 'elementCount': {
      const n = Math.max(1, Math.min(24, parseInt(value, 10) || 1));
      const curSplays = src.splayAnglesDeg ?? [];
      const needed = n - 1;
      if (needed <= 0) {
        src.splayAnglesDeg = [];
      } else if (curSplays.length >= needed) {
        src.splayAnglesDeg = curSplays.slice(0, needed);
      } else {
        // Extend with last splay value (or 2° default) for added elements.
        const pad = curSplays.length > 0 ? curSplays[curSplays.length - 1] : 2;
        src.splayAnglesDeg = curSplays.concat(new Array(needed - curSplays.length).fill(pad));
      }
      render();
      break;
    }
    case 'splays': {
      const parsed = value.split(',').map(s => parseFloat(s.trim())).filter(v => !Number.isNaN(v));
      src.splayAnglesDeg = parsed;
      render();
      break;
    }
    case 'model':
      src.modelUrl = value;
      emit('source:model_changed', { idx, url: value });
      return;
    case 'groupId':
      src.groupId = value || null;
      render();
      emit('source:changed');
      return;
  }
  emit('source:changed');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
