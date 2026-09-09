const STORE_KEYS = 'scanner_api_keys';
const STORE_LEADS = 'scanner_leads';
const STORE_RESULTS = 'scanner_last_results';
const STORE_HISTORY = 'scanner_history';
const STORE_QUOTA_DATE = 'scanner_quota_reset_date';
const MAX_HISTORY = 20;

let apiKeys = [];   // {key, used, exhausted}
let leads = [];
let niches = [];
let lastResults = [];
let history = [];   // [{id, ts, query, country, minSubs, maxSubs, recentDays, requireEmail, results}]
let leadFilter = 'all';
let searching = false;
let lastSearchStats = null; // estatísticas da última busca (p/ explicar 0 resultados), não persiste entre sessões

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function toast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2400);
}

// A cota da YouTube Data API reseta à meia-noite no fuso de Los Angeles
// (Pacific Time), não na meia-noite local. Sem isso, uma chave marcada como
// "esgotada" ficaria esgotada pra sempre no localStorage, mesmo depois do
// Google já ter liberado a cota de novo.
function pacificDateString(){
  return new Date().toLocaleDateString('en-CA', {timeZone: 'America/Los_Angeles'});
}
function resetQuotaIfNewDay(){
  const today = pacificDateString();
  const last = localStorage.getItem(STORE_QUOTA_DATE);
  if(last !== today){
    if(apiKeys.length){
      apiKeys.forEach(k => { k.used = 0; k.exhausted = false; });
      saveKeys();
    }
    localStorage.setItem(STORE_QUOTA_DATE, today);
    if(last !== null) renderKeys(); // não notifica no primeiríssimo carregamento
  }
}

// ---------- storage (localStorage — persists per browser, not synced anywhere) ----------
function loadState(){
  try{ apiKeys = JSON.parse(localStorage.getItem(STORE_KEYS) || '[]'); }
  catch(e){ apiKeys = []; }
  try{ leads = JSON.parse(localStorage.getItem(STORE_LEADS) || '[]'); }
  catch(e){ leads = []; }
  try{ lastResults = JSON.parse(localStorage.getItem(STORE_RESULTS) || '[]'); }
  catch(e){ lastResults = []; }
  try{ history = JSON.parse(localStorage.getItem(STORE_HISTORY) || '[]'); }
  catch(e){ history = []; }
  resetQuotaIfNewDay();
  renderKeys();
  renderLeads();
  updateLeadBadge();
  renderResults();
  renderHistory();
}
function saveKeys(){
  try{ localStorage.setItem(STORE_KEYS, JSON.stringify(apiKeys)); }
  catch(e){ toast('Erro ao salvar chaves'); }
}
function saveLeads(){
  try{ localStorage.setItem(STORE_LEADS, JSON.stringify(leads)); }
  catch(e){ toast('Erro ao salvar leads'); }
}
function saveResults(){
  try{ localStorage.setItem(STORE_RESULTS, JSON.stringify(lastResults)); }
  catch(e){ toast('Erro ao salvar resultados (armazenamento cheio?)'); }
}
function saveHistory(){
  try{ localStorage.setItem(STORE_HISTORY, JSON.stringify(history)); }
  catch(e){
    // provavelmente estourou a cota do localStorage — solta as entradas mais antigas e tenta de novo
    if(history.length > 1){
      history = history.slice(0, Math.max(1, Math.floor(history.length/2)));
      saveHistory();
      toast('Histórico ficou grande demais — mantive só as buscas mais recentes');
    } else {
      toast('Erro ao salvar histórico');
    }
  }
}

// ---------- tabs ----------
$$('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    $$('.tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('#searchPanel').style.display = tab === 'search' ? 'flex' : 'none';
    $('#mainSearch').style.display = tab === 'search' ? 'block' : 'none';
    $('#mainLeads').style.display = tab === 'leads' ? 'block' : 'none';
    $('#mainKeys').style.display = tab === 'keys' ? 'block' : 'none';
  });
});

