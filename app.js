/* 女佣中餐助手 — 交互逻辑（阶段2：库存 + 人数 + 今日推荐） */
'use strict';

/* ================= 数据存储 ================= */
const STORE_KEY = 'maidChef.v1';

const state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // 葱姜蒜已改为调料，自动清掉旧的库存记录
      const inventory = (Array.isArray(s.inventory) ? s.inventory : []).filter(i => !['garlic', 'ginger', 'scallion'].includes(i.key));
      const customIngs = Array.isArray(s.customIngs) ? s.customIngs : [];
      // 迁移：库存里已有的自定义食材，补进快捷图标列表
      for (const it of inventory) {
        if (typeof it.key === 'string' && it.key.startsWith('custom:') && !customIngs.find(c => c.key === it.key)) {
          customIngs.push({ key: it.key, customName: it.customName || it.key.slice(7), nameId: it.nameId || null });
        }
      }
      // 迁移：能对上预设/别名的自定义食材，升级成预设 key
      const mig = migrateCustoms(inventory, customIngs);
      return {
        inventory: mig.inv,
        history: Array.isArray(s.history) ? s.history : [],
        persons: s.persons >= 1 ? s.persons : 2,
        plan: s.plan && Array.isArray(s.plan.days) ? s.plan : null,
        customRecipes: Array.isArray(s.customRecipes) ? s.customRecipes : [],
        customIngs: mig.customs,
        diet: s.diet && typeof s.diet === 'object' ? s.diet : { chicken: true, pork: true, beef: true },
        sync: s.sync && typeof s.sync.family === 'string' ? s.sync : { family: '' },
        updatedAt: s.updatedAt || 0,
      };
    }
  } catch (e) { /* 数据损坏则重置 */ }
  return { inventory: [], history: [], persons: 2, plan: null, customRecipes: [], customIngs: [], diet: { chicken: true, pork: true, beef: true }, sync: { family: '' }, updatedAt: 0 };
}

/* 自定义食材升级：能对上预设/别名的 custom: 项改成预设 key（享受专属图标和菜谱推荐） */
function migrateCustoms(inventory, customIngs) {
  const inv = [];
  for (const it of inventory) {
    if (typeof it.key === 'string' && it.key.startsWith('custom:')) {
      const pk = presetKeyForZh(it.customName || it.key.slice(7));
      if (pk) {
        const exist = inv.find(x => x.key === pk);
        if (exist) { exist.qty += it.qty; continue; } // 已有同种预设，合并数量
        inv.push({ ...it, key: pk, customName: null, nameId: null });
        continue;
      }
    }
    inv.push(it);
  }
  const customs = (customIngs || []).filter(c => !presetKeyForZh(c.customName || c.key.slice(7)));
  return { inv, customs };
}

function save(skipPush) {
  state.updatedAt = Date.now();
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  if (!skipPush) syncPush();
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmtDate(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

function presetOf(key) {
  return INGREDIENT_PRESETS.find(p => p.key === key);
}

/* 内置菜谱 + 用户自定义菜谱 */
function allRecipes() {
  return RECIPES.concat(state.customRecipes || []);
}

/* 葱姜蒜：辅料不卡推荐（默认家里常有或顺手能买），只在使用时扣减 */
const SOFT_INGREDIENTS = ['garlic', 'ginger', 'scallion'];

function isSoft(key) {
  return SOFT_INGREDIENTS.includes(key);
}

/* 饮食偏好：某类荤菜是否允许（false = 不吃，推荐/菜单里排除） */
function dietAllowed(category) {
  return !state.diet || state.diet[category] !== false;
}

const DIET_OPTS = [
  { id: 'chicken', zh: '鸡肉' },
  { id: 'pork',    zh: '猪肉' },
  { id: 'beef',    zh: '牛肉' },
];

function stockQty(key) {
  const item = state.inventory.find(i => i.key === key);
  return item ? item.qty : 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= 库存操作 ================= */
function addStock(key, customName, nameId) {
  const existing = state.inventory.find(i => i.key === key);
  if (existing) {
    existing.qty += 1;
    if (nameId && !existing.nameId) existing.nameId = nameId;
  } else {
    state.inventory.push({ key, qty: 1, addedAt: Date.now(), customName: customName || null, nameId: nameId || null });
  }
  // 自定义食材记入快捷图标列表（下次直接点图标 +1）
  if (key.startsWith('custom:')) {
    const c = state.customIngs.find(x => x.key === key);
    if (!c) {
      state.customIngs.push({ key, customName: customName || key.slice(7), nameId: nameId || null });
    } else if (nameId && !c.nameId) {
      c.nameId = nameId;
    }
  }
  save();
}

function changeQty(key, delta) {
  const item = state.inventory.find(i => i.key === key);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) {
    state.inventory = state.inventory.filter(i => i !== item);
  }
  save();
}

function removeStock(key) {
  state.inventory = state.inventory.filter(i => i.key !== key);
  save();
}

/* 自定义食材：输入中文 → 返回 {presetKey} 或 {nameId, unitId} 或 null（不认识） */
function lookupCustom(zhName) {
  const pk = presetKeyForZh(zhName); // 预设正式名 + 别名（蒜台/羊角豆/豆芽菜等）
  if (pk) return { presetKey: pk };
  if (ZH_TO_ID[zhName]) return ZH_TO_ID[zhName];
  return null;
}

/* ================= 推荐算法 ================= */
function daysAgo(dateStr) {
  const then = new Date(dateStr + 'T00:00:00');
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

function recentCookedIds(withinDays) {
  return state.history
    .filter(h => daysAgo(h.date) < withinDays)
    .map(h => h.recipeId);
}

function yesterdayCategory() {
  const y = state.history.find(h => daysAgo(h.date) === 1);
  if (!y) return null;
  const r = allRecipes().find(x => x.id === y.recipeId);
  return r ? r.category : null;
}

/* 返回按优先级排序的候选：先做"能做"的，再按旧食材优先、避免与昨天同类 */
function recommend() {
  const cookedRecent = recentCookedIds(7); // 底线：一周不重复
  const yCat = yesterdayCategory();
  const result = [];

  for (const recipe of allRecipes()) {
    if (cookedRecent.includes(recipe.id)) continue;
    if (!dietAllowed(recipe.category)) continue; // 不吃的荤菜类别直接排除

    const missing = [];
    let oldestTs = 0;
    for (const ing of recipe.ingredients) {
      if (isSoft(ing.key)) continue; // 葱姜蒜不作为可行性门槛
      const need = scaledQty(ing.qty, state.persons);
      const have = stockQty(ing.key);
      if (have < need) {
        const p = presetOf(ing.key);
        missing.push({ key: ing.key, nameZh: p ? p.nameZh : ing.key, need, have });
      } else {
        const item = state.inventory.find(i => i.key === ing.key);
        if (item && (oldestTs === 0 || item.addedAt < oldestTs)) oldestTs = item.addedAt;
      }
    }

    let score = 0;
    if (missing.length === 0) {
      score += 1000;
      // 越早入库的食材越先用（时间戳越小分越高）
      if (oldestTs > 0) score += Math.min(500, (Date.now() - oldestTs) / 3600000);
      // 避免和昨天同类别
      if (yCat && recipe.category === yCat) score -= 100;
      score -= recipe.difficulty * 10;
      score -= recipe.timeMin; // 同等条件下快的优先
    }

    result.push({ recipe, missing, feasible: missing.length === 0, score });
  }

  const feasible = result.filter(r => r.feasible).sort((a, b) => b.score - a.score);
  const nearMiss = result
    .filter(r => !r.feasible && r.missing.length <= 2)
    .sort((a, b) => a.missing.length - b.missing.length);

  return { feasible, nearMiss };
}

/* ================= 标记已做 ================= */
function markCooked(recipeId) {
  const recipe = allRecipes().find(r => r.id === recipeId);
  if (!recipe) return;
  for (const ing of recipe.ingredients) {
    const need = scaledQty(ing.qty, state.persons);
    const item = state.inventory.find(i => i.key === ing.key);
    if (item) {
      item.qty -= need;
      if (item.qty <= 0) state.inventory = state.inventory.filter(i => i !== item);
    }
  }
  state.history.push({ recipeId, date: todayStr(), persons: state.persons });
  save();
}

/* ================= 视图渲染 ================= */
const view = document.getElementById('view');
const overlay = document.getElementById('overlay');
let currentTab = 'inventory';

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    render();
  });
});

