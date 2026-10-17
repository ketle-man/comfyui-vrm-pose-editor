// SAM3DBody の BVH を取り込むときの設定ダイアログ(腰の移動・接地補正・足の水平化・軸の選択)。
// 選んだ値は retargetBvh / bvhTextToVrmaBuffer の opts としてそのまま渡せる形で返す。設定は localStorage に保存する。
import { makeT } from './i18n.js';

const STORAGE_KEY = 'vrmPoseEditor_bvhImport';

// 文言。en が基準(辞書に無い言語は en にフォールバック)。言語を増やすときはここにコードを足す
const STRINGS = {
    en: {
        secHips: 'Hips motion',
        hipsOn: 'Import hips movement',
        hipsOnHint: 'When off, only rotations are applied (the character stays in place)',
        axisX: 'X left/right', axisY: 'Y up/down', axisZ: 'Z depth',
        axisHint: 'Depth (Z) tends to drift in single-camera estimation. Turn it off for in-place motion.',
        secFeet: 'Feet',
        ground: 'Foot grounding',
        groundHint: 'Automatically adjusts hip height so the feet touch the floor',
        snapLabel: 'Snap-to-floor height',
        snapHint: 'Floating below this height is pressed to the floor. Use a smaller value to keep small hops.',
        flatten: 'Flatten grounded feet',
        flattenHint: 'Corrects the estimation error in foot roll (inward/outward tilt)',
        cancel: 'Cancel',
        import: 'Import',
    },
    ja: {
        secHips: '腰の移動 (Hips)',
        hipsOn: '腰の移動を取り込む',
        hipsOnHint: 'オフにすると回転のみ(その場で動く)',
        axisX: 'X 左右', axisY: 'Y 上下', axisZ: 'Z 奥行き',
        axisHint: '奥行き(Z)は単眼の推定でずれやすい。その場の動きならオフ推奨',
        secFeet: '足',
        ground: '接地補正',
        groundHint: '足が床に着くよう腰の高さを自動調整',
        snapLabel: '床に吸着する高さ',
        snapHint: 'これより低い浮きは床に押さえる。小さな跳ねを残すなら小さく',
        flatten: '接地中の足を水平にする',
        flattenHint: '足の内外の傾き(ロール)の推定誤差を補正',
        cancel: 'Cancel',
        import: 'Import',
    },
};
const DEFAULTS = { hips: true, axisX: true, axisY: true, axisZ: true, ground: true, flatten: true, snapCm: 15 };

function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { /* localStorage が使えない環境(プライベートウィンドウ等)は既定値 */ }
    return { ...DEFAULTS };
}
function saveSettings(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* 保存できなくても動作に影響しない */ }
}

function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style') e.style.cssText = v; else e.setAttribute(k, v);
    }
    if (text !== undefined) e.textContent = text;
    return e;
}