// ---------- niche tags ----------
$('#nicheInput').addEventListener('keydown', e=>{
  if(e.key === 'Enter'){
    e.preventDefault();
    const v = e.target.value.trim();
    if(v && niches.length < 3 && !niches.includes(v)){
      niches.push(v);
      e.target.value = '';
      renderNiches();
    }
  }
});
function renderNiches(){
  $('#nicheTags').innerHTML = niches.map((n,i)=>
    `<span class="tag">${escapeHtml(n)}<button data-remove-niche="${i}">×</button></span>`
  ).join('');
  $$('[data-remove-niche]').forEach(b=>b.addEventListener('click', ()=>{
    niches.splice(parseInt(b.dataset.removeNiche),1);
    renderNiches();
  }));
}

// ---------- api keys ----------
$('#addKeyBtn').addEventListener('click', ()=>{
  const input = $('#newKeyInput');
  const val = input.value.trim();
  if(!val){ toast('Cole uma chave válida'); return; }
  apiKeys.push({key: val, used: 0, exhausted: false});
  input.value = '';
  saveKeys();
  renderKeys();
  toast('Chave adicionada');
});
function renderKeys(){
  const box = $('#keysBox');
  if(!apiKeys.length){
    box.innerHTML = '<p class="hint">Nenhuma chave adicionada ainda.</p>';
    return;
  }
  box.innerHTML = apiKeys.map((k,i)=>{
    const masked = k.key.slice(0,4) + '••••••••••' + k.key.slice(-4);
    const pct = Math.min(100, Math.round((k.used/10000)*100));
    let pillClass = 'ok', pillText = pct+'%';
    if(k.exhausted || pct >= 100){ pillClass='dead'; pillText='esgotada'; }
    else if(pct >= 70){ pillClass='hot'; }
    return `<div class="key-row">
      <span class="key-code">${masked}</span>
      <span style="display:flex;align-items:center;gap:8px;">
        <span class="pill ${pillClass}">${pillText}</span>
        <button class="icon-btn" data-remove-key="${i}" title="remover">✕</button>
      </span>
    </div>`;
  }).join('');
  $$('[data-remove-key]').forEach(b=>b.addEventListener('click', ()=>{
    apiKeys.splice(parseInt(b.dataset.removeKey),1);
    saveKeys(); renderKeys();
  }));
}

function getActiveKey(){
  return apiKeys.find(k => !k.exhausted && k.used < 10000);
}

// ---------- YouTube API ----------
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function ytFetch(path, params, retry = 0){
  const key = getActiveKey();
  if(!key) throw new Error('NO_KEY');
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries(params).forEach(([k,v])=>{ if(v!==undefined && v!=='') url.searchParams.set(k,v); });
  url.searchParams.set('key', key.key);
  const cost = path === 'search' ? 100 : 1;

  let res, data;
  try{
    res = await fetch(url.toString());
    data = await res.json().catch(()=>({}));
  }catch(networkErr){
    // falha de rede (sem internet, DNS, etc.) — também vale retry
    if(retry < 3){ await sleep(500 * (retry+1)); return ytFetch(path, params, retry+1); }
    throw new Error('Falha de rede ao chamar a API do YouTube.');
  }

  if(!res.ok){
    const reason = data?.error?.errors?.[0]?.reason || '';
    const status = data?.error?.status || '';
    const errMsg = data?.error?.message || '';
    // a API mudou o formato do erro de cota: hoje muitas vezes vem sem
    // "reason: quotaExceeded", só como status RESOURCE_EXHAUSTED + mensagem
    // de texto genérica — então checamos os dois formatos
    const isQuotaExceeded = reason === 'quotaExceeded' || reason === 'dailyLimitExceeded'
      || status === 'RESOURCE_EXHAUSTED' || /quota exceeded/i.test(errMsg);
    if(isQuotaExceeded){
      key.exhausted = true;
      saveKeys(); renderKeys();
      const next = getActiveKey();
      if(next){ toast('Essa chave esgotou a cota diária — trocando para a próxima.'); return ytFetch(path, params); }
      throw new Error('ALL_KEYS_EXHAUSTED');
    }
    // erros passageiros do lado do Google (instabilidade momentânea) — tenta
    // de novo automaticamente em vez de derrubar a busca inteira
    const transient = res.status === 503 || res.status === 500 || res.status === 429
      || reason === 'backendError' || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
    if(transient && retry < 3){
      log(`Instabilidade momentânea do Google (${res.status}), tentando de novo...`);
      await sleep(600 * (retry+1)); // backoff progressivo
      return ytFetch(path, params, retry+1);
    }
    throw new Error(errMsg || `Erro na API (HTTP ${res.status})`);
  }
  key.used += cost;
  saveKeys(); renderKeys();
  return data;
}