function render() {
  if (currentTab === 'inventory') renderInventory();
  else if (currentTab === 'recommend') renderRecommend();
  else if (currentTab === 'library') renderLibrary();
  else if (currentTab === 'add') renderAdd();
  else renderPlan();
}

/* ---------- 食材页 ---------- */
function renderInventory(askTranslateFor) {
  const grid = INGREDIENT_PRESETS.filter(p => !p.seasoning).map(p => {
    const qty = stockQty(p.key);
    return `<div class="preset-item" data-key="${p.key}">
      <span class="emoji">${p.emoji}</span>
      <span class="zh">${p.nameZh}</span>
      <span class="id">${p.nameId}</span>
      ${qty > 0 ? `<span class="badge">×${qty}</span>` : ''}
    </div>`;
  }).join('') + (state.customIngs || []).map(c => {
    const qty = stockQty(c.key);
    return `<div class="preset-item custom" data-key="${c.key}">
      <span class="del-custom" data-del="${c.key}" title="删除这个食材">×</span>
      <span class="emoji">${customEmoji(c.customName)}</span>
      <span class="zh">${escapeHtml(c.customName)}</span>
      <span class="id">${escapeHtml(c.nameId || '')}</span>
      ${qty > 0 ? `<span class="badge">×${qty}</span>` : ''}
    </div>`;
  }).join('');

  const rows = state.inventory.map(item => {
    const p = presetOf(item.key);
    const emoji = p ? p.emoji : customEmoji(item.customName || item.key);
    const zh = p ? p.nameZh : (item.customName || item.key);
    const id = p ? p.nameId : (item.nameId || '');
    return `<div class="stock-row">
      <span class="emoji">${emoji}</span>
      <div class="names">
        <div class="zh">${escapeHtml(zh)}</div>
        ${id ? `<div class="id">${escapeHtml(id)}</div>` : '<div class="id" style="color:var(--warn)">⚠ 没有印尼语名</div>'}
        <div class="date">入库 ${fmtDate(item.addedAt)}</div>
      </div>
      <div class="stepper">
        <button data-act="dec" data-key="${item.key}">−</button>
        <span class="qty">${item.qty}</span>
        <button data-act="inc" data-key="${item.key}">+</button>
        <button data-act="del" data-key="${item.key}" style="border-color:#c9c2ba;color:#8a837b">🗑</button>
      </div>
    </div>`;
  }).join('');

  const customArea = askTranslateFor
    ? `<div class="custom-add" style="flex-wrap:wrap">
        <div style="width:100%;font-size:.85rem;color:var(--warn)">「${escapeHtml(askTranslateFor)}」词典里没有，请补一下印尼语名称（女佣只看印尼语）：</div>
        <input id="customIdName" placeholder="印尼语名称，如 selada">
        <button class="btn secondary" id="customConfirmBtn">确定</button>
        <button class="btn secondary" id="customSkipBtn">跳过</button>
      </div>`
    : `<div class="custom-add">
        <input id="customName" placeholder="其他食材，输入中文（如：生菜）">
        <button class="btn secondary" id="customAddBtn">添加</button>
      </div>`;

  view.innerHTML = `
    <div class="section-title">点击加入库存（点一下 +1）</div>
    <div class="preset-grid">${grid}</div>
    <div class="section-title">当前库存（共 ${state.inventory.length} 种）</div>
    <div class="card">
      ${rows || '<div class="empty-tip">库存是空的，先点上面的食材录入本周采购吧</div>'}
      ${customArea}
    </div>
    <div class="always-have">默认常备：${ALWAYS_HAVE.map(a => a.nameZh).join('、')}（不用录入）</div>
    <div class="card" style="margin-top:14px">
      <div class="section-title" style="margin-top:0">☁️ 家庭云同步（多台手机共享库存）</div>
      <div class="custom-add">
        <input id="syncFamily" placeholder="家庭密码（如 zhang-jia-2026）" value="${escapeHtml((state.sync && state.sync.family) || '')}">
        <button class="btn secondary" id="syncSaveBtn">保存并同步</button>
      </div>
      <div class="always-have" id="syncStatus">${syncEnabled() ? '已设置，打开 App 自动同步' : '未设置：每台手机数据各自独立'}</div>
    </div>
  `;

  view.querySelectorAll('.preset-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('del-custom')) return; // 点的是删除角标
      const key = el.dataset.key;
      const c = (state.customIngs || []).find(x => x.key === key);
      if (c) addStock(key, c.customName, c.nameId);
      else addStock(key);
      renderInventory();
    });
  });
  /* 自定义食材图标的删除角标：连图标带库存一起删 */
  view.querySelectorAll('.del-custom').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = el.dataset.del;
      const c = (state.customIngs || []).find(x => x.key === key);
      if (confirm(`把「${c ? c.customName : key}」从快捷图标里删除？（库存里的也会一起删）`)) {
        state.customIngs = state.customIngs.filter(x => x.key !== key);
        state.inventory = state.inventory.filter(i => i.key !== key);
        save();
        renderInventory();
      }
    });
  });
  view.querySelectorAll('.stepper button').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (btn.dataset.act === 'del') {
        const item = state.inventory.find(i => i.key === key);
        const p = presetOf(key);
        const name = p ? p.nameZh : (item && item.customName) || key;
        if (confirm(`把「${name}」从库存里移除？`)) { removeStock(key); renderInventory(); }
      } else {
        changeQty(key, btn.dataset.act === 'inc' ? 1 : -1);
        renderInventory();
      }
    });
  });

  if (askTranslateFor) {
    document.getElementById('customConfirmBtn').addEventListener('click', () => {
      const idName = document.getElementById('customIdName').value.trim();
      if (!idName) return;
      addStock('custom:' + askTranslateFor, askTranslateFor, idName);
      renderInventory();
    });
    document.getElementById('customSkipBtn').addEventListener('click', () => {
      addStock('custom:' + askTranslateFor, askTranslateFor, null);
      renderInventory();
    });
  } else {
    document.getElementById('customAddBtn').addEventListener('click', () => {
      const name = document.getElementById('customName').value.trim();
      if (!name) return;
      const hit = lookupCustom(name);
      if (hit && hit.presetKey) {
        addStock(hit.presetKey);
        renderInventory();
      } else if (hit) {
        addStock('custom:' + name, name, hit.nameId);
        renderInventory();
      } else {
        renderInventory(name); // 词典没有 → 请用户补印尼语
      }
    });
  }

  /* ---- 云同步设置 ---- */
  document.getElementById('syncSaveBtn').addEventListener('click', async () => {
    const family = document.getElementById('syncFamily').value.trim();
    if (!/^[a-zA-Z0-9_-]{4,32}$/.test(family)) {
      alert('家庭密码要 4~32 位字母/数字（如 zhang-jia-2026）\n每台手机填同一个密码，就能看到同一份数据');
      return;
    }
    // 注意：不能先 save()——save 会把 updatedAt 刷成当前时间，
    // 导致新设备的空数据被判为“最新”而覆盖云端（太太手机清空库存的 bug）
    state.sync = { family };
    setSyncStatus('正在同步…');
    await syncPull(); // 先拉：云端较新则先采用云端数据（新设备首次同步拿到库存）
    save();           // 再存本地；若本地确实较新，防抖推送至云端
    renderInventory();
  });
}

