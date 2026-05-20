/* ============================================================
   ACH EXPLORER — application logic
   Vanilla JS + D3. No build step. GitHub Pages compatible.
   ============================================================ */

(function () {
  'use strict';

  // ----------------------------------------------------------
  // Embedded default i18n. The analysis i18n file overrides
  // these. Keeps the app functional even with minimal i18n.
  // ----------------------------------------------------------

  const DEFAULT_I18N = {
    ui: {
      appName: 'ACH Explorer',
      loading: 'Loading…',
      errorLoadingAnalysis: 'Failed to load analysis',
      selectAnalysis: 'Analysis',
      noAnalysesFound: 'No analyses found at analyses/index.json',
      tabOverview: 'Overview', tabMatrix: 'Matrix', tabNetwork: 'Network',
      tabEvidence: 'Evidence', tabHypotheses: 'Hypotheses', tabWhatIf: 'What-If',
      evidenceCount: 'evidence items', hypothesisCount: 'hypotheses',
      byAnalyst: 'by', lastUpdated: 'Last updated', version: 'Version',
      sortBy: 'Sort by', filterBy: 'Filter by', search: 'Search', all: 'All',
      reset: 'Reset', openSource: 'Open source', drilldown: 'View detail',
      close: 'Close', evidence: 'Evidence', hypothesis: 'Hypothesis',
      score: 'Score', diagnosticity: 'Diagnosticity', diagnosticityShort: 'Diag.',
      reliability: 'Source reliability', credibility: 'Information credibility',
      manipulationRisk: 'Manipulation risk', manipulationRiskShort: 'Manip. risk',
      timeliness: 'Timeliness', corroboration: 'Corroboration',
      provenance: 'Provenance', evidenceFamily: 'Evidence family',
      families: 'Families', sourceType: 'Source type', notes: 'Notes',
      supportingEvidence: 'Supporting evidence',
      contradictingEvidence: 'Contradicting evidence',
      counterevidence: 'Counterevidence / falsifiers',
      watchFor: 'Watch for', assessment: 'Assessment', confidence: 'Confidence',
      subDomains: 'Sub-domains', analyticQuestion: 'Analytic question',
      keyJudgment: 'Key judgment', inflectionPoints: 'Inflection points',
      remainingGaps: 'Remaining gaps',
      yourEditsActive: 'Edits active', baselineActive: 'Baseline',
      resetEdits: 'Reset to baseline',
      evidenceFilterPlaceholder: 'Filter by observation, ID, family…',
      diagnosticityHelp: 'Variance of scores across hypotheses. High variance = high diagnostic power.',
      supportScoreHelp: 'Sum of (evidence score × source weight). Source weight = reliability × credibility.',
      highlightThreshold: 'Highlight |score| ≥',
      language: 'Lang',
      downloadJSON: 'Download',
    },
    scoreLabels: {
      '-2': 'Strongly inconsistent', '-1': 'Inconsistent',
      '0': 'Neutral', '1': 'Consistent', '2': 'Strongly consistent'
    },
    reliabilityLabels: {
      A: 'Completely reliable', B: 'Usually reliable', C: 'Fairly reliable',
      D: 'Not usually reliable', E: 'Unreliable', F: 'Cannot be judged'
    },
    credibilityLabels: {
      '1': 'Confirmed by other sources', '2': 'Probably true',
      '3': 'Possibly true', '4': 'Doubtfully true',
      '5': 'Improbable', '6': 'Cannot be judged'
    },
  };

  // ----------------------------------------------------------
  // State
  // ----------------------------------------------------------

  // Resolve data URLs from the directory that contains app.js (works under /ach/ on GitHub Pages).
  const APP_BASE = (() => {
    const script = document.querySelector('script[src*="app.js"]');
    if (script) {
      const src = script.getAttribute('src') || 'app.js';
      return new URL(src, document.baseURI).href.replace(/[^/]+$/, '');
    }
    return new URL('./', document.baseURI).href;
  })();

  function dataUrl(relativePath) {
    return new URL(relativePath, APP_BASE).href;
  }

  let suppressPickerChange = false;

  const state = {
    manifest: null,
    currentAnalysisId: null,
    metadata: null,
    hypotheses: null,
    evidence: null,
    sources: null,
    i18n: null,
    view: 'overview',
    language: 'en',
    selectedEvidence: null,
    selectedHypothesis: null,
    edits: {},                   // { evidenceId: { hypId: score } }  — what-if overrides
    matrixSort: { col: 'id', dir: 'asc' },
    evidenceFilter: '',
    evidenceSort: 'id',
    networkMinScore: 1,
    networkSelectedNodeId: null,
  };

  // ----------------------------------------------------------
  // i18n lookup
  // ----------------------------------------------------------

  function confidenceClass(confidence) {
    if (!confidence) return 'confidence-pill';
    const slug = String(confidence).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    return 'confidence-pill is-' + slug;
  }

  function t(key, fallback) {
    const parts = key.split('.');
    const tryPath = (obj) => {
      let v = obj;
      for (const p of parts) {
        if (v == null || typeof v !== 'object') return undefined;
        v = v[p];
      }
      return v;
    };
    const fromAnalysis = tryPath(state.i18n);
    if (fromAnalysis !== undefined) return fromAnalysis;
    const fromDefault = tryPath(DEFAULT_I18N);
    if (fromDefault !== undefined) return fromDefault;
    return fallback != null ? fallback : key;
  }

  // ----------------------------------------------------------
  // Score math — diagnosticity, source weight, hypothesis support
  // ----------------------------------------------------------

  function getEffectiveScore(evidenceId, hypId) {
    const evEdits = state.edits[evidenceId];
    if (evEdits && hypId in evEdits) return evEdits[hypId];
    const e = state.evidence.evidence.find(x => x.id === evidenceId);
    return e ? (e.scores[hypId] ?? 0) : 0;
  }

  function computeDiagnosticity(evidence) {
    const scores = state.hypotheses.hypotheses.map(h => getEffectiveScore(evidence.id, h.id));
    const n = scores.length;
    if (n === 0) return 0;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    return variance;
  }

  const REL_WEIGHT = { A: 1.0, B: 0.8, C: 0.6, D: 0.4, E: 0.2, F: 0.1 };
  const CRED_WEIGHT = { 1: 1.0, 2: 0.8, 3: 0.6, 4: 0.4, 5: 0.2, 6: 0.1 };

  function getSourceWeight(evidence) {
    const r = REL_WEIGHT[evidence.reliability] ?? 0.5;
    const c = CRED_WEIGHT[evidence.credibility] ?? 0.5;
    return r * c;
  }

  function computeHypothesisSupport(hypId) {
    return state.evidence.evidence.reduce((sum, e) => {
      const score = getEffectiveScore(e.id, hypId);
      return sum + score * getSourceWeight(e);
    }, 0);
  }

  function getHypothesisById(hypId) {
    return state.hypotheses.hypotheses.find(h => h.id === hypId);
  }

  function getEvidenceById(evId) {
    return state.evidence.evidence.find(e => e.id === evId);
  }

  function getSourceById(sourceId) {
    return state.sources?.sources?.[sourceId];
  }

  // ----------------------------------------------------------
  // Data loading
  // ----------------------------------------------------------

  async function fetchJSON(url) {
    const resolved = url.startsWith('http') ? url : dataUrl(url);
    const res = await fetch(resolved, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${resolved}`);
    return res.json();
  }

  async function fetchJSONOptional(url) {
    try { return await fetchJSON(url); }
    catch (e) { return null; }
  }

  async function loadManifest() {
    try {
      state.manifest = await fetchJSON('analyses/index.json');
    } catch (e) {
      throw new Error(t('ui.noAnalysesFound'));
    }
  }

  async function loadAnalysis(analysisId) {
    setStatus('LOADING ' + analysisId);
    const entry = state.manifest.analyses.find(a => a.id === analysisId);
    if (!entry) throw new Error('Analysis not in manifest: ' + analysisId);
    const base = 'analyses/' + entry.path;
    const [metadata, hypotheses, evidence, sources] = await Promise.all([
      fetchJSON(base + '/metadata.json'),
      fetchJSON(base + '/hypotheses.json'),
      fetchJSON(base + '/evidence.json'),
      fetchJSON(base + '/sources.json'),
    ]);
    state.metadata = metadata;
    state.hypotheses = hypotheses;
    state.evidence = evidence;
    state.sources = sources;
    state.currentAnalysisId = analysisId;
    state.selectedEvidence = null;
    state.selectedHypothesis = null;
    state.networkSelectedNodeId = null;
    // Pick a language
    const wantedLang = state.language || metadata.defaultLanguage || 'en';
    state.language = wantedLang;
    // Try analysis-specific i18n
    state.i18n = await fetchJSONOptional(base + '/i18n/' + wantedLang + '.json');
    if (!state.i18n) {
      // Try default language
      state.i18n = await fetchJSONOptional(base + '/i18n/en.json');
    }
    // Load any saved edits from localStorage
    loadEditsFromStorage();
    setStatus('READY · ' + analysisId);
  }

  // ----------------------------------------------------------
  // Edits persistence (what-if)
  // ----------------------------------------------------------

  function editsStorageKey() {
    return 'ach-explorer:edits:' + state.currentAnalysisId;
  }

  function saveEditsToStorage() {
    try { localStorage.setItem(editsStorageKey(), JSON.stringify(state.edits)); }
    catch (e) { /* localStorage unavailable, fine */ }
  }

  function loadEditsFromStorage() {
    try {
      const raw = localStorage.getItem(editsStorageKey());
      state.edits = raw ? JSON.parse(raw) : {};
    } catch (e) { state.edits = {}; }
  }

  function hasEdits() {
    return Object.keys(state.edits).some(eId => Object.keys(state.edits[eId] || {}).length > 0);
  }

  function clearAllEdits() {
    state.edits = {};
    saveEditsToStorage();
  }

  // ----------------------------------------------------------
  // DOM helpers
  // ----------------------------------------------------------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'className') el.className = attrs[k];
        else if (k === 'onClick') el.addEventListener('click', attrs[k]);
        else if (k === 'onChange') el.addEventListener('change', attrs[k]);
        else if (k === 'onInput') el.addEventListener('input', attrs[k]);
        else if (k === 'style') Object.assign(el.style, attrs[k]);
        else if (k === 'dataset') for (const dk in attrs[k]) el.dataset[dk] = attrs[k][dk];
        else if (k === 'html') el.innerHTML = attrs[k];
        else el.setAttribute(k, attrs[k]);
      }
    }
    if (children != null) {
      const list = Array.isArray(children) ? children : [children];
      for (const c of list) {
        if (c == null || c === false) continue;
        el.appendChild(typeof c === 'string' || typeof c === 'number'
          ? document.createTextNode(String(c)) : c);
      }
    }
    return el;
  }

  function setStatus(msg) {
    const bar = $('#status-bar');
    if (!bar) return;
    bar.innerHTML = '';
    bar.append(
      h('div', { className: 'status-segment' }, [
        h('span', { className: 'status-led is-ready' }),
        h('span', null, msg)
      ]),
      h('div', { className: 'status-segment' }, [
        h('span', null, 'ACH//EXPLORER v1.0')
      ])
    );
  }

  // ----------------------------------------------------------
  // Header + analysis picker + language picker
  // ----------------------------------------------------------

  function clearInactiveViews() {
    $$('.view').forEach(v => {
      if (v.dataset.view !== state.view) v.innerHTML = '';
    });
  }

  function resetViewState() {
    state.matrixSort = { col: 'id', dir: 'asc' };
    state.evidenceFilter = '';
    state.evidenceSort = 'id';
    state.networkMinScore = 1;
    state.networkSelectedNodeId = null;
    networkRefs.links = null;
    networkRefs.nodes = null;
  }

  async function switchAnalysis(analysisId) {
    if (!analysisId || analysisId === state.currentAnalysisId) return;
    const previousId = state.currentAnalysisId;
    closeDrilldown();
    $('#drilldown-content').innerHTML = '';
    try {
      await loadAnalysis(analysisId);
      resetViewState();
      clearInactiveViews();
      try { localStorage.setItem('ach-explorer:last-analysis', analysisId); } catch (e) { /* fine */ }
      const activeView = $('.view.is-active');
      if (activeView) activeView.scrollTop = 0;
      renderAll();
    } catch (err) {
      console.error(err);
      setStatus('ERROR: ' + err.message);
      const picker = $('#analysis-picker');
      if (picker && previousId) {
        suppressPickerChange = true;
        picker.value = previousId;
        suppressPickerChange = false;
      }
    }
  }

  function syncAnalysisPicker() {
    const picker = $('#analysis-picker');
    if (!picker || !state.manifest) return;
    suppressPickerChange = true;
    picker.innerHTML = '';
    for (const a of state.manifest.analyses) {
      const label = a.title.length > 52 ? a.title.slice(0, 49) + '…' : a.title;
      const opt = h('option', { value: a.id, title: a.title }, label);
      picker.appendChild(opt);
    }
    if (state.currentAnalysisId) picker.value = state.currentAnalysisId;
    suppressPickerChange = false;
  }

  function setupHeaderControls() {
    const picker = $('#analysis-picker');
    picker.addEventListener('change', (e) => {
      if (suppressPickerChange) return;
      switchAnalysis(e.target.value);
    });

    const langPicker = $('#language-picker');
    langPicker.addEventListener('change', async (e) => {
      state.language = e.target.value;
      try {
        await loadAnalysis(state.currentAnalysisId);
        renderAll();
      } catch (err) {
        console.error(err);
        setStatus('ERROR: ' + err.message);
      }
    });
  }

  function renderHeader() {
    syncAnalysisPicker();
    const langPicker = $('#language-picker');
    const supported = state.manifest?.discovery?.supportedLanguages || ['en'];
    const lang = supported.includes(state.language) ? state.language : (supported[0] || 'en');
    langPicker.innerHTML = '';
    for (const code of supported) {
      langPicker.appendChild(h('option', { value: code }, code.toUpperCase()));
    }
    langPicker.value = lang;
    state.language = lang;
  }

  // ----------------------------------------------------------
  // Tab routing
  // ----------------------------------------------------------

  function setupTabs() {
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        state.view = tab.dataset.view;
        $$('.tab').forEach(t => t.classList.toggle('is-active', t === tab));
        $$('.view').forEach(v => v.classList.toggle('is-active', v.dataset.view === state.view));
        renderActiveView();
      });
    });
    // Localize tab labels
    $$('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      const val = t(key);
      if (val !== key) el.textContent = val;
    });
  }

  // ----------------------------------------------------------
  // OVERVIEW VIEW
  // ----------------------------------------------------------

  function renderOverview() {
    const v = $('.view-overview');
    v.innerHTML = '';
    const md = state.metadata;
    const evCount = state.evidence?.evidence?.length || 0;
    const hypCount = state.hypotheses?.hypotheses?.length || 0;

    const left = h('div', { className: 'overview-main' }, [
      // Title
      h('div', { className: 'section-block' }, [
        h('div', { className: 'section-block-header' }, [
          h('span', null, md.id),
          h('span', null, md.date + ' · ' + t('ui.byAnalyst') + ' ' + (md.analyst || '—'))
        ]),
        h('div', { className: 'section-block-body' }, [
          h('h1', {
            style: {
              fontFamily: 'var(--font-serif)', fontSize: '28px', fontWeight: '600',
              lineHeight: '1.2', margin: '0 0 8px 0', color: 'var(--text-strong)'
            }
          }, md.title),
          md.subtitle ? h('div', {
            style: { fontFamily: 'var(--font-serif)', fontSize: '15px', color: 'var(--text-muted)', fontStyle: 'italic' }
          }, md.subtitle) : null
        ])
      ]),

      // Analytic question
      h('div', { className: 'section-block' }, [
        h('div', { className: 'section-block-header' }, t('ui.analyticQuestion')),
        h('div', { className: 'section-block-body prose' }, [
          h('div', { className: 'analytic-question' }, md.analyticQuestion)
        ])
      ]),

      // Key judgment
      md.keyJudgment ? h('div', { className: 'section-block' }, [
        h('div', { className: 'section-block-header' }, [
          h('span', null, t('ui.keyJudgment')),
          h('span', { className: confidenceClass(md.keyJudgment.confidence) },
            md.keyJudgment.confidence)
        ]),
        h('div', { className: 'section-block-body prose' }, [
          h('div', { className: 'key-judgment-summary' }, md.keyJudgment.summary),
          md.keyJudgment.details ? h('p', null, md.keyJudgment.details) : null
        ])
      ]) : null,

      // Sub-domains
      md.subDomains && md.subDomains.length ? h('div', { className: 'section-block' }, [
        h('div', { className: 'section-block-header' }, t('ui.subDomains')),
        h('div', { className: 'section-block-body' }, [
          h('div', { className: 'subdomain-grid' },
            md.subDomains.map(sd => h('div', { className: 'subdomain-card' }, [
              h('div', { className: 'subdomain-id' }, sd.id),
              h('div', { className: 'subdomain-name' }, sd.name),
              h('div', { className: 'subdomain-def' }, sd.definition),
              h('div', null, h('span', { className: confidenceClass(sd.confidence) }, sd.confidence)),
              h('div', { className: 'subdomain-verdict', style: { marginTop: '8px' } }, sd.verdict)
            ])))
        ])
      ]) : null,

      // Inflection points
      md.inflectionPoints && Object.keys(md.inflectionPoints).length ? h('div', { className: 'section-block' }, [
        h('div', { className: 'section-block-header' }, t('ui.inflectionPoints')),
        h('div', { className: 'section-block-body' },
          Object.values(md.inflectionPoints).map(ip => h('div', {
            className: 'inflection-card is-' + ip.status
          }, [
            h('div', { className: 'inflection-status is-' + ip.status }, ip.status.replace(/-/g, ' ')),
            h('div', { className: 'inflection-name' }, ip.name),
            h('div', { className: 'inflection-detail' }, [
              ip.markedBy || ip.currentClosestEvidence || '',
              ip.evidenceId ? h('span', {
                className: 'inflection-evref',
                onClick: () => openEvidenceDrilldown(ip.evidenceId)
              }, ip.evidenceId) : null,
              ip.watchSignature ? h('div', {
                style: { marginTop: '8px', fontStyle: 'italic', color: 'var(--text-muted)' }
              }, t('ui.watchFor') + ': ' + ip.watchSignature) : null
            ])
          ])))
      ]) : null,

      // Remaining gaps
      md.remainingGaps && md.remainingGaps.length ? h('div', { className: 'section-block' }, [
        h('div', { className: 'section-block-header' }, t('ui.remainingGaps')),
        h('div', { className: 'section-block-body' }, [
          h('ul', { className: 'gap-list' },
            md.remainingGaps.map(g => h('li', null, g)))
        ])
      ]) : null,
    ]);

    const right = h('div', { className: 'overview-aside' }, [
      // Stats
      h('div', { className: 'overview-stats' }, [
        h('div', { className: 'stat' }, [
          h('div', { className: 'stat-value' }, evCount),
          h('div', { className: 'stat-label' }, t('ui.evidenceCount'))
        ]),
        h('div', { className: 'stat' }, [
          h('div', { className: 'stat-value' }, hypCount),
          h('div', { className: 'stat-label' }, t('ui.hypothesisCount'))
        ]),
      ]),

      // Hypothesis support meter
      h('div', { className: 'section-block' }, [
        h('div', { className: 'section-block-header' }, 'Hypothesis support'),
        h('div', { className: 'section-block-body', style: { padding: '14px' } },
          state.hypotheses.hypotheses.map(hyp => {
            const support = computeHypothesisSupport(hyp.id);
            // Normalize to bar width — max possible = sum of weights × 2
            const maxAbs = state.evidence.evidence.reduce((a, e) => a + getSourceWeight(e) * 2, 0);
            const pct = maxAbs > 0 ? (support / maxAbs) * 100 : 0;
            const isPos = support >= 0;
            const barWidth = Math.min(50, Math.abs(pct) * 0.5);
            return h('div', {
              style: { marginBottom: '10px', cursor: 'pointer' },
              onClick: () => openHypothesisDrilldown(hyp.id)
            }, [
              h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' } }, [
                h('span', null, [
                  h('strong', { style: { color: 'var(--amber)' } }, hyp.id),
                  ' ',
                  h('span', null, hyp.shortLabel || hyp.label.substring(0, 40))
                ]),
                h('span', { style: { fontVariantNumeric: 'tabular-nums', color: isPos ? 'var(--rel-A)' : 'var(--neg-2-fg)' } },
                  (support >= 0 ? '+' : '') + support.toFixed(1))
              ]),
              h('div', { style: { background: 'var(--bg-elevated)', height: '6px', position: 'relative' } }, [
                h('div', {
                  style: {
                    background: isPos ? 'var(--rel-A)' : 'var(--neg-2-fg)',
                    height: '100%',
                    width: barWidth + '%',
                    position: 'absolute',
                    left: isPos ? '50%' : (50 - barWidth) + '%',
                    maxWidth: '50%'
                  }
                }),
                h('div', { style: { position: 'absolute', left: '50%', top: '-2px', bottom: '-2px', width: '1px', background: 'var(--border-strong)' } })
              ])
            ]);
          })
        )
      ])
    ]);

    v.appendChild(h('div', { className: 'overview-grid' }, [left, right]));
  }

  // ----------------------------------------------------------
  // MATRIX VIEW
  // ----------------------------------------------------------

  function renderMatrix(opts) {
    opts = opts || {};
    const v = $('.view-matrix');
    v.innerHTML = '';

    const hyps = state.hypotheses.hypotheses;
    let evidenceList = state.evidence.evidence.slice();

    // Compute diagnosticity once
    evidenceList.forEach(e => { e._diag = computeDiagnosticity(e); });

    // Sort
    const sortCol = state.matrixSort.col;
    const sortDir = state.matrixSort.dir;
    evidenceList.sort((a, b) => {
      let av, bv;
      if (sortCol === 'id')        { av = a.id; bv = b.id; }
      else if (sortCol === 'diag') { av = a._diag; bv = b._diag; }
      else if (sortCol === 'rel')  { av = a.reliability; bv = b.reliability; }
      else if (sortCol === 'cred') { av = a.credibility; bv = b.credibility; }
      else if (sortCol.startsWith('H')) {
        av = getEffectiveScore(a.id, sortCol);
        bv = getEffectiveScore(b.id, sortCol);
      } else { av = a.id; bv = b.id; }
      if (av === bv) {
        // Tiebreaker: numeric part of ID
        const an = parseInt(a.id.replace(/\D/g, ''), 10) || 0;
        const bn = parseInt(b.id.replace(/\D/g, ''), 10) || 0;
        return an - bn;
      }
      const order = av < bv ? -1 : 1;
      return sortDir === 'asc' ? order : -order;
    });

    // Toolbar
    const toolbar = h('div', { className: 'matrix-toolbar' }, [
      h('span', { className: 'control-label' }, t('ui.sortBy')),
      h('select', {
        className: 'select',
        onChange: (e) => { state.matrixSort.col = e.target.value; renderMatrix(); }
      }, [
        h('option', { value: 'id' },   'ID'),
        h('option', { value: 'diag' }, t('ui.diagnosticity')),
        h('option', { value: 'rel' },  t('ui.reliability')),
        h('option', { value: 'cred' }, t('ui.credibility')),
        ...hyps.map(hp => h('option', { value: hp.id }, 'Score: ' + hp.id))
      ].map(opt => { if (opt.value === sortCol) opt.selected = true; return opt; })),
      h('button', {
        className: 'btn',
        onClick: () => {
          state.matrixSort.dir = state.matrixSort.dir === 'asc' ? 'desc' : 'asc';
          renderMatrix();
        }
      }, sortDir === 'asc' ? '▲ ASC' : '▼ DESC'),
      h('div', { style: { flex: 1 } }),
      h('span', { style: { fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' } },
        evidenceList.length + ' × ' + hyps.length),
    ]);
    v.appendChild(toolbar);

    // Matrix
    const wrapper = h('div', { className: 'matrix-wrapper' });
    const matrix = h('div', { className: 'matrix' });

    // Compute grid template
    const gridCols = ['80px', 'minmax(280px, 1.2fr)', ...hyps.map(() => '60px'), '120px'].join(' ');
    matrix.style.gridTemplateColumns = gridCols;

    // Header
    matrix.appendChild(h('div', {
      className: 'cell is-head ' + (sortCol === 'id' ? 'is-sorted is-' + sortDir : ''),
      onClick: () => { toggleSort('id'); }
    }, 'EV'));
    matrix.appendChild(h('div', { className: 'cell is-head' }, t('ui.evidence')));
    hyps.forEach(hp => {
      matrix.appendChild(h('div', {
        className: 'cell is-head is-hyp-head ' + (sortCol === hp.id ? 'is-sorted is-' + sortDir : ''),
        onClick: (e) => {
          if (e.shiftKey) { openHypothesisDrilldown(hp.id); }
          else { toggleSort(hp.id); }
        },
        title: hp.label + '\n\nClick = sort. Shift-click = drilldown.'
      }, [
        h('div', { className: 'hyp-id' }, hp.id),
        h('div', { className: 'hyp-short' }, hp.shortLabel || hp.label.substring(0, 18))
      ]));
    });
    matrix.appendChild(h('div', {
      className: 'cell is-head ' + (sortCol === 'diag' ? 'is-sorted is-' + sortDir : ''),
      title: t('ui.diagnosticityHelp'),
      onClick: () => { toggleSort('diag'); }
    }, t('ui.diagnosticityShort')));

    // Max diagnosticity for bar width
    const maxDiag = Math.max(...evidenceList.map(e => e._diag), 0.001);

    // Rows
    evidenceList.forEach(ev => {
      // ID cell
      matrix.appendChild(h('div', {
        className: 'cell is-ev-id',
        onClick: () => openEvidenceDrilldown(ev.id),
        title: t('ui.drilldown')
      }, ev.id));
      // Observation
      matrix.appendChild(h('div', {
        className: 'cell',
        style: { whiteSpace: 'normal', fontSize: '12px', color: 'var(--text)', lineHeight: '1.4', padding: '6px 10px', cursor: 'pointer' },
        onClick: () => openEvidenceDrilldown(ev.id)
      }, truncate(ev.observation, 160)));
      // Scores
      hyps.forEach(hp => {
        const score = getEffectiveScore(ev.id, hp.id);
        const sym = scoreSymbol(score);
        const isEdited = state.edits[ev.id] && (hp.id in state.edits[ev.id]);
        const cell = h('div', {
          className: 'cell is-score score-' + (score >= 0 ? score : score) + (isEdited ? ' is-edited' : ''),
          style: { position: 'relative' },
          onClick: () => openCellDrilldown(ev.id, hp.id),
          title: ev.id + ' × ' + hp.id + ': ' + score + ' (' + t('scoreLabels.' + score) + ')'
        }, sym);
        matrix.appendChild(cell);
      });
      // Diagnosticity
      const diagPct = (ev._diag / maxDiag) * 60;  // up to 60px bar
      matrix.appendChild(h('div', { className: 'cell is-diag' }, [
        ev._diag.toFixed(2),
        h('span', { className: 'diag-bar', style: { width: diagPct + 'px' } })
      ]));
    });

    // Footer: hypothesis support
    matrix.appendChild(h('div', { className: 'cell is-support-label', style: { gridColumn: '1 / 3' } }, 'Support'));
    hyps.forEach(hp => {
      const s = computeHypothesisSupport(hp.id);
      const cls = s > 0.5 ? 'is-positive' : (s < -0.5 ? 'is-negative' : 'is-neutral');
      matrix.appendChild(h('div', {
        className: 'cell is-support ' + cls,
        onClick: () => openHypothesisDrilldown(hp.id),
        title: t('ui.supportScoreHelp'),
        style: { cursor: 'pointer' }
      }, (s >= 0 ? '+' : '') + s.toFixed(1)));
    });
    matrix.appendChild(h('div', { className: 'cell is-support' }, ''));

    wrapper.appendChild(matrix);
    v.appendChild(wrapper);

    // Legend
    v.appendChild(h('div', { className: 'matrix-legend' }, [
      h('span', null, 'Score'),
      h('span', { className: 'legend-key' }, [h('span', { className: 'legend-cell score--2' }, '−−'), h('span', null, '−2')]),
      h('span', { className: 'legend-key' }, [h('span', { className: 'legend-cell score--1' }, '−'), h('span', null, '−1')]),
      h('span', { className: 'legend-key' }, [h('span', { className: 'legend-cell score-0' }, '·'), h('span', null, '0')]),
      h('span', { className: 'legend-key' }, [h('span', { className: 'legend-cell score-1' }, '+'), h('span', null, '+1')]),
      h('span', { className: 'legend-key' }, [h('span', { className: 'legend-cell score-2' }, '++'), h('span', null, '+2')]),
      h('span', { style: { marginLeft: '20px' } }, 'Click cell · Click ID · Shift-click hypothesis header')
    ]));
  }

  function toggleSort(col) {
    if (state.matrixSort.col === col) {
      state.matrixSort.dir = state.matrixSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.matrixSort.col = col;
      state.matrixSort.dir = (col === 'id' || col === 'rel' || col === 'cred') ? 'asc' : 'desc';
    }
    renderMatrix();
  }

  function scoreSymbol(s) {
    if (s === 2) return '++';
    if (s === 1) return '+';
    if (s === 0) return '·';
    if (s === -1) return '−';
    if (s === -2) return '−−';
    return String(s);
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.substring(0, n - 1) + '…' : s;
  }

  // ----------------------------------------------------------
  // NETWORK VIEW (D3 bipartite force-directed)
  // ----------------------------------------------------------

  function renderNetwork() {
    const v = $('.view-network');
    v.innerHTML = '';
    const hyps = state.hypotheses.hypotheses;
    const evs = state.evidence.evidence;

    // Toolbar
    const toolbar = h('div', { className: 'network-toolbar' }, [
      h('span', { className: 'control-label' }, t('ui.highlightThreshold')),
      h('input', {
        type: 'range', min: '0', max: '2', step: '1',
        value: state.networkMinScore,
        onInput: (e) => {
          state.networkMinScore = parseInt(e.target.value, 10);
          updateNetworkLinkVisibility();
          $('#net-threshold-value').textContent = state.networkMinScore;
        }
      }),
      h('span', { id: 'net-threshold-value', style: { color: 'var(--amber)', fontWeight: 600, minWidth: '12px' } },
        String(state.networkMinScore)),
      h('div', { style: { flex: 1 } }),
      h('span', { style: { fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' } },
        evs.length + ' evidence · ' + hyps.length + ' hypotheses')
    ]);
    v.appendChild(toolbar);

    // SVG container
    const wrapper = h('div', { className: 'network-wrapper' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'network-svg';
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    wrapper.appendChild(svg);

    // Legend
    wrapper.appendChild(h('div', { className: 'network-legend' }, [
      h('div', null, [h('span', { className: 'swatch', style: { background: 'var(--pos-2-fg)' } }), 'Supporting']),
      h('div', null, [h('span', { className: 'swatch', style: { background: 'var(--neg-2-fg)' } }), 'Contradicting']),
      h('div', { style: { marginTop: '6px', fontSize: '9px' } }, 'Edge width ∝ |score|')
    ]));
    v.appendChild(wrapper);

    // Force-directed bipartite layout
    requestAnimationFrame(() => buildNetworkSimulation(svg, hyps, evs));
  }

  function buildNetworkSimulation(svgEl, hyps, evs) {
    const rect = svgEl.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    if (W < 10 || H < 10) { setTimeout(() => buildNetworkSimulation(svgEl, hyps, evs), 80); return; }

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`);

    // Build nodes
    const hypNodes = hyps.map((hp, i) => ({
      id: hp.id, kind: 'h', label: hp.id, sublabel: hp.shortLabel || '',
      r: 24, _hyp: hp
    }));
    const evNodes = evs.map(ev => ({
      id: ev.id, kind: 'e', label: ev.id,
      r: 5 + Math.min(3, computeDiagnosticity(ev) * 2), _ev: ev
    }));
    const nodes = [...hypNodes, ...evNodes];

    // Pin hypothesis nodes around a ring
    const hypRadius = Math.min(W, H) * 0.18;
    hypNodes.forEach((n, i) => {
      const angle = (i / hypNodes.length) * 2 * Math.PI - Math.PI / 2;
      n.fx = W / 2 + hypRadius * Math.cos(angle);
      n.fy = H / 2 + hypRadius * Math.sin(angle);
    });

    // Links
    const links = [];
    evs.forEach(ev => {
      hyps.forEach(hp => {
        const s = getEffectiveScore(ev.id, hp.id);
        if (s !== 0) {
          links.push({
            source: ev.id, target: hp.id, score: s, abs: Math.abs(s)
          });
        }
      });
    });

    // Force simulation
    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id)
        .distance(d => 80 + (3 - d.abs) * 40)
        .strength(d => 0.08 + d.abs * 0.18))
      .force('charge', d3.forceManyBody().strength(d => d.kind === 'h' ? -200 : -25))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide().radius(d => d.r + 3))
      .force('radial', d3.forceRadial(d => d.kind === 'h' ? hypRadius : Math.min(W, H) * 0.38, W / 2, H / 2).strength(d => d.kind === 'h' ? 1 : 0.05));

    // Draw links
    const link = svg.append('g').attr('class', 'links').selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('class', d => 'net-link ' + (d.score > 0 ? 'is-pos' : 'is-neg'))
      .attr('stroke-width', d => 0.5 + d.abs * 1.2)
      .attr('data-source', d => d.source.id || d.source)
      .attr('data-target', d => d.target.id || d.target);

    // Draw nodes
    const node = svg.append('g').attr('class', 'nodes').selectAll('g')
      .data(nodes)
      .enter().append('g')
      .attr('class', 'net-node-group')
      .on('click', (event, d) => {
        if (d.kind === 'e') openEvidenceDrilldown(d.id);
        else openHypothesisDrilldown(d.id);
        state.networkSelectedNodeId = d.id;
        updateNetworkLinkVisibility();
      });

    node.append('circle')
      .attr('class', d => d.kind === 'h' ? 'net-node-h' : 'net-node-e')
      .attr('r', d => d.r);

    node.filter(d => d.kind === 'h').append('text')
      .attr('class', 'net-label-h')
      .attr('dy', '-2')
      .text(d => d.label);
    node.filter(d => d.kind === 'h').append('text')
      .attr('class', 'net-label-h-sub')
      .attr('dy', '10')
      .text(d => truncate(d.sublabel, 14));

    node.filter(d => d.kind === 'e').append('text')
      .attr('class', 'net-label-e')
      .attr('dy', d => -d.r - 3)
      .text(d => d.label);

    sim.on('tick', () => {
      link
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // Cache references for filter updates
    networkRefs.svg = svg;
    networkRefs.links = link;
    networkRefs.nodes = node;
    updateNetworkLinkVisibility();
  }

  const networkRefs = {};

  function updateNetworkLinkVisibility() {
    if (!networkRefs.links) return;
    const thresh = state.networkMinScore;
    const sel = state.networkSelectedNodeId;
    networkRefs.links.classed('is-faded', d => {
      if (Math.abs(d.score) < thresh) return true;
      if (sel == null) return false;
      const sId = d.source.id || d.source;
      const tId = d.target.id || d.target;
      return sId !== sel && tId !== sel;
    }).classed('is-emph', d => {
      if (sel == null) return false;
      const sId = d.source.id || d.source;
      const tId = d.target.id || d.target;
      return sId === sel || tId === sel;
    });
    networkRefs.nodes && networkRefs.nodes.select('circle')
      .classed('is-selected', d => d.id === sel);
  }

  // ----------------------------------------------------------
  // EVIDENCE VIEW
  // ----------------------------------------------------------

  function renderEvidenceList() {
    const v = $('.view-evidence');
    v.innerHTML = '';
    const evs = state.evidence.evidence;
    const families = state.evidence.evidenceFamilies || {};

    const toolbar = h('div', { className: 'evidence-toolbar' }, [
      h('input', {
        type: 'search',
        placeholder: t('ui.evidenceFilterPlaceholder'),
        value: state.evidenceFilter,
        onInput: (e) => { state.evidenceFilter = e.target.value; renderEvidenceList(); }
      }),
      h('span', { className: 'control-label' }, t('ui.sortBy')),
      h('select', {
        className: 'select',
        onChange: (e) => { state.evidenceSort = e.target.value; renderEvidenceList(); }
      }, [
        ['id', 'ID'], ['diag', t('ui.diagnosticity')],
        ['rel', t('ui.reliability')], ['manip', t('ui.manipulationRiskShort')]
      ].map(([val, label]) => {
        const opt = h('option', { value: val }, label);
        if (val === state.evidenceSort) opt.selected = true;
        return opt;
      })),
      h('span', { style: { color: 'var(--text-muted)', fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase' } },
        evs.length + ' total')
    ]);
    v.appendChild(toolbar);

    // Filter
    const q = state.evidenceFilter.toLowerCase();
    let filtered = q ? evs.filter(e =>
      e.id.toLowerCase().includes(q) ||
      e.observation.toLowerCase().includes(q) ||
      (e.families || []).some(f => f.toLowerCase().includes(q)) ||
      (e.notes || '').toLowerCase().includes(q)
    ) : evs;

    // Sort
    filtered = filtered.slice();
    if (state.evidenceSort === 'id') {
      filtered.sort((a, b) => {
        const an = parseInt(a.id.replace(/\D/g, ''), 10);
        const bn = parseInt(b.id.replace(/\D/g, ''), 10);
        return an - bn;
      });
    } else if (state.evidenceSort === 'diag') {
      filtered.forEach(e => { e._diag = computeDiagnosticity(e); });
      filtered.sort((a, b) => b._diag - a._diag);
    } else if (state.evidenceSort === 'rel') {
      filtered.sort((a, b) => a.reliability.localeCompare(b.reliability));
    } else if (state.evidenceSort === 'manip') {
      const rank = { low: 0, medium: 1, high: 2 };
      filtered.sort((a, b) => (rank[b.manipulationRisk] ?? 0) - (rank[a.manipulationRisk] ?? 0));
    }

    const list = h('div', { className: 'evidence-list' });
    filtered.forEach(ev => list.appendChild(renderEvidenceCard(ev)));
    v.appendChild(list);
  }

  function renderEvidenceCard(ev) {
    const diagClass = 'is-diag-' + (ev.diagnosticity || 'medium');
    return h('div', { className: 'evidence-card', onClick: () => openEvidenceDrilldown(ev.id) }, [
      h('div', { className: 'evidence-card-head' }, [
        h('div', { className: 'evidence-id' }, ev.id),
        h('div', { className: 'evidence-meta' }, [
          h('span', { className: 'tag is-reliability is-' + ev.reliability, title: t('reliabilityLabels.' + ev.reliability) }, 'R: ' + ev.reliability),
          h('span', { className: 'tag is-credibility', title: t('credibilityLabels.' + ev.credibility) }, 'C: ' + ev.credibility),
          h('span', { className: 'tag is-manip-' + ev.manipulationRisk }, 'Manip: ' + ev.manipulationRisk),
          h('span', { className: 'tag ' + diagClass }, 'Diag: ' + ev.diagnosticity),
        ])
      ]),
      h('div', { className: 'evidence-observation' }, ev.observation),
      h('div', { className: 'evidence-footer' }, [
        ...(ev.families || []).map(f => h('span', { className: 'tag is-family' }, f)),
        ev.sourceType ? h('span', { className: 'tag' }, ev.sourceType) : null
      ])
    ]);
  }

  // ----------------------------------------------------------
  // HYPOTHESES VIEW
  // ----------------------------------------------------------

  function renderHypothesesView() {
    const v = $('.view-hypotheses');
    v.innerHTML = '';
    const evs = state.evidence.evidence;

    const grid = h('div', { className: 'hypothesis-grid' });
    state.hypotheses.hypotheses.forEach(hyp => {
      const supporting = evs
        .filter(e => getEffectiveScore(e.id, hyp.id) > 0)
        .sort((a, b) => getEffectiveScore(b.id, hyp.id) - getEffectiveScore(a.id, hyp.id));
      const contradicting = evs
        .filter(e => getEffectiveScore(e.id, hyp.id) < 0)
        .sort((a, b) => getEffectiveScore(a.id, hyp.id) - getEffectiveScore(b.id, hyp.id));
      const support = computeHypothesisSupport(hyp.id);

      const card = h('div', { className: 'hypothesis-card' }, [
        h('div', { className: 'hypothesis-card-head' }, [
          h('span', { className: 'hypothesis-id' }, hyp.id),
          h('span', { className: 'confidence-pill is-' + hyp.confidence }, hyp.confidence),
          h('span', {
            style: {
              fontFamily: 'var(--font-mono)', fontWeight: 600,
              color: support >= 0 ? 'var(--rel-A)' : 'var(--neg-2-fg)',
              fontVariantNumeric: 'tabular-nums'
            }
          }, (support >= 0 ? '+' : '') + support.toFixed(1))
        ]),
        h('div', { className: 'hypothesis-card-body' }, [
          h('div', { className: 'hypothesis-label' }, hyp.label),
          h('div', { className: 'hypothesis-desc' }, hyp.description),
          h('div', { className: 'hypothesis-assessment' }, hyp.assessment),

          h('div', { className: 'subsection-label' }, t('ui.supportingEvidence') + ' (' + supporting.length + ')'),
          h('div', { className: 'evidence-pill-list' },
            supporting.map(e => h('span', {
              className: 'evidence-pill is-pos',
              onClick: (ev) => { ev.stopPropagation(); openEvidenceDrilldown(e.id); }
            }, e.id + ' ' + scoreSymbol(getEffectiveScore(e.id, hyp.id))))),

          h('div', { className: 'subsection-label' }, t('ui.contradictingEvidence') + ' (' + contradicting.length + ')'),
          h('div', { className: 'evidence-pill-list' },
            contradicting.length ? contradicting.map(e => h('span', {
              className: 'evidence-pill is-neg',
              onClick: (ev) => { ev.stopPropagation(); openEvidenceDrilldown(e.id); }
            }, e.id + ' ' + scoreSymbol(getEffectiveScore(e.id, hyp.id))))
            : [h('span', { style: { color: 'var(--text-dim)', fontSize: '11px' } }, '—')]),

          hyp.counterevidence && hyp.counterevidence.length ? h('div', null, [
            h('div', { className: 'subsection-label' }, t('ui.counterevidence')),
            h('ul', { className: 'counterevidence-list' },
              hyp.counterevidence.map(c => h('li', null, c)))
          ]) : null,

          hyp.watchFor ? h('div', { className: 'watch-for' }, [
            h('strong', { style: { color: 'var(--amber)' } }, t('ui.watchFor') + ': '),
            hyp.watchFor
          ]) : null
        ])
      ]);
      grid.appendChild(card);
    });
    v.appendChild(grid);
  }

  // ----------------------------------------------------------
  // WHAT-IF VIEW
  // ----------------------------------------------------------

  function renderWhatIf() {
    const v = $('.view-whatif');
    v.innerHTML = '';
    const hyps = state.hypotheses.hypotheses;
    const evs = state.evidence.evidence;

    const editing = hasEdits();
    const banner = h('div', {
      className: 'whatif-banner ' + (editing ? '' : 'is-baseline')
    }, [
      h('div', null, [
        h('strong', { style: { color: editing ? 'var(--amber)' : 'var(--text-muted)' } },
          editing ? '⚐ ' + t('ui.yourEditsActive') : '○ ' + t('ui.baselineActive')),
        h('span', { style: { marginLeft: '14px', color: 'var(--text-muted)' } },
          editing
            ? Object.values(state.edits).reduce((sum, ev) => sum + Object.keys(ev || {}).length, 0) + ' overrides · stored in browser localStorage'
            : 'Click any score below to override. Cycles through −2, −1, 0, +1, +2.')
      ]),
      h('div', { className: 'whatif-actions' }, [
        editing ? h('button', {
          className: 'btn',
          onClick: () => {
            clearAllEdits();
            renderWhatIf();
            renderOverview();
          }
        }, t('ui.resetEdits')) : null,
        h('button', {
          className: 'btn',
          onClick: () => downloadEditsJSON()
        }, t('ui.downloadJSON'))
      ])
    ]);
    v.appendChild(banner);

    // Mini matrix — same layout as matrix view but every cell is editable
    const wrapper = h('div', { className: 'matrix-wrapper' });
    const matrix = h('div', { className: 'matrix' });
    const gridCols = ['80px', 'minmax(280px, 1.2fr)', ...hyps.map(() => '60px'), '90px'].join(' ');
    matrix.style.gridTemplateColumns = gridCols;

    matrix.appendChild(h('div', { className: 'cell is-head' }, 'EV'));
    matrix.appendChild(h('div', { className: 'cell is-head' }, t('ui.evidence')));
    hyps.forEach(hp => {
      matrix.appendChild(h('div', { className: 'cell is-head is-hyp-head' }, [
        h('div', { className: 'hyp-id' }, hp.id),
        h('div', { className: 'hyp-short' }, hp.shortLabel || '')
      ]));
    });
    matrix.appendChild(h('div', { className: 'cell is-head' }, 'Δ'));

    evs.forEach(ev => {
      matrix.appendChild(h('div', {
        className: 'cell is-ev-id',
        onClick: () => openEvidenceDrilldown(ev.id)
      }, ev.id));
      matrix.appendChild(h('div', {
        className: 'cell',
        style: { whiteSpace: 'normal', fontSize: '12px', lineHeight: '1.4', padding: '6px 10px' }
      }, truncate(ev.observation, 140)));

      let rowDelta = 0;
      hyps.forEach(hp => {
        const score = getEffectiveScore(ev.id, hp.id);
        const baseline = ev.scores[hp.id] ?? 0;
        const isEdited = state.edits[ev.id] && (hp.id in state.edits[ev.id]);
        if (isEdited) rowDelta += Math.abs(score - baseline);
        const cell = h('div', {
          className: 'cell is-score is-editable score-' + score + (isEdited ? ' is-edited' : ''),
          style: { position: 'relative' },
          onClick: () => cycleScore(ev.id, hp.id),
          title: 'Click to cycle: ' + score + ' (baseline ' + baseline + ')'
        }, scoreSymbol(score));
        matrix.appendChild(cell);
      });

      matrix.appendChild(h('div', {
        className: 'cell is-diag',
        style: { color: rowDelta > 0 ? 'var(--amber)' : 'var(--text-dim)' }
      }, rowDelta > 0 ? '±' + rowDelta : '·'));
    });

    // Support footer
    matrix.appendChild(h('div', { className: 'cell is-support-label', style: { gridColumn: '1 / 3' } }, 'Support · Δ'));
    hyps.forEach(hp => {
      const current = computeHypothesisSupport(hp.id);
      // baseline support
      const baselineSupport = state.evidence.evidence.reduce((sum, e) => {
        return sum + ((e.scores[hp.id] ?? 0) * getSourceWeight(e));
      }, 0);
      const delta = current - baselineSupport;
      const cls = delta > 0.1 ? 'is-positive' : (delta < -0.1 ? 'is-negative' : 'is-neutral');
      matrix.appendChild(h('div', { className: 'cell is-support ' + cls, title: 'Current: ' + current.toFixed(2) + ' | Baseline: ' + baselineSupport.toFixed(2) }, [
        (current >= 0 ? '+' : '') + current.toFixed(1),
        h('div', { style: { fontSize: '9px', fontWeight: 400, opacity: 0.7, marginTop: '1px' } },
          delta === 0 ? '·' : (delta > 0 ? '+' : '') + delta.toFixed(2))
      ]));
    });
    matrix.appendChild(h('div', { className: 'cell is-support' }, ''));

    wrapper.appendChild(matrix);
    v.appendChild(wrapper);
  }

  function cycleScore(evidenceId, hypId) {
    const ev = getEvidenceById(evidenceId);
    const baseline = ev.scores[hypId] ?? 0;
    const current = getEffectiveScore(evidenceId, hypId);
    // Cycle: current → +1 (mod 5, mapping 0..4 to -2..2)
    const next = current === 2 ? -2 : current + 1;
    if (next === baseline) {
      // Remove edit
      if (state.edits[evidenceId]) {
        delete state.edits[evidenceId][hypId];
        if (Object.keys(state.edits[evidenceId]).length === 0) delete state.edits[evidenceId];
      }
    } else {
      if (!state.edits[evidenceId]) state.edits[evidenceId] = {};
      state.edits[evidenceId][hypId] = next;
    }
    saveEditsToStorage();
    renderWhatIf();
  }

  function downloadEditsJSON() {
    const payload = {
      analysisId: state.currentAnalysisId,
      exportedAt: new Date().toISOString(),
      edits: state.edits
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: state.currentAnalysisId + '-edits.json' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  // ----------------------------------------------------------
  // Drilldown drawer
  // ----------------------------------------------------------

  function openEvidenceDrilldown(evidenceId) {
    const ev = getEvidenceById(evidenceId);
    if (!ev) return;
    state.selectedEvidence = evidenceId;
    state.selectedHypothesis = null;
    renderDrilldownEvidence(ev);
    openDrilldown();
  }

  function openHypothesisDrilldown(hypId) {
    const hyp = getHypothesisById(hypId);
    if (!hyp) return;
    state.selectedHypothesis = hypId;
    state.selectedEvidence = null;
    renderDrilldownHypothesis(hyp);
    openDrilldown();
  }

  function openCellDrilldown(evidenceId, hypId) {
    const ev = getEvidenceById(evidenceId);
    if (!ev) return;
    state.selectedEvidence = evidenceId;
    state.selectedHypothesis = hypId;
    renderDrilldownEvidence(ev, hypId);
    openDrilldown();
  }

  function openDrilldown() {
    $('#app').classList.add('drilldown-open');
    $('#drilldown').setAttribute('aria-hidden', 'false');
  }

  function closeDrilldown() {
    $('#app').classList.remove('drilldown-open');
    $('#drilldown').setAttribute('aria-hidden', 'true');
    state.selectedEvidence = null;
    state.selectedHypothesis = null;
    // Update network filter
    state.networkSelectedNodeId = null;
    updateNetworkLinkVisibility();
  }

  function renderDrilldownEvidence(ev, focusHypId) {
    const content = $('#drilldown-content');
    content.innerHTML = '';

    const sourceObjects = (ev.sourceIds || [])
      .map(sid => ({ id: sid, ...getSourceById(sid) }))
      .filter(s => s.title);  // skip missing

    const hyps = state.hypotheses.hypotheses;

    content.append(
      h('div', { className: 'drilldown-head' }, [
        h('div', null, [
          h('div', { className: 'drilldown-eyebrow' }, t('ui.evidence')),
          h('div', { className: 'drilldown-title' }, ev.id)
        ]),
        h('div', { className: 'drilldown-close', onClick: closeDrilldown, title: t('ui.close') }, '×')
      ]),

      h('div', { className: 'drilldown-observation' }, ev.observation),

      ev.notes ? h('div', { className: 'drilldown-notes' }, ev.notes) : null,

      // Score row
      h('div', { className: 'drilldown-section' }, [
        h('div', { className: 'drilldown-section-label' }, t('ui.score')),
        h('div', { className: 'score-mini-row', style: { gridTemplateColumns: `repeat(${hyps.length}, 1fr)` } },
          hyps.map(hp => {
            const s = getEffectiveScore(ev.id, hp.id);
            return h('div', null, [
              h('div', { className: 'score-mini-label' }, hp.id),
              h('div', {
                className: 'score-mini score-' + s,
                style: { border: hp.id === focusHypId ? '1px solid var(--amber)' : 'none' },
                onClick: () => openHypothesisDrilldown(hp.id),
                title: hp.label + ': ' + s
              }, scoreSymbol(s))
            ]);
          }))
      ]),

      // Classification
      h('div', { className: 'drilldown-section' }, [
        h('div', { className: 'drilldown-section-label' }, 'Classification'),
        h('dl', { className: 'kv-list' }, [
          h('dt', null, t('ui.reliability')),
          h('dd', null, h('span', { className: 'tag is-reliability is-' + ev.reliability }, ev.reliability + ' — ' + t('reliabilityLabels.' + ev.reliability))),
          h('dt', null, t('ui.credibility')),
          h('dd', null, h('span', { className: 'tag is-credibility' }, ev.credibility + ' — ' + t('credibilityLabels.' + ev.credibility))),
          h('dt', null, t('ui.diagnosticity')),
          h('dd', null, h('span', { className: 'tag is-diag-' + ev.diagnosticity }, ev.diagnosticity + ' (var: ' + computeDiagnosticity(ev).toFixed(2) + ')')),
          h('dt', null, t('ui.manipulationRisk')),
          h('dd', null, h('span', { className: 'tag is-manip-' + ev.manipulationRisk }, ev.manipulationRisk)),
          h('dt', null, t('ui.timeliness')),
          h('dd', null, ev.timeliness || '—'),
          h('dt', null, t('ui.corroboration')),
          h('dd', null, ev.corroboration || '—'),
          h('dt', null, t('ui.provenance')),
          h('dd', null, ev.provenance || '—'),
          h('dt', null, t('ui.sourceType')),
          h('dd', null, ev.sourceType || '—'),
        ])
      ]),

      // Families
      ev.families && ev.families.length ? h('div', { className: 'drilldown-section' }, [
        h('div', { className: 'drilldown-section-label' }, t('ui.families')),
        h('div', null, ev.families.map(f => h('span', { className: 'tag is-family' }, f)))
      ]) : null,

      // Sources
      sourceObjects.length ? h('div', { className: 'drilldown-section' }, [
        h('div', { className: 'drilldown-section-label' }, 'Sources (' + sourceObjects.length + ')'),
        h('div', { className: 'source-list' }, sourceObjects.map(src =>
          h('a', {
            className: 'source-link',
            href: src.url, target: '_blank', rel: 'noopener noreferrer'
          }, [
            h('div', { className: 'source-pub' }, src.publisher || src.id),
            h('div', { className: 'source-title' }, [src.title, h('span', { className: 'source-link-arrow' }, '↗')]),
            h('div', { className: 'source-meta' }, [
              src.date ? h('span', null, src.date) : null,
              src.type ? h('span', null, src.type) : null,
              src.reliability ? h('span', null, 'R: ' + src.reliability) : null
            ].filter(Boolean))
          ])
        ))
      ]) : null
    );
  }

  function renderDrilldownHypothesis(hyp) {
    const content = $('#drilldown-content');
    content.innerHTML = '';
    const support = computeHypothesisSupport(hyp.id);
    const evs = state.evidence.evidence;
    const supporting = evs.filter(e => getEffectiveScore(e.id, hyp.id) > 0).length;
    const contradicting = evs.filter(e => getEffectiveScore(e.id, hyp.id) < 0).length;
    const neutral = evs.length - supporting - contradicting;

    content.append(
      h('div', { className: 'drilldown-head' }, [
        h('div', null, [
          h('div', { className: 'drilldown-eyebrow' }, t('ui.hypothesis')),
          h('div', { className: 'drilldown-title' }, hyp.id)
        ]),
        h('div', { className: 'drilldown-close', onClick: closeDrilldown }, '×')
      ]),

      h('div', { style: { fontFamily: 'var(--font-serif)', fontSize: '15px', fontWeight: 600, color: 'var(--text-strong)', marginBottom: '10px', lineHeight: '1.4' } }, hyp.label),
      h('div', { style: { fontFamily: 'var(--font-serif)', fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: '1.55' } }, hyp.description),

      h('div', { className: 'drilldown-section' }, [
        h('div', { className: 'drilldown-section-label' }, t('ui.assessment')),
        h('div', { style: { fontFamily: 'var(--font-serif)', fontSize: '13px', lineHeight: '1.55', color: 'var(--text)', borderLeft: '2px solid var(--amber)', paddingLeft: '10px' } },
          hyp.assessment)
      ]),

      h('div', { className: 'drilldown-section' }, [
        h('div', { className: 'drilldown-section-label' }, 'Aggregate'),
        h('dl', { className: 'kv-list' }, [
          h('dt', null, t('ui.confidence')),
          h('dd', null, h('span', { className: 'confidence-pill is-' + hyp.confidence }, hyp.confidence)),
          h('dt', null, 'Support'),
          h('dd', { style: { color: support >= 0 ? 'var(--rel-A)' : 'var(--neg-2-fg)', fontWeight: 600 } },
            (support >= 0 ? '+' : '') + support.toFixed(2)),
          h('dt', null, t('ui.supportingEvidence')),
          h('dd', null, supporting),
          h('dt', null, t('ui.contradictingEvidence')),
          h('dd', null, contradicting),
          h('dt', null, 'Neutral'),
          h('dd', null, neutral),
        ])
      ]),

      hyp.counterevidence && hyp.counterevidence.length ? h('div', { className: 'drilldown-section' }, [
        h('div', { className: 'drilldown-section-label' }, t('ui.counterevidence')),
        h('ul', { className: 'counterevidence-list' }, hyp.counterevidence.map(c => h('li', null, c)))
      ]) : null,

      hyp.watchFor ? h('div', { className: 'watch-for', style: { marginTop: '16px' } }, [
        h('strong', { style: { color: 'var(--amber)' } }, t('ui.watchFor') + ': '),
        hyp.watchFor
      ]) : null
    );
  }

  // ----------------------------------------------------------
  // View routing
  // ----------------------------------------------------------

  function renderActiveView() {
    switch (state.view) {
      case 'overview':   return renderOverview();
      case 'matrix':     return renderMatrix();
      case 'network':    return renderNetwork();
      case 'evidence':   return renderEvidenceList();
      case 'hypotheses': return renderHypothesesView();
      case 'whatif':     return renderWhatIf();
    }
  }

  function renderAll() {
    renderHeader();
    // Re-localize tab labels with current i18n
    $$('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      const val = t(key);
      if (val !== key) el.textContent = val;
    });
    renderActiveView();
  }

  // ----------------------------------------------------------
  // Boot
  // ----------------------------------------------------------

  function preferredAnalysisId() {
    const ids = new Set(state.manifest.analyses.map(a => a.id));
    const fromHash = (location.hash || '').replace(/^#/, '');
    let fromStorage = null;
    try { fromStorage = localStorage.getItem('ach-explorer:last-analysis'); } catch (e) { /* fine */ }
    for (const candidate of [fromHash, fromStorage, state.manifest.analyses[0]?.id]) {
      if (candidate && ids.has(candidate)) return candidate;
    }
    return null;
  }

  async function boot() {
    setupTabs();
    setupHeaderControls();
    setStatus('BOOTING…');
    try {
      await loadManifest();
      const analysisId = preferredAnalysisId();
      if (!analysisId) throw new Error(t('ui.noAnalysesFound'));
      await loadAnalysis(analysisId);
      renderAll();
    } catch (e) {
      setStatus('ERROR: ' + e.message);
      $('.view-overview').innerHTML = '<div class="loading">' + e.message + '</div>';
      $('.view-overview').classList.add('is-active');
      console.error(e);
    }
  }

  // Window resize → re-render network
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (state.view === 'network') renderNetwork();
    }, 200);
  });

  document.addEventListener('DOMContentLoaded', boot);
  // Esc closes drilldown
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrilldown();
  });

})();