// activities.list com "publishedAfter" é ignorado pela API do YouTube há anos
// (bug conhecido/documentado — o parâmetro não filtra nada, sempre retorna
// alguma atividade do canal). Por isso checamos a data real do último vídeo
// direto na playlist de uploads do canal, que é confiável e custa o mesmo
// (1 unidade).
async function getLastUploadDate(uploadsPlaylistId){
  if(!uploadsPlaylistId) return null;
  try{
    const data = await ytFetch('playlistItems', {
      part:'contentDetails', playlistId: uploadsPlaylistId, maxResults: 1
    });
    const iso = data.items?.[0]?.contentDetails?.videoPublishedAt;
    return iso ? new Date(iso) : null;
  }catch(e){
    // se a checagem falhar (playlist privada/erro pontual), não afirma nada
    return undefined; // undefined = "não sei" (diferente de null = "sem vídeos")
  }
}

function extractContacts(text){
  if(!text) return {};
  const email = (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) || [])[0];
  const twitter = (text.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+/i) || [])[0];
  const discord = (text.match(/(?:https?:\/\/)?(?:www\.)?discord\.(?:gg|com\/invite)\/[A-Za-z0-9]+/i) || [])[0];
  const instagram = (text.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+/i) || [])[0];
  return {email, twitter, discord, instagram};
}

function log(msg){
  const el = $('#scanLog');
  el.style.display = 'block';
  el.textContent = msg;
}

$('#searchBtn').addEventListener('click', runSearch);