/* ---------- 推荐页 ---------- */
function renderRecommend() {
  const { feasible, nearMiss } = recommend();
  const top = feasible.slice(0, 3);
  const rest = feasible.slice(3);

  const dishCard = (item, tagHtml) => {
    const r = item.recipe;
    return `<div class="dish-card" data-id="${r.id}">
      <span class="emoji">${r.emoji}</span>
      <div class="info">
        <div class="zh">${r.nameZh}</div>
        <div class="id">${r.nameId}</div>
        <div class="meta">⏱ ${r.timeMin} 分钟 · ${'⭐'.repeat(r.difficulty)} 简单</div>
      </div>
      ${tagHtml || '<span class="tag ok">食材齐全</span>'}
    </div>`;
  };

  view.innerHTML = `
    <div class="persons-bar">
      <span class="label">🍽️ 今天吃饭人数</span>
      <div class="stepper">
        <button id="pDec">−</button>
        <span class="qty">${state.persons}</span>
        <button id="pInc">+</button>
      </div>
    </div>
    <div class="diet-bar">
      <span class="label">🥗 不吃的荤菜（点一下切换）</span>
      <div class="diet-chips">
        ${DIET_OPTS.map(o => `<button class="diet-chip ${dietAllowed(o.id) ? '' : 'off'}" data-diet="${o.id}">${o.zh}${dietAllowed(o.id) ? '' : ' ✕'}</button>`).join('')}
      </div>
    </div>
    <div class="section-title">今日推荐（最近7天做过的不会出现）</div>
    ${top.length
      ? top.map(item => dishCard(item)).join('')
      : '<div class="empty-tip">现有食材做不出完整的菜 😅<br>先去「食材」页录入采购，或看看下面缺什么</div>'}
    ${rest.length ? '<div class="section-title">也能做</div>' + rest.map(item => dishCard(item)).join('') : ''}
    ${nearMiss.length
      ? '<div class="section-title">差一点食材就能做</div>' + nearMiss.slice(0, 4).map(item => {
          const lack = item.missing.map(m => `${m.nameZh} 差${m.need - m.have}个`).join('，');
          return dishCard(item, `<span class="tag warn">${escapeHtml(lack)}</span>`);
        }).join('')
      : ''}
  `;

  document.getElementById('pDec').addEventListener('click', () => {
    if (state.persons > 1) { state.persons--; save(); renderRecommend(); }
  });
  document.getElementById('pInc').addEventListener('click', () => {
    if (state.persons < 8) { state.persons++; save(); renderRecommend(); }
  });
  view.querySelectorAll('.diet-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.diet;
      state.diet[id] = !dietAllowed(id);
      save();
      renderRecommend();
    });
  });
  view.querySelectorAll('.dish-card').forEach(el => {
    el.addEventListener('click', () => openRecipe(el.dataset.id));
  });
}

/* ---------- 菜谱覆盖层 ---------- */
function openRecipe(recipeId) {
  const r = allRecipes().find(x => x.id === recipeId);
  if (!r) return;
  const persons = state.persons;

  const ings = r.ingredients.map(ing => {
    const p = presetOf(ing.key);
    const qty = scaledQty(ing.qty, persons);
    return `<li>${p ? p.emoji : ''} ${formatQtyId(ing.key, qty)}<span style="color:var(--muted);font-size:.78rem">（${p ? p.nameZh : ing.key}）</span></li>`;
  }).join('');

  const steps = r.steps.map((s, i) =>
    `<li><span class="num">${i + 1}</span><span>${s.emoji} ${renderStepId(r, s, persons)}${s.textZh ? `<div class="step-zh">${renderStepZh(r, s, persons)}</div>` : ''}</span></li>`
  ).join('');

  overlay.innerHTML = `
    <div class="sheet">
      <button class="close" id="closeSheet">✕</button>
      <h2>${r.emoji} ${r.nameZh}</h2>
      <div class="name-id">${r.nameId} · ${persons} orang · ⏱ ${r.timeMin} menit</div>
      <h3>Bahan-bahan 食材</h3>
      <ul class="ing-list">${ings}</ul>
      <div class="always-have">另有常备：${ALWAYS_HAVE.map(a => a.nameId).join(', ')}</div>
      <h3>Cara Memasak 步骤</h3>
      <ul class="step-list">${steps}</ul>
      ${r.tipId ? `<div class="tip-box">💡 ${r.tipId}${r.tipZh ? `<div class="step-zh">${r.tipZh}</div>` : ''}</div>` : ''}
      <button class="btn block" id="shareImgBtn">📤 生成图片，发送到 WhatsApp</button>
      <button class="btn block secondary" id="copyTextBtn">📋 复制印尼语文字</button>
      <button class="btn block secondary" id="waTextBtn">💬 发送文字到 WhatsApp</button>
      <button class="btn block secondary" id="cookedBtn">✅ 标记已做（自动扣减库存）</button>
    </div>
  `;
  overlay.classList.remove('hidden');

  document.getElementById('closeSheet').addEventListener('click', closeOverlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });
  document.getElementById('shareImgBtn').addEventListener('click', () => shareRecipeImage(r, persons));
  document.getElementById('copyTextBtn').addEventListener('click', async (e) => {
    const ok = await copyText(buildRecipeText(r, persons));
    e.target.textContent = ok ? '✅ 已复制，去 WhatsApp 粘贴吧' : '❌ 复制失败，请用"发送文字"按钮';
    setTimeout(() => { e.target.textContent = '📋 复制印尼语文字'; }, 2000);
  });
  document.getElementById('waTextBtn').addEventListener('click', () => {
    window.open('https://wa.me/?text=' + encodeURIComponent(buildRecipeText(r, persons)), '_blank');
  });
  document.getElementById('cookedBtn').addEventListener('click', () => {
    if (!confirm(`确认已做「${r.nameZh}」？将按 ${persons} 人份用量扣减库存`)) return;
    markCooked(r.id);
    closeOverlay();
    render();
  });
}

function closeOverlay() {
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
}