// 戻り値: Promise<null | { hipsMotion, groundFeet, flattenFeet, groundSnap }>(キャンセルは null)
// lang: 表示言語の固定(省略時は ComfyUI の言語設定から自動判定)
export function askBvhImportOptions(fileName = '', lang) {
    return new Promise(resolve => {
        const t = makeT(STRINGS, lang);
        const s = loadSettings();
        const dlg = el('div', {
            style: 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100002;display:flex;align-items:center;justify-content:center;',
        });
        const box = el('div', {
            style: 'background:#1e1e3a;border-radius:8px;padding:16px;width:330px;box-shadow:0 6px 24px rgba(0,0,0,0.7);' +
                   'font-family:sans-serif;color:#ccc;font-size:12px;',
        });
        box.appendChild(el('div', { style: 'font-size:13px;font-weight:bold;color:#e0e0ff;margin-bottom:4px;' }, '⬇ Import BVH (SAM3DBody)'));
        if (fileName) box.appendChild(el('div', { style: 'color:#889;margin-bottom:10px;word-break:break-all;' }, fileName));

        const checks = {};
        const mkCheck = (key, label, hint, indent = 0) => {
            const row = el('label', { style: `display:flex;align-items:flex-start;gap:6px;margin:5px 0 5px ${indent}px;cursor:pointer;` });
            const cb = el('input', { type: 'checkbox' });
            cb.checked = !!s[key];
            checks[key] = cb;
            const col = el('div');
            col.appendChild(el('div', { style: 'color:#ddd;' }, label));
            if (hint) col.appendChild(el('div', { style: 'color:#889;font-size:11px;margin-top:1px;' }, hint));
            row.append(cb, col);
            box.appendChild(row);
            return row;
        };
        const heading = (t) => box.appendChild(el('div', { style: 'color:#9ab;font-size:11px;font-weight:bold;margin:10px 0 2px;border-bottom:1px solid #334;padding-bottom:2px;' }, t));

        heading(t('secHips'));
        mkCheck('hips', t('hipsOn'), t('hipsOnHint'));
        const axisRow = el('div', { style: 'display:flex;gap:12px;margin:2px 0 2px 22px;' });
        for (const [key, label] of [['axisX', t('axisX')], ['axisY', t('axisY')], ['axisZ', t('axisZ')]]) {
            const l = el('label', { style: 'display:flex;align-items:center;gap:4px;cursor:pointer;color:#ddd;' });
            const cb = el('input', { type: 'checkbox' });
            cb.checked = !!s[key];
            checks[key] = cb;
            l.append(cb, document.createTextNode(label));
            axisRow.appendChild(l);
        }
        box.appendChild(axisRow);
        box.appendChild(el('div', { style: 'color:#889;font-size:11px;margin:0 0 0 22px;' }, t('axisHint')));

        heading(t('secFeet'));
        mkCheck('ground', t('ground'), t('groundHint'));
        const snapRow = el('div', { style: 'display:flex;align-items:center;gap:6px;margin:2px 0 2px 22px;color:#ddd;' });
        snapRow.appendChild(document.createTextNode(t('snapLabel')));
        const snap = el('input', {
            type: 'number', min: '0', max: '50', step: '1', value: String(s.snapCm),
            style: 'width:52px;background:#111;border:1px solid #555;color:#ddd;padding:2px 4px;border-radius:3px;font-size:12px;',
        });
        snap.addEventListener('keydown', e => e.stopPropagation());
        snapRow.append(snap, document.createTextNode('cm'));
        box.appendChild(snapRow);
        box.appendChild(el('div', { style: 'color:#889;font-size:11px;margin:0 0 0 22px;' }, t('snapHint')));
        mkCheck('flatten', t('flatten'), t('flattenHint'));

        // 依存関係: 腰の移動(Y 軸)が無いと接地補正は効かない。接地補正が無いと足の水平化は効かない
        const sync = () => {
            const hipsOn = checks.hips.checked;
            for (const k of ['axisX', 'axisY', 'axisZ']) checks[k].disabled = !hipsOn;
            const groundOk = hipsOn && checks.axisY.checked;
            checks.ground.disabled = !groundOk;
            snap.disabled = !groundOk || !checks.ground.checked;
            checks.flatten.disabled = !groundOk || !checks.ground.checked;
            const dim = (e, d) => { e.closest('label')?.style.setProperty('opacity', d ? '0.45' : '1'); };
            for (const k of ['axisX', 'axisY', 'axisZ', 'ground', 'flatten']) dim(checks[k], checks[k].disabled);
            snapRow.style.opacity = snap.disabled ? '0.45' : '1';
        };
        for (const k of ['hips', 'axisY', 'ground']) checks[k].addEventListener('change', sync);
        sync();

        const btnRow = el('div', { style: 'display:flex;gap:6px;justify-content:flex-end;margin-top:14px;' });
        const cancelBtn = el('button', { style: 'padding:5px 12px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;' }, t('cancel'));
        const okBtn = el('button', { style: 'padding:5px 12px;background:#2a5a8a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;' }, t('import'));
        const close = (v) => { document.removeEventListener('keydown', onKey, true); dlg.remove(); resolve(v); };
        const ok = () => {
            const snapCm = Math.min(50, Math.max(0, parseFloat(snap.value) || 0));
            const next = {
                hips: checks.hips.checked, axisX: checks.axisX.checked, axisY: checks.axisY.checked, axisZ: checks.axisZ.checked,
                ground: checks.ground.checked, flatten: checks.flatten.checked, snapCm,
            };
            saveSettings(next);
            const anyAxis = next.axisX || next.axisY || next.axisZ;
            const hipsOn = next.hips && anyAxis;
            const groundOn = hipsOn && next.axisY && next.ground;
            close({
                hipsMotion: hipsOn ? [next.axisX ? 1 : 0, next.axisY ? 1 : 0, next.axisZ ? 1 : 0] : false,
                groundFeet: groundOn,
                flattenFeet: groundOn && next.flatten,
                groundSnap: [snapCm / 100, snapCm / 100 + 0.20], // 吸着から 20cm かけて補正を弱める
            });
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(null); }
            else if (e.key === 'Enter' && e.target?.tagName !== 'BUTTON') { e.stopPropagation(); ok(); }
        };
        document.addEventListener('keydown', onKey, true);
        cancelBtn.onclick = () => close(null);
        okBtn.onclick = ok;
        btnRow.append(cancelBtn, okBtn);
        box.appendChild(btnRow);
        dlg.appendChild(box);
        dlg.addEventListener('click', e => { if (e.target === dlg) close(null); });
        document.body.appendChild(dlg);
        setTimeout(() => okBtn.focus(), 0);
    });
}