async function runSearch(){
  if(searching) return;
  if(!niches.length){ toast('Adicione ao menos um nicho'); return; }
  if(!getActiveKey()){ toast('Adicione uma chave de API na aba "Chaves API"'); return; }

  searching = true;
  const btn = $('#searchBtn');
  btn.disabled = true; btn.textContent = 'Buscando...';

  const query = niches.join(' ');
  const country = $('#countrySelect').value;
  const desired = parseInt($('#countInput').value) || 20;
  const minSubs = parseInt($('#minSubs').value) || 0;
  const maxSubs = parseInt($('#maxSubs').value) || Infinity;
  const requireEmail = $('#requireEmail').checked;
  const recentDays = parseInt($('#recentActivity').value) || 0;
  let publishedAfterISO = null;
  if(recentDays > 0){
    const d = new Date();
    d.setDate(d.getDate() - recentDays);
    publishedAfterISO = d.toISOString();
  }

  let matched = [];
  let pageToken = undefined;
  let pages = 0;
  const maxPages = 6;
  const seen = new Set();
  const stats = {checked:0, topic:0, subsHidden:0, subsRange:0, country:0, email:0, activity:0};

  try{
    while(matched.length < desired && pages < maxPages){
      pages++;
      log(`Escaneando... página ${pages} · ${matched.length}/${desired} encontrados${publishedAfterISO ? ' · checando atividade recente' : ''}`);
      const searchData = await ytFetch('search', {
        part:'snippet', type:'channel', q: query, maxResults: 50,
        regionCode: country || undefined, pageToken
      });
      const ids = (searchData.items || [])
        .map(it => it.snippet?.channelId || it.id?.channelId)
        .filter(id => id && !seen.has(id));
      ids.forEach(id => seen.add(id));

      if(ids.length){
        const chData = await ytFetch('channels', {
          part:'snippet,statistics,brandingSettings,contentDetails', id: ids.join(',')
        });
        for(const ch of (chData.items || [])){
          stats.checked++;
          const title = ch.snippet?.title || '';
          // canais "Topic" são auto-gerados pelo YouTube (música/tópicos), sem
          // dono real, sem contato — sempre têm esse sufixo no título
          if(/-\s*topic$/i.test(title.trim())){ stats.topic++; continue; }
          const subsHidden = ch.statistics?.hiddenSubscriberCount;
          const subs = parseInt(ch.statistics?.subscriberCount || '0');
          if(subsHidden){ stats.subsHidden++; continue; }
          if(subs < minSubs || subs > maxSubs){ stats.subsRange++; continue; }
          if(country && ch.snippet?.country && ch.snippet.country.toUpperCase() !== country){ stats.country++; continue; }

          const descText = (ch.snippet?.description||'') + ' ' + (ch.brandingSettings?.channel?.description||'');
          if(/auto-generated by youtube/i.test(descText)){ stats.topic++; continue; } // reforço p/ canais Topic sem o sufixo no título
          const contacts = extractContacts(descText);
          if(requireEmail && !contacts.email){ stats.email++; continue; }

          let lastUpload = null;
          if(publishedAfterISO){
            const uploadsPlaylistId = ch.contentDetails?.relatedPlaylists?.uploads;
            const lastDate = await getLastUploadDate(uploadsPlaylistId);
            if(lastDate === null){ stats.activity++; continue; } // canal sem vídeos na playlist de uploads
            if(lastDate !== undefined){
              if(lastDate < new Date(publishedAfterISO)){ stats.activity++; continue; } // último vídeo é mais antigo que o filtro
              lastUpload = lastDate.toISOString();
            }
            // lastDate === undefined: checagem falhou pontualmente, não bloqueia o canal
          }

          matched.push({
            id: ch.id,
            title: ch.snippet?.title,
            handle: ch.snippet?.customUrl || '',
            subs,
            country: ch.snippet?.country || '',
            thumbnail: ch.snippet?.thumbnails?.default?.url || '',
            niche: niches.join(', '),
            lastUpload,
            ...contacts
          });
          if(matched.length >= desired) break;
        }
      }
      pageToken = searchData.nextPageToken;
      if(!pageToken) break;
    }
  }catch(e){
    if(e.message === 'ALL_KEYS_EXHAUSTED'){
      toast('Todas as chaves atingiram o limite diário. Adicione outra ou volte amanhã.');
    } else if(e.message === 'NO_KEY'){
      toast('Nenhuma chave disponível.');
    } else {
      toast('Erro: ' + e.message);
    }
  }

  $('#scanLog').style.display = 'none';
  lastResults = matched;
  lastSearchStats = stats;
  saveResults();

  if(matched.length){
    history.unshift({
      id: Date.now(),
      ts: Date.now(),
      query, country, minSubs, maxSubs, recentDays, requireEmail,
      results: matched
    });
    if(history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
    saveHistory();
    renderHistory();
  }

  renderResults();
  btn.disabled = false; btn.textContent = 'Iniciar busca';
  searching = false;
}

function renderHistory(){
  const box = $('#historyBox');
  if(!box) return;
  if(!history.length){
    box.innerHTML = '<p class="hint">Nenhuma busca salva ainda.</p>';
    return;
  }
  box.innerHTML = history.map((h,i)=>{
    const when = timeAgo(h.ts);
    const filters = [
      h.country ? flagFor(h.country) : null,
      (h.minSubs || (h.maxSubs && isFinite(h.maxSubs))) ? `${formatSubs(h.minSubs||0)}–${h.maxSubs && isFinite(h.maxSubs) ? formatSubs(h.maxSubs) : '∞'}` : null,
      h.recentDays ? `últ. ${h.recentDays}d` : null,
      h.requireEmail ? 'c/ e-mail' : null,
    ].filter(Boolean).join(' · ');
    return `<div class="history-item">
      <div class="history-info">
        <div class="history-query">${escapeHtml(h.query)}</div>
        <div class="history-meta">${h.results.length} canais · ${when}${filters ? ' · '+filters : ''}</div>
      </div>
      <div class="history-actions">
        <button class="icon-btn" data-restore="${i}" title="reabrir estes resultados">↺</button>
        <button class="icon-btn" data-del-hist="${i}" title="remover do histórico">✕</button>
      </div>
    </div>`;
  }).join('');
  $$('[data-restore]').forEach(b=>b.addEventListener('click', ()=>{
    const h = history[parseInt(b.dataset.restore)];
    lastResults = h.results;
    lastSearchStats = null;
    saveResults();
    renderResults();
    $$('.tab-btn').forEach(t=>t.classList.remove('active'));
    $('[data-tab="search"]').classList.add('active');
    $('#searchPanel').style.display = 'flex';
    $('#mainSearch').style.display = 'block';
    $('#mainLeads').style.display = 'none';
    $('#mainKeys').style.display = 'none';
    toast('Resultados restaurados do histórico (sem gastar cota)');
  }));
  $$('[data-del-hist]').forEach(b=>b.addEventListener('click', ()=>{
    history.splice(parseInt(b.dataset.delHist),1);
    saveHistory();
    renderHistory();
  }));
}
function timeAgo(ts){
  const diff = Math.floor((Date.now()-ts)/1000);
  if(diff < 60) return 'agora';
  if(diff < 3600) return Math.floor(diff/60)+'min atrás';
  if(diff < 86400) return Math.floor(diff/3600)+'h atrás';
  return Math.floor(diff/86400)+'d atrás';
}

function renderResults(){
  const root = $('#resultsRoot');
  if(!lastResults.length){
    if(lastSearchStats && lastSearchStats.checked > 0){
      const s = lastSearchStats;
      const rows = [
        ['Canais "Topic" (auto-gerados)', s.topic],
        ['Inscritos ocultos', s.subsHidden],
        ['Fora da faixa de inscritos', s.subsRange],
        ['País diferente do filtro', s.country],
        ['Sem e-mail público', s.email],
        ['Sem atividade no período', s.activity],
      ].filter(([,n]) => n > 0);
      root.innerHTML = `<div class="empty">
        ${emptyIcon()}
        <h3>0 resultados — mas a busca rodou</h3>
        <p>${s.checked} canais foram checados e todos caíram em algum filtro:</p>
        <div style="text-align:left;margin-top:10px;">
          ${rows.map(([label,n])=>`<div class="hint">• ${label}: <b style="color:var(--text)">${n}</b></div>`).join('')}
        </div>
        <p style="margin-top:10px;">Tente afrouxar a faixa de inscritos, tirar o filtro de país/e-mail, ou aumentar os dias em "postou recentemente".</p>
      </div>`;
    } else {
      root.innerHTML = `<div class="empty">
        ${emptyIcon()}
        <h3>Nenhuma busca ainda</h3>
        <p>Defina nicho, faixa de inscritos e país no painel à esquerda, depois clique em "Iniciar busca".</p>
      </div>`;
    }
    return;
  }
  const rows = lastResults.map((c,i)=>`
    <div class="channel-card">
      <input type="checkbox" class="checkbox" data-idx="${i}" checked>
      <img src="${c.thumbnail}" alt="">
      <div class="channel-info">
        <div class="name">${escapeHtml(c.title)} ${c.country ? flagFor(c.country):''}</div>
        <div class="meta">
          <span>${formatSubs(c.subs)} inscritos</span>
          ${c.handle ? `<span>${escapeHtml(c.handle)}</span>` : ''}
          ${c.lastUpload ? `<span>último vídeo: ${timeAgo(new Date(c.lastUpload).getTime())}</span>` : ''}
        </div>
        <div class="contact-links">
          ${c.email ? `<span class="clink email">✉ e-mail</span>` : ''}
          ${c.twitter ? `<a class="clink" href="${normalizeUrl(c.twitter)}" target="_blank" rel="noopener">Twitter/X</a>` : ''}
          ${c.discord ? `<a class="clink" href="${normalizeUrl(c.discord)}" target="_blank" rel="noopener">Discord</a>` : ''}
          ${c.instagram ? `<a class="clink" href="${normalizeUrl(c.instagram)}" target="_blank" rel="noopener">Instagram</a>` : ''}
          <a class="clink" href="https://youtube.com/channel/${c.id}" target="_blank" rel="noopener">Abrir canal</a>
        </div>
      </div>
    </div>
  `).join('');

  root.innerHTML = `
    <div class="results-head">
      <span class="count"><b>${lastResults.length}</b> canais encontrados</span>
    </div>
    ${rows}
    <div class="import-bar">
      <span id="selectedCount">${lastResults.length} selecionados</span>
      <button class="btn" id="importBtn">Importar para Leads</button>
    </div>
  `;
  $$('.checkbox').forEach(cb => cb.addEventListener('change', updateSelectedCount));
  $('#importBtn').addEventListener('click', importSelected);
}
function updateSelectedCount(){
  const n = [...$$('.checkbox')].filter(c=>c.checked).length;
  $('#selectedCount').textContent = n + ' selecionados';
}
function importSelected(){
  const idxs = [...$$('.checkbox')].filter(c=>c.checked).map(c=>parseInt(c.dataset.idx));
  let added = 0;
  idxs.forEach(i=>{
    const c = lastResults[i];
    if(leads.some(l=>l.id===c.id)) return;
    leads.push({...c, status:'not_contacted', notes:'', importedAt: Date.now()});
    added++;
  });
  saveLeads();
  renderLeads();
  updateLeadBadge();
  toast(`${added} canais importados para Leads`);
}

// ---------- leads / crm ----------
const STATUS_META = {
  not_contacted: {label:'Não contatado', color:'#8992a3'},
  contacted:     {label:'Contatado', color:'#8e8ff0'},
  replied:       {label:'Respondeu', color:'#f0a860'},
  partnership:   {label:'Parceria', color:'#4fd1a5'},
  declined:      {label:'Recusou', color:'#e8677d'},
};
function updateLeadBadge(){
  $('#leadCountBadge').textContent = leads.length ? `(${leads.length})` : '';
}
function renderLeadFilters(){
  const counts = {all: leads.length};
  Object.keys(STATUS_META).forEach(k => counts[k] = leads.filter(l=>l.status===k).length);
  const chips = [['all','Todos']].concat(Object.entries(STATUS_META).map(([k,v])=>[k,v.label]));
  $('#leadFilters').innerHTML = chips.map(([k,label])=>
    `<button class="filter-chip ${leadFilter===k?'active':''}" data-f="${k}">${label} · ${counts[k]||0}</button>`
  ).join('');
  $$('.filter-chip').forEach(b=>b.addEventListener('click', ()=>{
    leadFilter = b.dataset.f; renderLeads();
  }));
}
function renderLeads(){
  renderLeadFilters();
  const root = $('#leadsRoot');
  const visible = leadFilter==='all' ? leads : leads.filter(l=>l.status===leadFilter);
  if(!visible.length){
    root.innerHTML = `<div class="empty">
      ${emptyIcon()}
      <h3>Nenhum lead aqui</h3>
      <p>Importe canais a partir da aba "Buscar" para começar a organizar sua prospecção.</p>
    </div>`;
    return;
  }
  root.innerHTML = visible.map(l=>{
    const idx = leads.indexOf(l);
    const meta = STATUS_META[l.status] || STATUS_META.not_contacted;
    return `<div class="lead-card">
      <div class="lead-top">
        <div class="left">
          <img src="${l.thumbnail}" alt="">
          <div>
            <div class="name">${escapeHtml(l.title)}</div>
            <div class="meta">${formatSubs(l.subs)} inscritos · ${escapeHtml(l.niche||'')} ${l.country?('· '+flagFor(l.country)):''}</div>
            <div class="contact-links">
              ${l.email ? `<span class="clink email">✉ ${escapeHtml(l.email)}</span>` : ''}
              ${l.twitter ? `<a class="clink" href="${normalizeUrl(l.twitter)}" target="_blank" rel="noopener">Twitter/X</a>` : ''}
              ${l.discord ? `<a class="clink" href="${normalizeUrl(l.discord)}" target="_blank" rel="noopener">Discord</a>` : ''}
              <a class="clink" href="https://youtube.com/channel/${l.id}" target="_blank" rel="noopener">Abrir canal</a>
            </div>
          </div>
        </div>
        <div class="lead-actions">
          <select class="status-select" style="color:${meta.color};border-color:${meta.color};" data-idx="${idx}">
            ${Object.entries(STATUS_META).map(([k,v])=>`<option value="${k}" ${l.status===k?'selected':''}>${v.label}</option>`).join('')}
          </select>
          <button class="icon-btn" data-del="${idx}" title="remover">✕</button>
        </div>
      </div>
      <div class="lead-notes">
        <textarea placeholder="Anotações..." data-note="${idx}">${escapeHtml(l.notes||'')}</textarea>
      </div>
    </div>`;
  }).join('');

  $$('.status-select').forEach(s=>s.addEventListener('change', e=>{
    leads[parseInt(e.target.dataset.idx)].status = e.target.value;
    saveLeads(); renderLeads();
  }));
  $$('[data-del]').forEach(b=>b.addEventListener('click', e=>{
    leads.splice(parseInt(e.target.dataset.del),1);
    saveLeads(); renderLeads(); updateLeadBadge();
  }));
  $$('[data-note]').forEach(t=>{
    let timer;
    t.addEventListener('input', e=>{
      clearTimeout(timer);
      timer = setTimeout(()=>{
        leads[parseInt(e.target.dataset.note)].notes = e.target.value;
        saveLeads();
      }, 500);
    });
  });
}

$('#exportBtn').addEventListener('click', ()=>{
  if(!leads.length){ toast('Nenhum lead para exportar'); return; }
  const headers = ['title','handle','subs','country','niche','status','email','twitter','discord','instagram','notes','channel_url'];
  const rows = leads.map(l => headers.map(h=>{
    if(h==='channel_url') return `https://youtube.com/channel/${l.id}`;
    if(h==='status') return STATUS_META[l.status]?.label || l.status;
    const v = l[h] ?? '';
    return `"${String(v).replace(/"/g,'""')}"`;
  }).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'leads.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- helpers ----------
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function formatSubs(n){ if(n>=1000000) return (n/1000000).toFixed(1)+'M'; if(n>=1000) return (n/1000).toFixed(1)+'K'; return String(n); }
function normalizeUrl(u){ return u.startsWith('http') ? u : 'https://'+u; }
function flagFor(cc){
  const map = {BR:'🇧🇷',US:'🇺🇸',PT:'🇵🇹',MX:'🇲🇽',AR:'🇦🇷',ES:'🇪🇸',FR:'🇫🇷',DE:'🇩🇪',IT:'🇮🇹',GB:'🇬🇧',CA:'🇨🇦',AU:'🇦🇺'};
  return map[cc?.toUpperCase()] || '';
}
function emptyIcon(){
  return `<svg width="40" height="40" viewBox="0 0 40 40" fill="none">
    <circle cx="20" cy="20" r="15" stroke="#2e3644" stroke-width="2"/>
    <circle cx="20" cy="20" r="6" stroke="#4fd1a5" stroke-width="2"/>
  </svg>`;
}

loadState();