/* ================= 阶段3：长图生成 + WhatsApp 分享 ================= */
function buildRecipeText(r, persons) {
  const lines = [];
  lines.push(`${r.emoji} *${r.nameId}*`);
  lines.push(`Untuk ${persons} orang · ±${r.timeMin} menit`);
  lines.push('');
  lines.push('*Bahan-bahan:*');
  for (const ing of r.ingredients) {
    lines.push(`• ${formatQtyId(ing.key, scaledQty(ing.qty, persons))}`);
  }
  lines.push('');
  lines.push(`_Bumbu di rumah: ${ALWAYS_HAVE.map(a => a.nameId).join(', ')}_`);
  lines.push('');
  lines.push('*Cara memasak:*');
  r.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.emoji} ${renderStepId(r, s, persons)}`));
  if (r.tipId) {
    lines.push('');
    lines.push(`💡 ${r.tipId}`);
  }
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* 忽略 */ }
    document.body.removeChild(ta);
    return ok;
  }
}

const IMG_FONT = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let cur = '';
  for (const w of String(text).split(' ')) {
    if (ctx.measureText(w).width > maxWidth) {
      // 单个"词"超宽（如无空格的中文）→ 按字符断行
      if (cur) { lines.push(cur); cur = ''; }
      for (const ch of w) {
        if (ctx.measureText(cur + ch).width <= maxWidth || !cur) cur += ch;
        else { lines.push(cur); cur = ch; }
      }
    } else {
      const trial = cur ? cur + ' ' + w : w;
      if (ctx.measureText(trial).width <= maxWidth || !cur) cur = trial;
      else { lines.push(cur); cur = w; }
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* 两遍绘制：先排版算出总高度，再真正画到画布上 */
function drawRecipeImage(r, persons) {
  const W = 800, PAD = 48, TEXT_W = W - PAD * 2;
  const meas = document.createElement('canvas').getContext('2d');
  const ops = [];
  let y = 0;

  // 头部
  const headerH = 190;
  ops.push({ t: 'rect', x: 0, y: 0, w: W, h: headerH, color: '#e2552f' });
  ops.push({ t: 'text', x: PAD, y: 95, text: r.emoji, font: `72px ${IMG_FONT}`, color: '#fff' });
  ops.push({ t: 'text', x: PAD + 104, y: 82, text: r.nameId, font: `bold 44px ${IMG_FONT}`, color: '#fff' });
  ops.push({ t: 'text', x: PAD + 104, y: 128, text: `${r.nameZh} · ${persons} orang · ±${r.timeMin} menit`, font: `26px ${IMG_FONT}`, color: 'rgba(255,255,255,0.88)' });
  y = headerH + 46;

  // 食材区
  ops.push({ t: 'text', x: PAD, y, text: 'Bahan-bahan', font: `bold 34px ${IMG_FONT}`, color: '#c74322' });
  y += 14;
  ops.push({ t: 'rect', x: PAD, y, w: 120, h: 4, color: '#c74322' });
  y += 40;
  meas.font = `28px ${IMG_FONT}`;
  for (const ing of r.ingredients) {
    const p = presetOf(ing.key);
    const main = `${p ? p.emoji : '📦'}  ${formatQtyId(ing.key, scaledQty(ing.qty, persons))}`;
    ops.push({ t: 'text', x: PAD, y, text: main, font: meas.font, color: '#33302c' });
    if (p) {
      const wMain = meas.measureText(main).width;
      ops.push({ t: 'text', x: PAD + wMain + 14, y, text: p.nameZh, font: `22px ${IMG_FONT}`, color: '#8a837b' });
    }
    y += 44;
  }
  meas.font = `22px ${IMG_FONT}`;
  for (const line of wrapLines(meas, `Bumbu di rumah: ${ALWAYS_HAVE.map(a => a.nameId).join(', ')}`, TEXT_W)) {
    ops.push({ t: 'text', x: PAD, y, text: line, font: meas.font, color: '#8a837b' });
    y += 32;
  }
  y += 28;

  // 步骤区
  ops.push({ t: 'text', x: PAD, y, text: 'Cara Memasak', font: `bold 34px ${IMG_FONT}`, color: '#c74322' });
  y += 14;
  ops.push({ t: 'rect', x: PAD, y, w: 120, h: 4, color: '#c74322' });
  y += 44;
  r.steps.forEach((s, i) => {
    meas.font = `28px ${IMG_FONT}`;
    const lines = wrapLines(meas, `${s.emoji} ${renderStepId(r, s, persons)}`, TEXT_W - 56);
    ops.push({ t: 'badge', x: PAD, cy: y - 10, num: String(i + 1) });
    lines.forEach((line, li) => {
      ops.push({ t: 'text', x: PAD + 56, y: y + li * 40, text: line, font: meas.font, color: '#33302c' });
    });
    y += lines.length * 40;
    if (s.textZh) {
      meas.font = `22px ${IMG_FONT}`;
      const zhLines = wrapLines(meas, renderStepZh(r, s, persons), TEXT_W - 56);
      zhLines.forEach((line, li) => {
        ops.push({ t: 'text', x: PAD + 56, y: y + li * 30, text: line, font: meas.font, color: '#8a837b' });
      });
      y += zhLines.length * 30;
    }
    y += 16;
  });
  y += 12;

  // 提示框（无小贴士则跳过）
  if (r.tipId) {
    meas.font = `24px ${IMG_FONT}`;
    const tipLines = wrapLines(meas, `💡 ${r.tipId}`, TEXT_W - 32);
    meas.font = `20px ${IMG_FONT}`;
    const zhTipLines = r.tipZh ? wrapLines(meas, r.tipZh, TEXT_W - 32) : [];
    const tipH = tipLines.length * 34 + zhTipLines.length * 28 + 30;
    ops.push({ t: 'rrect', x: PAD, y, w: TEXT_W, h: tipH, color: '#fbf0da', radius: 14 });
    tipLines.forEach((line, li) => {
      ops.push({ t: 'text', x: PAD + 16, y: y + 40 + li * 34, text: line, font: `24px ${IMG_FONT}`, color: '#7a5a13' });
    });
    zhTipLines.forEach((line, li) => {
      ops.push({ t: 'text', x: PAD + 16, y: y + 40 + tipLines.length * 34 + li * 28, text: line, font: `20px ${IMG_FONT}`, color: '#b39b6b' });
    });
    y += tipH + 40;
  }

  // 页脚
  ops.push({ t: 'text', x: W / 2, y, text: 'Selamat memasak! 🍜  Smart Helper', font: `22px ${IMG_FONT}`, color: '#8a837b', align: 'center' });
  y += 28;

  // 绘制
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = y;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fdf6f0';
  ctx.fillRect(0, 0, W, y);

  for (const op of ops) {
    if (op.t === 'rect') {
      ctx.fillStyle = op.color;
      ctx.fillRect(op.x, op.y, op.w, op.h);
    } else if (op.t === 'rrect') {
      roundRectPath(ctx, op.x, op.y, op.w, op.h, op.radius);
      ctx.fillStyle = op.color;
      ctx.fill();
    } else if (op.t === 'text') {
      ctx.font = op.font;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align || 'left';
      ctx.fillText(op.text, op.x, op.y);
      ctx.textAlign = 'left';
    } else if (op.t === 'badge') {
      ctx.fillStyle = '#e2552f';
      ctx.beginPath();
      ctx.arc(op.x + 18, op.cy, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold 22px ${IMG_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(op.num, op.x + 18, op.cy + 8);
      ctx.textAlign = 'left';
    }
  }
  return canvas;
}

async function shareRecipeImage(r, persons) {
  const btn = document.getElementById('shareImgBtn');
  const orig = btn.textContent;
  btn.textContent = '⏳ 正在生成图片…';
  try {
    const canvas = drawRecipeImage(r, persons);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const file = new File([blob], `${r.id}-${persons}orang.png`, { type: 'image/png' });
    // 安卓 Chrome 等支持直接分享到 WhatsApp
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: r.nameId });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // 用户取消分享
      }
    }
    // 不支持直接分享（如 iPhone Safari）→ 下载图片，提示手动发送
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    alert('图片已生成并保存 ✅\n请打开 WhatsApp，把这张图片发给女佣。');
  } finally {
    btn.textContent = orig;
  }
}

/* ================= 菜谱库：浏览 + 按食材/名称搜索 ================= */
let libQuery = '';
let libIngKey = 'all';

function filterLibrary() {
  const q = libQuery.trim().toLowerCase();

  return allRecipes().filter(r => {
    if (libIngKey !== 'all' && !r.ingredients.some(i => i.key === libIngKey)) return false;
    if (!q) return true;
    if (r.nameZh.toLowerCase().includes(q) || r.nameId.toLowerCase().includes(q)) return true;
    // 食材名也能搜（中文/印尼语/自定义食材名）
    return r.ingredients.some(i => {
      const p = presetOf(i.key);
      const zh = p ? p.nameZh : i.key;
      const id = p ? p.nameId : '';
      return zh.toLowerCase().includes(q) || id.toLowerCase().includes(q);
    });
  });
}

function libraryCards(matched) {
  return matched.map(r => {
    const ings = r.ingredients.map(i => {
      const p = presetOf(i.key);
      return (p ? p.emoji : '📦') + (p ? p.nameZh : i.key);
    }).join(' ');
    const isCustom = r.id.startsWith('custom-');
    return `<div class="dish-card" data-id="${r.id}">
      <span class="emoji">${r.emoji}</span>
      <div class="info">
        <div class="zh">${escapeHtml(r.nameZh)}${isCustom ? ' <span class="tag warn">自定义</span>' : ''}</div>
        <div class="id">${escapeHtml(r.nameId)}</div>
        <div class="meta">⏱ ${r.timeMin} 分钟 · ${ings}</div>
      </div>
    </div>`;
  }).join('');
}

/* 只刷新结果列表：输入框不动，中文输入法的拼音组合不会被打断 */
function updateLibraryResults() {
  const res = document.getElementById('libResults');
  const cnt = document.getElementById('libCount');
  if (!res || !cnt) return;
  const matched = filterLibrary();
  cnt.textContent = `共 ${matched.length} 道`;
  res.innerHTML = libraryCards(matched) ||
    `<div class="empty-tip">库里没有找到相关菜谱 😅<br><br><button class="btn" id="goAddBtn">➕ 去「加菜」自己加一道</button></div>`;
  const goAdd = document.getElementById('goAddBtn');
  if (goAdd) {
    goAdd.addEventListener('click', () => {
      currentTab = 'add';
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'add'));
      render();
    });
  }
  res.querySelectorAll('.dish-card[data-id]').forEach(el => {
    el.addEventListener('click', () => openRecipe(el.dataset.id));
  });
}

function renderLibrary() {
  const matched = filterLibrary();

  view.innerHTML = `
    <div class="card">
      <div class="form-row">
        <input type="text" id="libSearch" placeholder="🔍 搜菜名或食材（如：虾 / udang / 番茄）" value="${escapeHtml(libQuery)}">
      </div>
      <div class="form-row" style="margin-bottom:0">
        <select id="libIng">
          <option value="all">全部食材</option>
          ${INGREDIENT_PRESETS.map(p => `<option value="${p.key}" ${p.key === libIngKey ? 'selected' : ''}>${p.emoji} 用「${p.nameZh}」做的菜</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="section-title" id="libCount">共 ${matched.length} 道</div>
    <div id="libResults">${libraryCards(matched) ||
      `<div class="empty-tip">库里没有找到相关菜谱 😅<br><br><button class="btn" id="goAddBtn">➕ 去「加菜」自己加一道</button></div>`}</div>
  `;

  document.getElementById('libSearch').addEventListener('input', e => {
    libQuery = e.target.value;
    updateLibraryResults(); // 只更新结果区，不重绘输入框
  });
  document.getElementById('libIng').addEventListener('change', e => {
    libIngKey = e.target.value;
    updateLibraryResults();
  });
  const goAdd = document.getElementById('goAddBtn');
  if (goAdd) {
    goAdd.addEventListener('click', () => {
      currentTab = 'add';
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'add'));
      render();
    });
  }
  view.querySelectorAll('.dish-card[data-id]').forEach(el => {
    el.addEventListener('click', () => openRecipe(el.dataset.id));
  });
}

/* ================= 加菜：自定义菜谱（模板搭积木，自动生成双语步骤） ================= */
const HEAT_OPTS = [
  { id: 'besar',  zh: '大火' },
  { id: 'sedang', zh: '中火' },
  { id: 'kecil',  zh: '小火' },
];
const SPOON_OPTS = [
  { id: 'sendok makan', zh: '饭勺' },
  { id: 'sendok teh',   zh: '茶勺' },
];
const CATEGORY_OPTS = [
  { id: 'chicken', zh: '鸡肉' }, { id: 'pork', zh: '猪肉' }, { id: 'beef', zh: '牛肉' },
  { id: 'fish', zh: '鱼/海鲜' }, { id: 'shrimp', zh: '虾' }, { id: 'egg', zh: '蛋' },
  { id: 'tofu', zh: '豆腐' }, { id: 'veg', zh: '蔬菜' }, { id: 'soup', zh: '汤' },
];
const EMOJI_OPTS = ['🍽️', '🍲', '🍳', '🐟', '🦐', '🦑', '🍗', '🥩', '🥬', '🥚', '🫘', '🍜', '🍚', '🌶️'];

function ingNameZh(key) { const p = presetOf(key); return p ? p.nameZh : key; }
function heatZh(id) { const h = HEAT_OPTS.find(x => x.id === id); return h ? h.zh : id; }
function spoonZh(id) { const s = SPOON_OPTS.find(x => x.id === id); return s ? s.zh : id; }

/* 参数类型：ing=草稿中的食材, num:X=数字输入(标签X), heat=火候, spoon=勺型, bumbu=常备调料 */
const STEP_TEMPLATES = [
  { id: 'wash',       label: '💧 洗食材',   emoji: '💧', params: ['ing'],
    makeId: p => `Cuci {${p.ing}}.`,
    makeZh: p => `${ingNameZh(p.ing)}洗净。` },
  { id: 'cut',        label: '🔪 切食材',   emoji: '🔪', params: ['ing'],
    makeId: p => `Potong {${p.ing}}.`,
    makeZh: p => `${ingNameZh(p.ing)}切好备用。` },
  { id: 'boil-water', label: '💧 烧水',     emoji: '💧', params: ['num:水（碗）'],
    makeId: p => `Didihkan ${p.num} mangkuk air.`,
    makeZh: p => `烧${p.num}碗水。` },
  { id: 'heat-oil',   label: '🔥 热锅倒油', emoji: '🔥', params: ['num:油（饭勺）'],
    makeId: p => `Panaskan wajan. Tuang ${p.num} sendok makan minyak.`,
    makeZh: p => `热锅，倒${p.num}饭勺油。` },
  { id: 'add-ing',    label: '🍳 下食材',   emoji: '🍳', params: ['ing'],
    makeId: p => `Masukkan {${p.ing}}.`,
    makeZh: p => `放入${ingNameZh(p.ing)}。` },
  { id: 'stir',       label: '🥄 翻炒',     emoji: '🥄', params: ['num:翻炒（分钟）'],
    makeId: p => `Aduk ${p.num} menit.`,
    makeZh: p => `翻炒${p.num}分钟。` },
  { id: 'cook',       label: '⏲️ 煮/烧',    emoji: '⏲️', params: ['heat', 'num:时间（分钟）'],
    makeId: p => `Masak ${p.num} menit dengan api ${p.heat}.`,
    makeZh: p => `${heatZh(p.heat)}煮${p.num}分钟。` },
  { id: 'steam',      label: '♨️ 蒸',       emoji: '♨️', params: ['ing', 'num:时间（分钟）'],
    makeId: p => `Kukus {${p.ing}} ${p.num} menit.`,
    makeZh: p => `${ingNameZh(p.ing)}蒸${p.num}分钟。` },
  { id: 'fry',        label: '🍳 煎',       emoji: '🍳', params: ['ing', 'num:时间（分钟）'],
    makeId: p => `Goreng {${p.ing}} ${p.num} menit dengan api sedang.`,
    makeZh: p => `${ingNameZh(p.ing)}中火煎${p.num}分钟。` },
  { id: 'boil-ing',   label: '🍲 煮食材',   emoji: '🍲', params: ['ing', 'num:时间（分钟）'],
    makeId: p => `Rebus {${p.ing}} ${p.num} menit.`,
    makeZh: p => `${ingNameZh(p.ing)}煮${p.num}分钟。` },
  { id: 'season',     label: '🧂 加调料',   emoji: '🧂', params: ['num:用量', 'spoon', 'bumbu'],
    makeId: p => `Tambah ${p.num} ${p.spoon} ${ALWAYS_HAVE[p.bumbu].nameId}.`,
    makeZh: p => `加${p.num}${spoonZh(p.spoon)}${ALWAYS_HAVE[p.bumbu].nameZh}。` },
  { id: 'simmer',     label: '🍲 盖盖焖',   emoji: '🍲', params: ['num:时间（分钟）'],
    makeId: p => `Tutup wajan. Masak ${p.num} menit dengan api kecil.`,
    makeZh: p => `盖上锅盖，小火焖${p.num}分钟。` },
  { id: 'garnish',    label: '🌿 撒配料',   emoji: '🌿', params: ['ing'],
    makeId: p => `Taburi {${p.ing}}.`,
    makeZh: p => `撒上${ingNameZh(p.ing)}。` },
  { id: 'serve',      label: '🍽️ 盛出上桌', emoji: '🍽️', params: [],
    makeId: () => 'Matikan api. Angkat. Sajikan.',
    makeZh: () => '关火，盛出上桌。' },
];

let addDraft = null;

function freshDraft() {
  return { nameZh: '', nameId: '', emoji: '🍽️', category: 'veg', timeMin: 15, ingredients: [], steps: [], tipZh: '', tipId: '' };
}

function renderAdd() {
  if (!addDraft) addDraft = freshDraft();
  const d = addDraft;

  const presetOptions = selected =>
    INGREDIENT_PRESETS.map(p => `<option value="${p.key}" ${p.key === selected ? 'selected' : ''}>${p.emoji} ${p.nameZh} ${p.nameId}</option>`).join('');

  const ingRows = d.ingredients.map((ing, i) => `
    <div class="form-inline" style="margin-bottom:8px">
      <select data-ing-key="${i}">${presetOptions(ing.key)}</select>
      <input type="number" min="1" max="20" value="${ing.qty}" data-ing-qty="${i}" style="flex:0 0 76px">
      <button class="mini-btn shrink" data-ing-del="${i}">✕</button>
    </div>`).join('');

  const stepRows = d.steps.map((s, i) => {
    const preview = renderStepId(d, s, 2);
    return `<div class="draft-step">
      <div class="body">${i + 1}. ${s.emoji} ${escapeHtml(preview)}<div class="step-zh">${escapeHtml(renderStepZh(d, s, 2))}</div></div>
      <button class="del" data-step-del="${i}">✕</button>
    </div>`;
  }).join('');

  const customList = (state.customRecipes || []).map(r => `
    <div class="dish-card" data-id="${r.id}" style="margin-bottom:8px">
      <span class="emoji">${r.emoji}</span>
      <div class="info">
        <div class="zh">${escapeHtml(r.nameZh)}</div>
        <div class="id">${escapeHtml(r.nameId)}</div>
      </div>
      <button class="mini-btn shrink" data-custom-del="${r.id}">删除</button>
    </div>`).join('');

  view.innerHTML = `
    <div class="section-title">加一道自己的菜（全程中文操作，自动生成印尼语）</div>
    <div class="card">
      <div class="form-row">
        <label>菜名（中文）</label>
        <input type="text" id="dNameZh" placeholder="如：蒜蓉粉丝蒸虾" value="${escapeHtml(d.nameZh)}">
      </div>
      <div class="form-row">
        <label>菜名（印尼语）——用谷歌翻译把中文名翻成印尼语填这里，女佣只看这个</label>
        <input type="text" id="dNameId" placeholder="如：Udang Kukus Bawang Putih" value="${escapeHtml(d.nameId)}">
      </div>
      <div class="form-inline">
        <div class="form-row">
          <label>图标</label>
          <select id="dEmoji">${EMOJI_OPTS.map(e => `<option ${e === d.emoji ? 'selected' : ''}>${e}</option>`).join('')}</select>
        </div>
        <div class="form-row">
          <label>类别</label>
          <select id="dCategory">${CATEGORY_OPTS.map(c => `<option value="${c.id}" ${c.id === d.category ? 'selected' : ''}>${c.zh}</option>`).join('')}</select>
        </div>
        <div class="form-row" style="flex:0 0 90px">
          <label>用时(分)</label>
          <input type="number" id="dTime" min="5" max="120" value="${d.timeMin}">
        </div>
      </div>
    </div>

    <div class="section-title">食材（2人份基准，系统会自动按人数缩放）</div>
    <div class="card">
      ${ingRows || '<div class="empty-tip" style="padding:10px">还没加食材</div>'}
      <button class="mini-btn" id="ingAdd">＋ 添加食材</button>
    </div>

    <div class="section-title">步骤（用模板拼，至少3步）</div>
    <div class="card">
      ${stepRows || '<div class="empty-tip" style="padding:10px">还没加步骤</div>'}
      <div class="form-row" style="margin-top:10px">
        <select id="tplSel">${STEP_TEMPLATES.map((t, i) => `<option value="${i}">${t.label}</option>`).join('')}</select>
      </div>
      <div class="form-inline" id="tplParams"></div>
      <button class="mini-btn" id="stepAdd" style="margin-top:8px">＋ 添加这一步</button>
    </div>

    <div class="section-title">小贴士（可留空）</div>
    <div class="card">
      <div class="form-row"><label>中文</label><input type="text" id="dTipZh" value="${escapeHtml(d.tipZh)}"></div>
      <div class="form-row"><label>印尼语</label><input type="text" id="dTipId" value="${escapeHtml(d.tipId)}"></div>
    </div>

    <button class="btn block" id="saveCustomBtn">💾 保存这道菜</button>

    ${customList ? '<div class="section-title">我的自定义菜谱</div>' + customList : ''}
  `;

  /* ---- 文本类输入：只更新草稿，不重渲染（避免输入中丢焦点） ---- */
  const bindText = (id, field, isNum) => {
    document.getElementById(id).addEventListener('input', e => {
      d[field] = isNum ? Math.max(1, Number(e.target.value) || 1) : e.target.value;
    });
  };
  bindText('dNameZh', 'nameZh');
  bindText('dNameId', 'nameId');
  bindText('dTipZh', 'tipZh');
  bindText('dTipId', 'tipId');
  bindText('dTime', 'timeMin', true);
  document.getElementById('dEmoji').addEventListener('change', e => { d.emoji = e.target.value; });
  document.getElementById('dCategory').addEventListener('change', e => { d.category = e.target.value; });

  /* ---- 食材行 ---- */
  document.getElementById('ingAdd').addEventListener('click', () => {
    d.ingredients.push({ key: INGREDIENT_PRESETS[0].key, qty: 2 });
    renderAdd();
  });
  view.querySelectorAll('[data-ing-key]').forEach(sel => {
    sel.addEventListener('change', () => { d.ingredients[sel.dataset.ingKey].key = sel.value; renderAdd(); });
  });
  view.querySelectorAll('[data-ing-qty]').forEach(inp => {
    inp.addEventListener('change', () => { d.ingredients[inp.dataset.ingQty].qty = Math.max(1, Number(inp.value) || 1); });
  });
  view.querySelectorAll('[data-ing-del]').forEach(btn => {
    btn.addEventListener('click', () => { d.ingredients.splice(Number(btn.dataset.ingDel), 1); renderAdd(); });
  });

  /* ---- 步骤模板参数区 ---- */
  const tplSel = document.getElementById('tplSel');
  const renderTplParams = () => {
    const t = STEP_TEMPLATES[Number(tplSel.value)];
    document.getElementById('tplParams').innerHTML = t.params.map(p => {
      if (p === 'ing') {
        return d.ingredients.length
          ? `<select data-param="ing">${d.ingredients.map(x => `<option value="${x.key}">${ingNameZh(x.key)}</option>`).join('')}</select>`
          : '<span style="font-size:.8rem;color:var(--warn)">先在上面添加食材</span>';
      }
      if (p === 'heat') return `<select data-param="heat">${HEAT_OPTS.map(h => `<option value="${h.id}">${h.zh}</option>`).join('')}</select>`;
      if (p === 'spoon') return `<select data-param="spoon">${SPOON_OPTS.map(s => `<option value="${s.id}">${s.zh}</option>`).join('')}</select>`;
      if (p === 'bumbu') return `<select data-param="bumbu">${ALWAYS_HAVE.map((b, bi) => `<option value="${bi}">${b.nameZh}</option>`).join('')}</select>`;
      const label = p.startsWith('num:') ? p.slice(4) : '数量';
      return `<input type="number" min="1" max="60" value="2" data-param="num" placeholder="${label}" title="${label}">`;
    }).join('');
  };
  tplSel.addEventListener('change', renderTplParams);
  renderTplParams();

  document.getElementById('stepAdd').addEventListener('click', () => {
    const t = STEP_TEMPLATES[Number(tplSel.value)];
    const p = {};
    for (const spec of t.params) {
      const kind = spec.startsWith('num:') ? 'num' : spec;
      const el = view.querySelector(`#tplParams [data-param="${kind}"]`);
      if (!el) { alert('请先添加食材'); return; }
      if (kind === 'num') p.num = Math.max(1, Number(el.value) || 1);
      else if (kind === 'bumbu') p.bumbu = Number(el.value);
      else p[kind] = el.value;
    }
    d.steps.push({ emoji: t.emoji, textId: t.makeId(p), textZh: t.makeZh(p) });
    renderAdd();
  });

  view.querySelectorAll('[data-step-del]').forEach(btn => {
    btn.addEventListener('click', () => { d.steps.splice(Number(btn.dataset.stepDel), 1); renderAdd(); });
  });

  /* ---- 保存 ---- */
  document.getElementById('saveCustomBtn').addEventListener('click', () => {
    if (!d.nameZh.trim()) { alert('请填写中文菜名'); return; }
    if (!d.nameId.trim()) { alert('请填写印尼语菜名（女佣只看印尼语）\n可以用谷歌翻译把中文名翻过去'); return; }
    if (d.ingredients.length < 1) { alert('至少添加1种食材'); return; }
    if (d.steps.length < 3) { alert('至少添加3个步骤'); return; }
    state.customRecipes.push({
      id: 'custom-' + Date.now(),
      nameZh: d.nameZh.trim(),
      nameId: d.nameId.trim(),
      emoji: d.emoji,
      category: d.category,
      timeMin: d.timeMin,
      difficulty: 1,
      ingredients: d.ingredients.map(x => ({ key: x.key, qty: x.qty })),
      steps: d.steps,
      tipId: d.tipId.trim(),
      tipZh: d.tipZh.trim(),
    });
    save();
    addDraft = null;
    alert('已保存 ✅\n这道菜现在会出现在推荐和本周菜单里');
    renderAdd();
  });

  /* ---- 自定义菜谱列表 ---- */
  view.querySelectorAll('[data-custom-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const r = (state.customRecipes || []).find(x => x.id === btn.dataset.customDel);
      if (r && confirm(`删除「${r.nameZh}」？`)) {
        state.customRecipes = state.customRecipes.filter(x => x.id !== r.id);
        save();
        renderAdd();
      }
    });
  });
  view.querySelectorAll('.dish-card[data-id]').forEach(el => {
    el.addEventListener('click', () => openRecipe(el.dataset.id));
  });
}

/* ================= 阶段4：本周菜单 ================= */
const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];

function datePlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function fmtPlanDate(d, index) {
  const md = (d.getMonth() + 1) + '/' + d.getDate();
  if (index === 0) return '今天 ' + md;
  if (index === 1) return '明天 ' + md;
  return '周' + WEEKDAYS_ZH[d.getDay()] + ' ' + md;
}

/* 生成7天菜单：每天2~3道（必有鱼虾 + 优先一汤），全周不重样，模拟逐日扣库存保证整周可行 */
function generatePlan() {
  const vStock = {};
  for (const item of state.inventory) vStock[item.key] = item.qty;

  const cookedRecent = recentCookedIds(7);
  const usedThisWeek = new Set();
  let prevCats = yesterdayCategory() ? [yesterdayCategory()] : [];
  const days = [];

  const pickBest = (filterFn) => {
    let best = null;
    let bestScore = -Infinity;
    for (const recipe of allRecipes()) {
      if (cookedRecent.includes(recipe.id)) continue;
      if (usedThisWeek.has(recipe.id)) continue;
      if (!dietAllowed(recipe.category)) continue;
      if (!filterFn(recipe)) continue;

      let feasible = true;
      let oldestTs = 0;
      for (const ing of recipe.ingredients) {
        if (isSoft(ing.key)) continue; // 葱姜蒜不作为可行性门槛
        const need = scaledQty(ing.qty, state.persons);
        if ((vStock[ing.key] || 0) < need) { feasible = false; break; }
        const item = state.inventory.find(x => x.key === ing.key);
        if (item && (oldestTs === 0 || item.addedAt < oldestTs)) oldestTs = item.addedAt;
      }
      if (!feasible) continue;

      let score = 0;
      if (oldestTs > 0) score += Math.min(500, (Date.now() - oldestTs) / 3600000);
      if (prevCats.includes(recipe.category)) score -= 150;
      score -= recipe.difficulty * 10;
      score -= recipe.timeMin;

      if (score > bestScore) { bestScore = score; best = recipe; }
    }
    return best;
  };

  const take = (recipe) => {
    usedThisWeek.add(recipe.id);
    for (const ing of recipe.ingredients) {
      const need = scaledQty(ing.qty, state.persons);
      vStock[ing.key] = isSoft(ing.key)
        ? Math.max(0, (vStock[ing.key] || 0) - need) // 辅料扣到0为止
        : (vStock[ing.key] || 0) - need;
    }
  };

  for (let i = 0; i < 7; i++) {
    const meal = [];
    // 第1道：必须有鱼或虾（库存允许时）
    const seafood = pickBest(r => r.category === 'fish' || r.category === 'shrimp');
    if (seafood) { meal.push(seafood); take(seafood); }
    // 第2道：非汤类，且不与当天已选同类别
    const second = pickBest(r => r.category !== 'soup' && !meal.some(m => m.category === r.category));
    if (second) { meal.push(second); take(second); }
    // 第3道：优先汤；汤做不了则换任意不同类别的菜
    let third = pickBest(r => r.category === 'soup');
    if (!third) third = pickBest(r => !meal.some(m => m.category === r.category));
    if (third) { meal.push(third); take(third); }

    prevCats = meal.map(m => m.category);
    days.push({ date: fmtPlanDate(datePlus(i), i), recipeIds: meal.map(m => m.id) });
  }

  state.plan = { persons: state.persons, generatedAt: Date.now(), days };
  save();
}

function renderPlan() {
  const plan = state.plan;
  // 旧格式（每天一道）直接提示重新生成
  const valid = plan && plan.days.every(d => Array.isArray(d.recipeIds));

  const dayHtml = (day) => {
    if (!day.recipeIds.length) {
      return `<div class="plan-day"><div class="plan-date">${day.date}</div>
        <div class="dish-card" style="cursor:default;opacity:.65">
          <span class="emoji">🛒</span>
          <div class="info"><div class="zh">食材不够了，需要采购</div></div>
        </div></div>`;
    }
    const dishes = day.recipeIds.map(id => {
      const r = allRecipes().find(x => x.id === id);
      if (!r) return '';
      const tag = r.category === 'soup' ? '汤' : (r.category === 'fish' || r.category === 'shrimp') ? '海鲜' : '';
      return `<div class="dish-card" data-id="${r.id}" style="margin-bottom:6px">
        <span class="emoji">${r.emoji}</span>
        <div class="info">
          <div class="zh">${escapeHtml(r.nameZh)}${tag ? ` <span class="tag ok">${tag}</span>` : ''}</div>
          <div class="id">${escapeHtml(r.nameId)} · ⏱ ${r.timeMin} 分钟</div>
        </div>
      </div>`;
    }).join('');
    return `<div class="plan-day"><div class="plan-date">${day.date}</div>${dishes}</div>`;
  };

  view.innerHTML = `
    <button class="btn block" id="genPlanBtn">${valid ? '🔄 重新生成（按最新库存和人数）' : '📅 生成本周菜单'}</button>
    ${valid && plan.persons !== state.persons
      ? `<div class="tip-box" style="margin-top:12px">⚠ 菜单是按 ${plan.persons} 人生成的，现在人数是 ${state.persons} 人，建议重新生成</div>` : ''}
    ${valid
      ? `<div class="section-title">每天 2~3 道：必有鱼虾 · 优先配汤 · 全周不重样</div>` + plan.days.map(dayHtml).join('')
      : '<div class="empty-tip">点上方按钮，基于当前库存和人数<br>生成 7 天菜单（每天 2~3 道，必有鱼虾）</div>'}
  `;

  document.getElementById('genPlanBtn').addEventListener('click', () => {
    generatePlan();
    renderPlan();
  });
  view.querySelectorAll('.dish-card[data-id]').forEach(el => {
    el.addEventListener('click', () => openRecipe(el.dataset.id));
  });
}

/* ================= 云端同步（Cloudflare Worker + KV） ================= */
const SYNC_URL = 'https://smart-helper-sync.darkrekcus.workers.dev';

function syncEnabled() {
  return !!(SYNC_URL && state.sync && state.sync.family);
}

function setSyncStatus(text) {
  const el = document.getElementById('syncStatus');
  if (el) el.textContent = text;
}

function syncStatusText() {
  return '✓ 已同步 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/* 拉取：云端更新则采用云端数据 */
async function syncPull() {
  if (!syncEnabled()) return;
  try {
    const res = await fetch(SYNC_URL + '?family=' + encodeURIComponent(state.sync.family));
    const remote = await res.json();
    if (remote && typeof remote === 'object' && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
      /* 防护：本机有库存而云端是全空（典型场景：新设备首次同步把空数据推了上去），
         拒绝被覆盖，并用本机数据回推恢复云端 */
      const remoteEmpty = !Array.isArray(remote.inventory) || remote.inventory.length === 0;
      if (remoteEmpty && state.inventory.length > 0) {
        setSyncStatus('⚠ 检测到云端数据被清空，已用本机数据自动恢复');
        syncPush();
        return;
      }
      const family = state.sync.family;
      Object.assign(state, {
        inventory: Array.isArray(remote.inventory) ? remote.inventory : [],
        history: Array.isArray(remote.history) ? remote.history : [],
        persons: remote.persons >= 1 ? remote.persons : 2,
        plan: remote.plan || null,
        customRecipes: Array.isArray(remote.customRecipes) ? remote.customRecipes : [],
        customIngs: Array.isArray(remote.customIngs) ? remote.customIngs : [],
        diet: remote.diet || { chicken: true, pork: true, beef: true },
        updatedAt: remote.updatedAt,
      });
      state.sync = { family };
      const mig = migrateCustoms(state.inventory, state.customIngs); // 老数据里的自定义食材升级成预设
      state.inventory = mig.inv;
      state.customIngs = mig.customs;
      save(true);
      render();
    }
    setSyncStatus(syncStatusText());
  } catch (e) {
    setSyncStatus('⚠ 同步失败，稍后会自动重试');
  }
}

/* 推送：任何数据变动后 1.5 秒防抖上传 */
let pushTimer = null;
function syncPush() {
  if (!syncEnabled()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await fetch(SYNC_URL + '?family=' + encodeURIComponent(state.sync.family), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventory: state.inventory,
          history: state.history,
          persons: state.persons,
          plan: state.plan,
          customRecipes: state.customRecipes,
          customIngs: state.customIngs,
          diet: state.diet,
          updatedAt: state.updatedAt,
        }),
      });
      setSyncStatus(syncStatusText());
    } catch (e) {
      setSyncStatus('⚠ 同步失败，稍后会自动重试');
    }
  }, 1500);
}

/* ================= 启动 ================= */
document.querySelector('.tab[data-tab="inventory"]').classList.add('active');
render();
syncPull(); // 打开时拉一次云端
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncPull(); // 切回 App 时再拉一次
});
