/**
 * Light & Pose Editor (統合モーダル・フェーズ1)
 * - Embeds the actual WebGL canvas (cvsWrapper) into the preview panel via DOM move + CSS scale
 *   → bone operations, camera orbit, light helper drag all work natively
 * - "Light" タブ: 複数ライト管理(Directional/Point/Spot/RectArea/Ambient)。左ペインを
 *   L(ライト一覧)/E(環境: 地面・壁・風)/S(基本設定: アンチエイリアス・マウス)の3サブタブ化。
 * - "pose" タブ: シェイプキー一覧 + ポーズライブラリボタン(既存 pose_library.js を起動するだけ)。
 * - モーダル下部にキーフレームパネル(pose_vrma_export.js の buildKeyframePanel)を両タブ共通で常設。
 * - Light Library: save/load/rename/delete presets (server-side .light_library/) ※Lightタブ専用。
 */

import { openPoseLibrary } from './pose_library.js';
import { buildKeyframePanel } from './pose_vrma_export.js';

// initialTab: "light"(既定) | "pose" — モーダルを開いた直後に表示するメインタブ
// (ノード側のLight/Poseボタンがそれぞれ対応するタブを直接指定して開くために使う)
// nodeActions: { doCapture, loadVrmFile, loadVrmaFile } (省略可)。ノード側(pose_editor_3d.js)にしか
//   無い機能(画像キャプチャ・VRM/VRMAロード時のキャッシュ更新等)を、Poseタブ Properties欄と
//   キーフレームパネルに複製したボタンから呼び出すためのブリッジ
export function openLightPoseEditor(editor, cvsWrapper, vrmBuffer, getShapeKeys, onClose, initialTab, nodeActions) {
    if (document.getElementById("light-pose-editor-modal")) return;
    document.body.appendChild(buildModal(editor, cvsWrapper, vrmBuffer, getShapeKeys, onClose, initialTab, nodeActions));
}

// モーダルが開いている間だけ有効な、現在アクティブなキーフレームパネルへの参照。
// ノード側の「VRMA (KEY)」ボタン(モーダルを開いていなくても押せる)から、モーダルの開閉状態に
// 関わらずPoseトラックへインポートできるようにするために使う(buildModal内でセット/クリアする)。
let _activeKeyframePanel = null;

// ノード側の「VRMA (KEY)」ボタンから呼ばれるエントリポイント。モーダルが既に開いていればその
// キーフレームパネルへ直接インポートし、閉じていればPoseタブで開いてからインポートする。
export function importVrmaAsKeyframesFromNode(editor, cvsWrapper, vrmBuffer, getShapeKeys, onClose, nodeActions, buffer, name) {
    if (_activeKeyframePanel) {
        _activeKeyframePanel.importVrmaAsKeyframes(buffer, name);
        return;
    }
    if (document.getElementById("light-pose-editor-modal")) return; // 念のための二重ガード
    document.body.appendChild(buildModal(editor, cvsWrapper, vrmBuffer, getShapeKeys, onClose, "pose", nodeActions, { buffer, name }));
}

// ----------------------------------------------------------------
const LIGHT_TYPES = [
    { value: "directional", label: "☀ Sun (Directional)" },
    { value: "point",       label: "💡 Point" },
    { value: "spot",        label: "🔦 Spot" },
    { value: "rect",        label: "▭ Box (Rect Area)" },
    { value: "ambient",     label: "🌐 Ambient" },
];

function buildModal(editor, cvsWrapper, vrmBuffer, getShapeKeys, onClose, initialTab, nodeActions, pendingVrmaKeyImport) {
    // ---- Save original DOM position of cvsWrapper ----
    const origParent      = cvsWrapper.parentNode;
    const origNextSibling = cvsWrapper.nextSibling;
    const origTransform   = cvsWrapper.style.transform;
    const origTransformOrigin = cvsWrapper.style.transformOrigin;
    const origPosition    = cvsWrapper.style.position;
    const origTop         = cvsWrapper.style.top;
    const origLeft        = cvsWrapper.style.left;

    // Overlay
    const overlay = el("div", {
        id: "light-pose-editor-modal",
        style: "position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:99999;" +
               "display:flex;align-items:center;justify-content:center;",
    });
    overlay.tabIndex = -1;
    overlay.addEventListener("keydown", e => { if (e.key === "Escape") cleanup(); });
    // モーダル外クリックでの誤クローズを防ぐため、背景クリックでは閉じない(✕ボタン/Escapeのみ)
    overlay.focus();

    let resizeObserver = null;
    // editor._kfPanelState: 前回このモーダルを閉じた際のタイムライン状態(keyframes/fps/totalFrames/currentFrame)。
    // editorはノードごとに1つ生きたまま保持されるオブジェクトなので、ここに保持しておくことで
    // モーダルを閉じてもキーフレームが消えないようにする。
    const keyframePanel = buildKeyframePanel(editor, () => vrmBuffer, getShapeKeys, () => {
        // シーク/再生でシェイプキー値が変わった際、Poseタブ表示中ならスライダー表示も追従させる
        if (activeMainTab === "pose") rebuildShapeKeySliders();
    }, editor._kfPanelState, nodeActions);
    _activeKeyframePanel = keyframePanel;
    // ノード側「VRMA (KEY)」ボタンから、モーダルが閉じている状態で呼ばれた場合はここで開かれる。
    // buildModal自体の初期化(cvsWrapperのDOM移動等)が終わってから実行するため1tick遅らせる。
    if (pendingVrmaKeyImport) {
        setTimeout(() => keyframePanel.importVrmaAsKeyframes(pendingVrmaKeyImport.buffer, pendingVrmaKeyImport.name), 0);
    }

    // モーダルを開いている間に呼び出し元の状態が変化し、cvsWrapperの元の親要素が既にDOMから
    // 失われている（文書に属さなくなっている）ケースがあり得る。この場合でも必ずモーダルを
    // 閉じられるよう、復元処理の失敗では例外を投げない（閉じるボタンが機能しなくなる不具合防止）。
    function cleanup() {
        try {
            // Restore cvsWrapper
            cvsWrapper.style.transform       = origTransform;
            cvsWrapper.style.transformOrigin = origTransformOrigin;
            cvsWrapper.style.position        = origPosition;
            cvsWrapper.style.top             = origTop;
            cvsWrapper.style.left            = origLeft;
            if (origParent && origParent.isConnected) {
                if (origNextSibling && origNextSibling.parentNode === origParent) {
                    origParent.insertBefore(cvsWrapper, origNextSibling);
                } else {
                    origParent.appendChild(cvsWrapper);
                }
            } else if (!cvsWrapper.isConnected) {
                // 元の親が失われている場合、最低限どこかに繋ぎ戻して迷子にしない
                document.body.appendChild(cvsWrapper);
            }
            // applyScale()でプレビュー拡大用に引き上げた解像度を、元の表示サイズに合わせて戻す。
            // DOM復帰直後はレイアウト未確定のためrAFで1フレーム待ってから実寸を測る。
            if (typeof editor.resizeRenderer === "function") {
                requestAnimationFrame(() => {
                    const w = cvsWrapper.clientWidth;
                    const h = cvsWrapper.clientHeight;
                    if (w > 0 && h > 0) {
                        const dpr = window.devicePixelRatio || 1;
                        editor.resizeRenderer(Math.round(w * dpr), Math.round(h * dpr));
                    }
                });
            }
        } catch (err) {
            console.warn("[light_editor] プレビューの復元に失敗しました:", err);
        }

        resizeObserver?.disconnect();
        editor.clearLightHelpers();
        editor.clearCameraHelpers();
        window.removeEventListener("lightHelperMoved", onHelperMoved);
        editor._kfPanelState = keyframePanel.getState();
        keyframePanel.destroy();
        if (_activeKeyframePanel === keyframePanel) _activeKeyframePanel = null;
        overlay.remove();
        onClose?.();
    }

    // ---- Dialog ----
    const dialog = el("div", {
        style: "background:#1e1e2e;color:#ccc;border-radius:10px;" +
               "width:min(96vw,1120px);height:min(94vh,700px);display:flex;flex-direction:column;" +
               "box-shadow:0 8px 40px rgba(0,0,0,0.85);overflow:hidden;font-family:sans-serif;",
    });

    // ---- Header ----
    const header = el("div", {
        style: "display:flex;align-items:center;gap:8px;padding:8px 14px;" +
               "background:#16213e;border-bottom:1px solid #333;flex-shrink:0;",
    });

    const titleIcon = el("span", { style: "font-size:14px;font-weight:bold;color:#e0e0ff;white-space:nowrap;" }, "Light & Pose Editor");

    const mainTabBar = el("div", { style: "display:flex;gap:4px;flex:1;margin-left:6px;" });
    const lightTabBtn = mkMainTabBtn("💡 Light");
    const poseTabBtn  = mkMainTabBtn("🕺 pose");
    mainTabBar.append(lightTabBtn, poseTabBtn);

    // ---- Point Size (ボーンハンドルの球サイズ倍率) ----
    // ノード側(pose_editor_3d.js)のコントロールポイントサイズパネルと同じeditor.setPointSize()を
    // 呼ぶだけの複製コントロール。モーダルを開いている間はcvsWrapperがモーダル側へ移動しノードの
    // 元パネルは見えなくなるため、ここにも置いて操作できるようにする。
    const pointSizeCtrl = el("div", { style: "display:flex;align-items:center;gap:5px;flex-shrink:0;" });
    const pointSizeLabel = el("span", { style: "font-size:10px;color:#889;white-space:nowrap;" }, "Point Size");
    const pointSizeSlider = el("input", {
        type: "range", min: "0.2", max: "3.0", step: "0.1", value: String(editor.getPointSize()),
        style: "width:80px;height:14px;accent-color:#4a90d9;cursor:pointer;",
    });
    pointSizeSlider.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    const pointSizeVal = el("span", {
        style: "font-size:10px;color:#889;width:22px;text-align:right;flex-shrink:0;",
    }, parseFloat(pointSizeSlider.value).toFixed(1));
    pointSizeSlider.addEventListener("input", () => {
        const v = parseFloat(pointSizeSlider.value);
        editor.setPointSize(v);
        pointSizeVal.textContent = v.toFixed(1);
    });
    pointSizeCtrl.append(pointSizeLabel, pointSizeSlider, pointSizeVal);

    const libBtn = el("button", {
        style: "padding:4px 10px;background:#2a3a6a;color:#aac;border:1px solid #3a4a7a;" +
               "border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;" +
               "white-space:nowrap;transition:all 0.15s;",
    }, "📚 Library");
    libBtn.title = "Light Preset Library";
    libBtn.addEventListener("mouseover", () => { libBtn.style.opacity = "0.8"; });
    libBtn.addEventListener("mouseout",  () => { libBtn.style.opacity = "1"; });

    header.append(titleIcon, mainTabBar, pointSizeCtrl, libBtn, mkCloseBtn(cleanup));

    // ----------------------------------------------------------------
    // uiRefs: captureCurrentSettings / applyPreset が参照するUI参照まとめ
    // (E/Sサブタブ構築の途中で埋めていく)
    // ----------------------------------------------------------------
    const uiRefs = {};

    // ---- 3-column body (+ library panel) ----
    const body = el("div", { style: "flex:1;display:flex;overflow:hidden;min-height:0;" });

    // ================================================================
    // Light タブ: 左ペイン (L/E/S サブタブ)
    // ================================================================
    const lightLeftWrap = el("div", { style: "display:flex;flex-shrink:0;" });

    const subTabStrip = el("div", {
        style: "width:32px;flex-shrink:0;display:flex;flex-direction:column;" +
               "border-right:1px solid #2a2a4a;background:#12121c;",
    });
    const subTabL = mkSubTabBtn("L", "Lights");
    const subTabE = mkSubTabBtn("E", "Environment (地面・壁・風)");
    const subTabS = mkSubTabBtn("S", "Settings (アンチエイリアス・マウス)");
    subTabStrip.append(subTabL, subTabE, subTabS);

    const subTabContent = el("div", {
        style: "width:238px;flex-shrink:0;display:flex;flex-direction:column;" +
               "border-right:1px solid #2a2a4a;background:#161622;overflow:hidden;",
    });

    // ---- L: Light list ----
    const lBody = el("div", { style: "display:flex;flex-direction:column;flex:1;overflow:hidden;" });
    const listHeader = el("div", {
        style: "display:flex;align-items:center;padding:7px 10px;" +
               "border-bottom:1px solid #2a2a4a;flex-shrink:0;",
    });
    const addBtn = mkBtn("＋ Add", "#2a5a8a");
    addBtn.style.padding = "3px 9px";
    listHeader.append(
        el("span", { style: "font-size:12px;font-weight:bold;color:#aaa;flex:1;" }, "Lights"),
        addBtn
    );
    const listContent = el("div", { style: "flex:1;overflow-y:auto;padding:4px;" });
    lBody.append(listHeader, listContent);

    // ---- E: Environment (Ground / Wall / Wind / Shadow quality) ----
    const eBody = el("div", { style: "display:none;flex-direction:column;gap:2px;padding:8px;overflow-x:hidden;overflow-y:auto;flex:1;box-sizing:border-box;" });

    // Ground
    const groundBtn = mkToggleBtn("🟫 Ground", editor.getGroundVisible());
    groundBtn.onclick = () => applyToggle(groundBtn, "🟫 Ground", editor.toggleGround());
    const [groundYSl, groundYVl] = mkSl(-5, 5, 0.01, editor.getGroundY(), v => editor.setGroundY(v));
    const groundColorPick = el("input", { type: "color", value: editor.getGroundColor(),
        style: "width:26px;height:22px;border:none;cursor:pointer;background:none;padding:0;flex-shrink:0;",
        title: "Ground color" });
    groundColorPick.addEventListener("input", () => editor.setGroundColor(groundColorPick.value));
    const groundTexBtn = mkBtn("📁 Tex", "#2a4a6a"); groundTexBtn.title = "Load ground texture";
    groundTexBtn.style.cssText += "padding:3px 7px;font-size:10px;";
    const groundTexInput = mkFileInput("image/*");
    groundTexInput.addEventListener("change", e => {
        const file = e.target.files[0]; if (!file) return;
        const url = URL.createObjectURL(file);
        editor.setGroundTexture(url);
        groundTexBtn.textContent = "📁 " + file.name.slice(0, 8) + (file.name.length > 8 ? "…" : "");
        groundTexBtn.style.background = "#2a6a4a";
        groundTexInput.value = "";
    });
    groundTexBtn.onclick = () => groundTexInput.click();
    const groundTexClear = mkBtn("✕", "#5a3a3a"); groundTexClear.title = "Clear texture";
    groundTexClear.style.cssText += "padding:3px 6px;font-size:10px;";
    groundTexClear.onclick = () => {
        editor.clearGroundTexture();
        groundTexBtn.textContent = "📁 Tex"; groundTexBtn.style.background = "#2a4a6a";
    };
    const groundTileNum = mkNumInput(0.1, 50, 0.1, 1, n => editor.setGroundTexRepeat(n));
    const groundSCBtn = mkToggleBtn("🕶 SC", editor.getGroundShadowCatcher());
    groundSCBtn.style.cssText += "padding:3px 7px;font-size:10px;";
    groundSCBtn.title = "Shadow Catcher: 面を透明にして影だけ表示";
    groundSCBtn.onclick = () => applyToggle(groundSCBtn, "🕶 SC", editor.toggleGroundShadowCatcher());
    const groundSCOpNum = mkNumInput(0.01, 1, 0.05, 0.5, v => editor.setGroundShadowOpacity(v));

    eBody.append(
        sectionTitle("Ground"),
        fieldRow("Show:", groundBtn),
        sliderRow("Y:", groundYSl, groundYVl),
        fieldRow("Color:", row2(groundColorPick, groundTexBtn)),
        fieldRow("", row2(groundTexClear, lbl("Tile:"), groundTileNum)),
        fieldRow("", row2(groundSCBtn, lbl("影濃度:"), groundSCOpNum)),
    );

    // Wall
    const bgWallBtn = mkToggleBtn("🖼 BG Wall", editor.getBgWallVisible());
    bgWallBtn.onclick = () => applyToggle(bgWallBtn, "🖼 BG Wall", editor.toggleBgWall());
    const [bgZSl, bgZVl] = mkSl(-20, 5, 0.01, editor.getBgWallZ(), v => editor.setBgWallZ(v));
    const wallColorPick = el("input", { type: "color", value: editor.getBgWallColor(),
        style: "width:26px;height:22px;border:none;cursor:pointer;background:none;padding:0;flex-shrink:0;",
        title: "Wall color" });
    wallColorPick.addEventListener("input", () => editor.setBgWallColor(wallColorPick.value));
    const wallTexBtn = mkBtn("📁 Tex", "#2a4a6a"); wallTexBtn.title = "Load wall texture";
    wallTexBtn.style.cssText += "padding:3px 7px;font-size:10px;";
    const wallTexInput = mkFileInput("image/*");
    wallTexInput.addEventListener("change", e => {
        const file = e.target.files[0]; if (!file) return;
        const url = URL.createObjectURL(file);
        editor.setBgWallTexture(url);
        wallTexBtn.textContent = "📁 " + file.name.slice(0, 8) + (file.name.length > 8 ? "…" : "");
        wallTexBtn.style.background = "#2a6a4a";
        wallTexInput.value = "";
    });
    wallTexBtn.onclick = () => wallTexInput.click();
    const wallTexClear = mkBtn("✕", "#5a3a3a"); wallTexClear.title = "Clear texture";
    wallTexClear.style.cssText += "padding:3px 6px;font-size:10px;";
    wallTexClear.onclick = () => {
        editor.clearBgWallTexture();
        wallTexBtn.textContent = "📁 Tex"; wallTexBtn.style.background = "#2a4a6a";
    };
    const wallTileNum = mkNumInput(0.1, 50, 0.1, 1, n => editor.setBgWallTexRepeat(n));
    const wallSCBtn = mkToggleBtn("🕶 SC", editor.getBgWallShadowCatcher());
    wallSCBtn.style.cssText += "padding:3px 7px;font-size:10px;";
    wallSCBtn.title = "Shadow Catcher: 面を透明にして影だけ表示";
    wallSCBtn.onclick = () => applyToggle(wallSCBtn, "🕶 SC", editor.toggleBgWallShadowCatcher());
    const wallSCOpNum = mkNumInput(0.01, 1, 0.05, 0.5, v => editor.setBgWallShadowOpacity(v));

    eBody.append(
        sectionTitle("Wall"),
        fieldRow("Show:", bgWallBtn),
        sliderRow("Z:", bgZSl, bgZVl),
        fieldRow("Color:", row2(wallColorPick, wallTexBtn)),
        fieldRow("", row2(wallTexClear, lbl("Tile:"), wallTileNum)),
        fieldRow("", row2(wallSCBtn, lbl("影濃度:"), wallSCOpNum)),
    );

    // Shadow quality
    const shadowSel = el("select", {
        style: "flex:1;background:#111;border:1px solid #444;color:#ddd;padding:3px 6px;" +
               "border-radius:4px;font-size:11px;cursor:pointer;",
    });
    [["none","None"],["soft","Soft PCF"],["hard","Hard"]].forEach(([v, t]) =>
        shadowSel.appendChild(el("option", { value: v }, t)));
    shadowSel.value = "soft";
    shadowSel.addEventListener("change", () => editor.setShadowQuality(shadowSel.value));
    shadowSel.addEventListener("wheel", e => e.stopPropagation(), { passive: true });

    eBody.append(sectionTitle("Shadow Quality"), fieldRow("", shadowSel));

    // Wind
    const windBtn2 = mkToggleBtn("🌬 Wind", editor.getWindEnabled());
    windBtn2.title = "Spring Bone Physics がONの時のみ効果があります";
    windBtn2.onclick = () => applyToggle(windBtn2, "🌬 Wind", editor.toggleWindEnabled());
    const [windStrSl, windStrVl] = mkSl(0, 5, 0.05, editor.getWindStrength(), v => editor.setWindStrength(v));
    const [windDirSl, windDirVl] = mkSl(0, 360, 1, editor.getWindDirection(),
        v => editor.setWindDirection(v), v => v.toFixed(0) + "°");
    const [windGustSl, windGustVl] = mkSl(0, 1, 0.01, editor.getWindTurbulence(), v => editor.setWindTurbulence(v));

    function _syncWindDirDisabled(disabled) {
        windDirSl.disabled = disabled;
        windDirSl.style.opacity = disabled ? "0.4" : "1";
        windDirVl.style.opacity = disabled ? "0.4" : "1";
    }
    const windSrcBtn = mkToggleBtn("🧭 発生源", editor.getWindSourceEnabled());
    windSrcBtn.title = "ONにするとプレビュー内のオレンジのコーンをドラッグして風向きを指定できます(「向き」スライダーは無効化されます)";
    windSrcBtn.onclick = () => {
        const on = editor.toggleWindSourceEnabled();
        applyToggle(windSrcBtn, "🧭 発生源", on);
        _syncWindDirDisabled(on);
    };
    _syncWindDirDisabled(editor.getWindSourceEnabled());

    eBody.append(
        sectionTitle("Wind"),
        fieldRow("On:", windBtn2),
        sliderRow("強さ:", windStrSl, windStrVl),
        fieldRow("向き:", windSrcBtn),
        sliderRow("", windDirSl, windDirVl),
        sliderRow("そよぎ:", windGustSl, windGustVl),
    );

    // ---- S: Settings (AA / Mouse zoom mode) ----
    const sBody = el("div", { style: "display:none;flex-direction:column;gap:8px;padding:10px;overflow-x:hidden;overflow-y:auto;flex:1;box-sizing:border-box;" });

    const zoomModeBtn = mkToggleBtn("🖱 Ctrl+右ドラッグでズーム", editor.getZoomMode() === "ctrlDrag");
    zoomModeBtn.title = "OFF: マウスホイールでズーム / ON: 何もない場所でCtrl+右ドラッグでズーム\n" +
                         "(マウスホイールズームが機能しない環境向け)";
    zoomModeBtn.style.cssText += "white-space:normal;text-align:left;";
    zoomModeBtn.onclick = () => {
        const next = editor.getZoomMode() === "wheel" ? "ctrlDrag" : "wheel";
        editor.setZoomMode(next);
        applyToggle(zoomModeBtn, "🖱 Ctrl+右ドラッグでズーム", next === "ctrlDrag");
    };

    const AA_LABEL = "🖼 アンチエイリアス強化";
    const aaBtn = mkToggleBtn(AA_LABEL, editor.getSuperSample?.() ?? false);
    aaBtn.title = "プレビュー拡大表示時の輪郭のギザギザを抑えます（解像度を上げるため描画負荷が増えます）";
    aaBtn.style.cssText += "white-space:normal;text-align:left;";
    aaBtn.onclick = () => {
        const next = !(editor.getSuperSample?.() ?? false);
        editor.setSuperSample?.(next);
        applyToggle(aaBtn, AA_LABEL, next);
    };

    sBody.append(
        sectionTitle("Mouse"),
        zoomModeBtn,
        sectionTitle("Rendering"),
        aaBtn,
    );

    subTabContent.append(lBody, eBody, sBody);
    lightLeftWrap.append(subTabStrip, subTabContent);

    Object.assign(uiRefs, {
        shadowSel,
        groundBtn, groundYSl, groundColorPick, groundTileNum, groundSCBtn, groundSCOpNum,
        bgWallBtn, bgZSl, wallColorPick, wallTileNum, wallSCBtn, wallSCOpNum,
    });

    // ================================================================
    // Pose タブ: 左ペイン (K: Shape Keys / C: Camera サブタブ)
    // ================================================================
    // Lightタブのlight LeftWrap(subTabStrip 32px + subTabContent 238px = 270px)と
    // 全く同じ構成にすることで、Light⇄Pose切替時のダイアログ横幅ジャンプを起こさない。
    const poseLeftWrap = el("div", { style: "display:none;flex-shrink:0;" });

    const poseSubTabStrip = el("div", {
        style: "width:32px;flex-shrink:0;display:flex;flex-direction:column;" +
               "border-right:1px solid #2a2a4a;background:#12121c;",
    });
    const poseSubTabK = mkSubTabBtn("K", "Shape Keys");
    const poseSubTabC = mkSubTabBtn("C", "Camera");
    poseSubTabStrip.append(poseSubTabK, poseSubTabC);

    const poseSubTabContent = el("div", {
        style: "width:238px;flex-shrink:0;display:flex;flex-direction:column;" +
               "border-right:1px solid #2a2a4a;background:#161622;overflow:hidden;",
    });

    // ---- K: Shape Keys ----
    const kBody = el("div", { style: "display:flex;flex-direction:column;flex:1;overflow:hidden;" });
    const poseHeader = el("div", {
        style: "display:flex;align-items:center;padding:7px 10px;" +
               "border-bottom:1px solid #2a2a4a;flex-shrink:0;",
    });
    poseHeader.appendChild(el("span", { style: "font-size:12px;font-weight:bold;color:#aaa;flex:1;" }, "Shape Keys"));

    const shapeKeyBody = el("div", {
        style: "flex:1;overflow-x:hidden;overflow-y:auto;padding:4px 10px 10px;" +
               "display:flex;flex-direction:column;gap:5px;box-sizing:border-box;",
    });

    function rebuildShapeKeySliders() {
        shapeKeyBody.innerHTML = "";
        const keys = getShapeKeys?.() ?? [];
        if (keys.length === 0) {
            shapeKeyBody.appendChild(el("div", {
                style: "font-size:11px;color:#555;padding:16px 0;text-align:center;",
            }, "No shape keys found."));
            return;
        }
        keys.forEach(k => {
            const row = el("div", { style: "display:flex;align-items:center;gap:6px;min-width:0;" });
            const label = el("span", {
                style: "font-size:10px;color:#aaa;width:88px;flex-shrink:0;overflow:hidden;" +
                       "text-overflow:ellipsis;white-space:nowrap;",
                title: k.name,
            }, k.name);
            const slider = el("input", {
                type: "range", min: "0", max: "1", step: "0.01", value: String(k.getValue?.() ?? 0),
                style: "flex:1;min-width:0;height:12px;accent-color:#4a90d9;cursor:pointer;",
            });
            slider.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
            const valLbl = el("span", {
                style: "font-size:10px;color:#888;width:28px;text-align:right;flex-shrink:0;",
            }, parseFloat(slider.value).toFixed(2));
            slider.addEventListener("input", () => {
                const v = parseFloat(slider.value);
                k.setValue?.(v);
                valLbl.textContent = v.toFixed(2);
            });
            row.append(label, slider, valLbl);
            shapeKeyBody.appendChild(row);
        });
    }

    kBody.append(poseHeader, shapeKeyBody);

    // ---- C: Camera list ----
    const cBody = el("div", { style: "display:none;flex-direction:column;flex:1;overflow:hidden;" });
    const cameraListHeader = el("div", {
        style: "display:flex;align-items:center;padding:7px 10px;" +
               "border-bottom:1px solid #2a2a4a;flex-shrink:0;",
    });
    const cameraAddBtn = mkBtn("＋ Add", "#2a5a8a");
    cameraAddBtn.style.padding = "3px 9px";
    cameraListHeader.append(
        el("span", { style: "font-size:12px;font-weight:bold;color:#aaa;flex:1;" }, "Cameras"),
        cameraAddBtn
    );
    const cameraListContent = el("div", { style: "flex:1;overflow-y:auto;padding:4px;" });
    cBody.append(cameraListHeader, cameraListContent);

    let selectedCameraId = editor.getActiveCameraId();

    function refreshCameraList() {
        cameraListContent.innerHTML = "";
        const cams = editor.getCameras();
        cams.forEach(cam => {
            const isSel = selectedCameraId === cam.id;
            const item = el("div", {
                style: "display:flex;align-items:center;gap:5px;padding:6px 8px;" +
                       "border-radius:5px;cursor:pointer;margin-bottom:2px;" +
                       `background:${isSel ? "#222d45" : "#1c1c2c"};` +
                       `border:1px solid ${isSel ? "#4a6aaa" : "transparent"};`,
            });
            const icon = cam.isActive ? "🎥" : "📷";
            const colorDot = el("span", {
                style: `width:9px;height:9px;border-radius:50%;flex-shrink:0;background:${cam.color};`,
            });
            const children = [
                colorDot,
                el("span", {
                    style: "flex:1;font-size:12px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                }, `${icon} ${cam.name}${cam.isDefault ? " (Default)" : ""}`),
            ];
            if (!cam.isDefault) {
                children.push(mkDel(() => {
                    editor.removeCamera(cam.id);
                    if (selectedCameraId === cam.id) selectedCameraId = editor.getActiveCameraId();
                    refreshCameraList(); syncPosePropPanel();
                    keyframePanel.refreshCameraSelect?.();
                }));
            }
            item.append(...children);
            item.addEventListener("click", () => {
                selectedCameraId = cam.id;
                editor.setActiveCameraId(cam.id);
                refreshCameraList(); syncPosePropPanel();
                keyframePanel.refreshCameraSelect?.();
            });
            cameraListContent.appendChild(item);
        });
    }
    cameraAddBtn.addEventListener("click", () => {
        const cfg = editor.addCamera({ name: `Camera ${editor.getCameras().length}` });
        selectedCameraId = cfg.id;
        editor.setActiveCameraId(cfg.id);
        refreshCameraList(); syncPosePropPanel();
        keyframePanel.refreshCameraSelect?.();
    });

    poseSubTabContent.append(kBody, cBody);
    poseLeftWrap.append(poseSubTabStrip, poseSubTabContent);

    // ---- Col: Preview (actual WebGL canvas embedded, shared across both main tabs) ----
    const previewPanel = el("div", {
        style: "flex:1;display:flex;flex-direction:column;background:#111118;" +
               "border-right:1px solid #2a2a4a;min-width:0;",
    });
    const previewHeader = el("div", {
        style: "font-size:10px;color:#556;padding:5px 10px;flex-shrink:0;" +
               "border-bottom:1px solid #1a1a2a;background:#13131e;",
    }, "🎥 Preview  ·  ドラッグでカメラ操作  ·  青球でボーン操作  ·  黄球でライト移動");

    // Container that will hold cvsWrapper
    const previewWrap = el("div", {
        style: "flex:1;display:flex;align-items:center;justify-content:center;" +
               "overflow:hidden;min-height:0;padding:4px;",
    });
    previewPanel.append(previewHeader, previewWrap);

    // ---- Col: Properties (Lightタブ・Lサブタブ選択時のみ表示) ----
    const propPanel = el("div", {
        style: "width:280px;flex-shrink:0;display:flex;flex-direction:column;background:#181826;",
    });
    propPanel.append(
        el("div", {
            style: "font-size:11px;font-weight:bold;color:#7a9aaa;padding:7px 12px;" +
                   "border-bottom:1px solid #2a2a4a;flex-shrink:0;",
        }, "Properties")
    );
    const propBody = el("div", { style: "flex:1;overflow-y:auto;padding:10px 12px;" });
    propPanel.appendChild(propBody);

    // ---- Col: Properties (Poseタブ選択時のみ表示) ----
    // Light側Propertiesパネルと全く同じ幅(280px)にすることで、Light/Poseタブを切り替えるたびに
    // ダイアログ全体の横幅・レイアウトが変わってしまい目が疲れる、という問題を解消している。
    // ヘッダーバー自体はLight側との高さ揃えのために残すが、「Properties」という文字は表示しない。
    const posePropPanel = el("div", {
        style: "width:280px;flex-shrink:0;display:none;flex-direction:column;background:#181826;",
    });
    posePropPanel.append(
        el("div", {
            style: "font-size:11px;font-weight:bold;color:#7a9aaa;padding:7px 12px;" +
                   "border-bottom:1px solid #2a2a4a;flex-shrink:0;",
        })
    );
    const posePropBody = el("div", { style: "flex:1;overflow-y:auto;padding:10px 12px;" });
    posePropPanel.appendChild(posePropBody);

    // ---- Poseタブ Properties: カメラ (OT/PR切替・Look at Target・FOV・Near) ----
    // ノード側(pose_editor_3d.js)の複製ボタン/スライダー。editorの状態を直接読み書きするだけで、
    // ノード固有の副作用(キャッシュ更新等)は無いためnodeActionsは経由しない。
    const poseCamModeBtn = mkBtn("OT", "#444");
    function syncPoseCamModeBtn() {
        const orthoOn = editor.getIsOrtho();
        poseCamModeBtn.textContent = orthoOn ? "PR" : "OT";
        poseCamModeBtn.style.background = orthoOn ? "#4a7aaa" : "#444";
        poseCamModeBtn.title = orthoOn
            ? "Camera: Orthographic (click to switch to Perspective)"
            : "Camera: Perspective (click to toggle Orthographic)";
    }
    syncPoseCamModeBtn();
    poseCamModeBtn.onclick = () => { editor.switchCamera(!editor.getIsOrtho()); syncPoseCamModeBtn(); };

    // Look at Target ON/OFFボタンはここには置かず、キーフレームパネル下部(Mirrorボタン左隣)に
    // 常設する(VRMモデルの視線誘導というグローバル機能であり、カメラ固有の設定ではないため)。

    const [poseFovSl, poseFovVl]   = mkSl(10, 120, 1, editor.getFov(), v => editor.setFov(v));
    const [poseNearSl, poseNearVl] = mkSl(0.01, 5, 0.01, editor.getNear(), v => editor.setNear(v));

    // 選択中カメラの名前表示/編集
    const cameraNameIn = mkText(editor.getCameras().find(c => c.isActive)?.name ?? "");
    cameraNameIn.addEventListener("change", () => {
        editor.renameCamera(selectedCameraId, cameraNameIn.value);
        refreshCameraList();
        keyframePanel.refreshCameraSelect?.();
    });

    // カメラごとの色(キーフレームタイムラインのCam Switchトラックでキーの色として使われる)
    const cameraColorPick = el("input", { type: "color",
        value: editor.getCameras().find(c => c.isActive)?.color ?? "#66ddff",
        style: "width:34px;height:24px;border:none;cursor:pointer;background:none;padding:0;flex-shrink:0;" });
    const cameraColorHexIn = mkText(cameraColorPick.value, "68px");
    function applyCameraColor(hex) {
        editor.setCameraColor(selectedCameraId, hex);
        refreshCameraList();
        keyframePanel.refreshCameraSelect?.();
        keyframePanel.refreshTimeline?.();
    }
    cameraColorPick.addEventListener("input", () => { cameraColorHexIn.value = cameraColorPick.value; applyCameraColor(cameraColorPick.value); });
    cameraColorHexIn.addEventListener("change", () => {
        if (/^#[0-9a-f]{6}$/i.test(cameraColorHexIn.value)) { cameraColorPick.value = cameraColorHexIn.value; applyCameraColor(cameraColorHexIn.value); }
    });
    const cameraColorRow = el("div", { style: "display:flex;align-items:center;gap:5px;flex:1;" });
    cameraColorRow.append(cameraColorPick, cameraColorHexIn);

    // ---- Poseタブ Properties: モデル/ポーズデータ (VRM / VRMA / download / Save / Load from JSON) ----
    // VRM/VRMAロードはノード側のキャッシュ・サムネイル用バッファ・ノードサイズ再計算等の副作用があるため、
    // nodeActions経由でpose_editor_3d.js側のloadVrmFile/loadVrmaFileをそのまま呼び出す。
    const poseVrmBtn = mkBtn("Load MODEL", "#7a5a9a");
    poseVrmBtn.title = "Load VRM/GLB/GLTF file";
    const poseVrmInput = mkFileInput(".vrm,.glb,.gltf");
    poseVrmBtn.onclick = () => poseVrmInput.click();
    poseVrmInput.addEventListener("change", e => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 50 * 1024 * 1024) {
            alert(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 50 MB)`);
            poseVrmInput.value = "";
            return;
        }
        nodeActions?.loadVrmFile?.(file);
        poseVrmInput.value = "";
    });

    const poseVrmaBtn = mkBtn("VRMA", "#3a7a9a");
    poseVrmaBtn.title = "Load .vrma animation onto the current VRM";
    const poseVrmaInput = mkFileInput(".vrma");
    poseVrmaBtn.onclick = () => poseVrmaInput.click();
    poseVrmaInput.addEventListener("change", e => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 50 * 1024 * 1024) {
            alert(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 50 MB)`);
            poseVrmaInput.value = "";
            return;
        }
        nodeActions?.loadVrmaFile?.(file);
        poseVrmaInput.value = "";
    });

    // ノード側の「✕ Unload VRMA animation」ボタンの複製。実処理(vrmaPanel非表示・ノードサイズ再計算)は
    // ノード側に副作用があるため、nodeActions経由でpose_editor_3d.js側のunloadVrmaをそのまま呼び出す
    const poseVrmaEjectBtn = mkBtn("✕", "#5a3a3a");
    poseVrmaEjectBtn.title = "Unload VRMA animation";
    poseVrmaEjectBtn.onclick = () => nodeActions?.unloadVrma?.();

    // VRMAボタンのキーフレーム読み込み版。選んだ.vrmaをそのままロードせず、この場でキーフレーム
    // タイムライン(Poseトラック)へサンプリング読み込みする(モーダル内なのでkeyframePanelを直接呼べる)
    const poseVrmaKeyBtn = mkBtn("VRMA (KEY)", "#3a7a9a");
    poseVrmaKeyBtn.title = "Load .vrma as pose keyframes";
    const poseVrmaKeyInput = mkFileInput(".vrma");
    poseVrmaKeyBtn.onclick = () => poseVrmaKeyInput.click();
    poseVrmaKeyInput.addEventListener("change", e => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 50 * 1024 * 1024) {
            alert(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 50 MB)`);
            poseVrmaKeyInput.value = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = ev => {
            keyframePanel.importVrmaAsKeyframes(ev.target.result, file.name.replace(/\.vrma$/i, ""));
        };
        reader.readAsArrayBuffer(file);
        poseVrmaKeyInput.value = "";
    });

    const poseDownloadBtn = mkBtn("⬇️ Download", "#4a7a4a");
    poseDownloadBtn.title = "Download the pose";
    poseDownloadBtn.onclick = () => {
        const json = editor.exportPose();
        if (!json) return;
        const blob = new Blob([json], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "pose.json";
        a.click();
        URL.revokeObjectURL(a.href);
    };

    const poseSaveBtn = mkBtn("💾 Save", "#4a6a8a");
    poseSaveBtn.title = "Save pose to poses/";
    poseSaveBtn.onclick = async () => {
        const json = editor.exportPose();
        if (!json) return;
        try {
            const res = await fetch("/pose_library/save_pose", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ json }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? res.status);
            poseSaveBtn.textContent = "✅ Save";
            setTimeout(() => { poseSaveBtn.textContent = "💾 Save"; }, 1500);
        } catch (e) {
            alert("poses/ への保存に失敗しました: " + e.message);
        }
    };

    const poseLoadJsonBtn = mkBtn("📂 Load from JSON", "#7a6a3a");
    const poseJsonInput = mkFileInput(".json,.vroidpose");
    poseLoadJsonBtn.onclick = () => poseJsonInput.click();
    poseJsonInput.addEventListener("change", e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try { editor.importPose(ev.target.result); }
            catch (err) { alert("Invalid pose JSON: " + err.message); }
        };
        reader.readAsText(file);
        poseJsonInput.value = "";
    });

    // Cameraサブタブ選択時のみ表示するセクション(要件: Cameraサブタブ選択時は右ペインに
    // カメラごとの設定のみ表示、Shape Keysサブタブ選択時はModel/Pose Dataのみ表示)
    const posePropCameraSection = el("div", {});
    posePropCameraSection.append(
        sectionTitle("Camera"),
        fieldRow("Name:", cameraNameIn),
        fieldRow("Color:", cameraColorRow),
        fieldRow("", poseCamModeBtn),
        sliderRow("FOV:", poseFovSl, poseFovVl),
        sliderRow("Near:", poseNearSl, poseNearVl),
    );
    const posePropModelSection = el("div", {});
    posePropModelSection.append(
        sectionTitle("Model"),
        fieldRow("", poseVrmBtn),
        sectionTitle("Pose Data"),
        fieldRow("", row2(poseVrmaBtn, poseVrmaEjectBtn, poseVrmaKeyBtn)),
        fieldRow("", row2(poseDownloadBtn, poseSaveBtn)),
        fieldRow("", poseLoadJsonBtn),
        // 下部のキーフレームパネルはボタンが増えて手狭になったため、Save .vrma/WebM/GIFの3つを
        // こちらへ移設した(ロジックはpose_vrma_export.js内に残したまま、ボタンのDOM要素だけを移動)
        fieldRow("", keyframePanel.downloadBtn),
        sectionTitle("Output"),
        fieldRow("", row2(keyframePanel.webmBtn, keyframePanel.gifBtn)),
    );
    posePropBody.append(posePropCameraSection, posePropModelSection);

    // Poseタブへ切り替える度に呼び出し、ノード側ボタン操作(モーダルを開いたまま裏でノードの
    // OT/PR・FOV・Nearを直接操作するケースがあり得る)による状態変化をこちらへ反映する
    function syncPosePropPanel() {
        syncPoseCamModeBtn();
        keyframePanel.syncLookAtBtn?.();
        const activeCam = editor.getCameras().find(c => c.isActive);
        if (activeCam) {
            cameraNameIn.value = activeCam.name;
            cameraColorPick.value = activeCam.color;
            cameraColorHexIn.value = activeCam.color;
        }
        const fovNow = editor.getFov();
        poseFovSl.value = String(fovNow);
        poseFovVl.value = fovNow.toFixed(1);
        const nearNow = editor.getNear();
        poseNearSl.value = String(nearNow);
        poseNearVl.value = nearNow.toFixed(2);
    }

    // ---- Col: Library panel (光源プリセット、hidden initially、Lightタブ専用) ----
    const libPanel = buildLibraryPanel(editor, uiRefs, refreshList, showProps);
    libPanel.style.display = "none";

    body.append(lightLeftWrap, poseLeftWrap, previewPanel, propPanel, posePropPanel, libPanel);
    dialog.append(header, body, keyframePanel.el);
    overlay.appendChild(dialog);

    // ---- Library ボタン: Lightタブ=光源プリセットパネルのトグル / Poseタブ=Pose Libraryを開く ----
    libBtn.onclick = () => {
        if (activeMainTab === "pose") {
            // Pose Library側の1列プレビューへcvsWrapperを一時的に貸し出す。
            // 閉じて戻ってきた時点でこちら側のプレビュー枠サイズに合わせてapplyScale()を掛け直さないと、
            // Pose Library側の狭い列に合わせた解像度・transformのまま表示されてしまうため
            // onImportVrma: Pose Library内「Load KEY」ボタンから、選択中の.vrmaをこのモーダルの
            //   キーフレームタイムライン(Poseトラック)へサンプリング読み込みするための橋渡し。
            // onLoadVrmaRaw: 「Load」ボタンから、選択中の.vrmaをキーフレーム化せずそのまま
            //   ノード側のVRMA読み込み処理(nodeActions.loadVrmaFile)へ渡すための橋渡し
            openPoseLibrary(editor, vrmBuffer, cvsWrapper, () => applyScale(),
                (buf, name) => keyframePanel.importVrmaAsKeyframes(buf, name),
                nodeActions ? (buf) => nodeActions.loadVrmaFile(new Blob([buf])) : undefined);
            return;
        }
        const visible = libPanel.style.display !== "none";
        libPanel.style.display = visible ? "none" : "flex";
        libBtn.style.background = visible ? "#2a3a6a" : "#3a5aaa";
        libBtn.style.color      = visible ? "#aac" : "#fff";
        if (!visible) {
            // パネルを開いた時に一覧を読み込む
            libPanel._reload?.();
        }
    };

    // ---- メインタブ / サブタブ切り替え ----
    let activeMainTab = initialTab === "pose" ? "pose" : "light"; // "light" | "pose"
    let activeSubTab  = "L";     // "L" | "E" | "S"

    function applySubTab() {
        lBody.style.display = activeSubTab === "L" ? "flex" : "none";
        eBody.style.display = activeSubTab === "E" ? "flex" : "none";
        sBody.style.display = activeSubTab === "S" ? "flex" : "none";
        setSubTabActive(subTabL, activeSubTab === "L");
        setSubTabActive(subTabE, activeSubTab === "E");
        setSubTabActive(subTabS, activeSubTab === "S");
        propPanel.style.display = (activeMainTab === "light" && activeSubTab === "L") ? "flex" : "none";
    }
    subTabL.onclick = () => { activeSubTab = "L"; applySubTab(); };
    subTabE.onclick = () => { activeSubTab = "E"; applySubTab(); };
    subTabS.onclick = () => { activeSubTab = "S"; applySubTab(); };

    // ---- Poseタブ 左ペイン サブタブ (K: Shape Keys / C: Camera) ----
    let poseActiveSubTab = "K"; // "K" | "C"
    function applyPoseSubTab() {
        kBody.style.display = poseActiveSubTab === "K" ? "flex" : "none";
        cBody.style.display = poseActiveSubTab === "C" ? "flex" : "none";
        setSubTabActive(poseSubTabK, poseActiveSubTab === "K");
        setSubTabActive(poseSubTabC, poseActiveSubTab === "C");
        // 要件: Cameraサブタブ選択時は右ペインにカメラ設定のみ、Shape Keys選択時はModel/Pose Dataのみ
        posePropCameraSection.style.display = poseActiveSubTab === "C" ? "" : "none";
        posePropModelSection.style.display  = poseActiveSubTab === "K" ? "" : "none";
        if (poseActiveSubTab === "C") {
            refreshCameraList();
            editor.showCameraHelpers();
        } else {
            editor.clearCameraHelpers();
        }
    }
    poseSubTabK.onclick = () => { poseActiveSubTab = "K"; applyPoseSubTab(); };
    poseSubTabC.onclick = () => { poseActiveSubTab = "C"; applyPoseSubTab(); };

    function applyMainTab() {
        const isLight = activeMainTab === "light";
        lightLeftWrap.style.display = isLight ? "flex" : "none";
        poseLeftWrap.style.display = isLight ? "none" : "flex";
        posePropPanel.style.display = isLight ? "none" : "flex";
        if (!isLight && libPanel.style.display !== "none") {
            libPanel.style.display = "none";
        }
        libBtn.textContent = isLight ? "📚 Library" : "📚 Pose Library";
        libBtn.title = isLight ? "Light Preset Library" : "Open Pose Library";
        const libActive = isLight && libPanel.style.display !== "none";
        libBtn.style.background = libActive ? "#3a5aaa" : "#2a3a6a";
        libBtn.style.color      = libActive ? "#fff"    : "#aac";
        propPanel.style.display = (isLight && activeSubTab === "L") ? "flex" : "none";
        setMainTabActive(lightTabBtn, isLight);
        setMainTabActive(poseTabBtn, !isLight);
        if (isLight) {
            editor.clearCameraHelpers();
        } else {
            rebuildShapeKeySliders();
            syncPosePropPanel();
            applyPoseSubTab();
        }
    }
    lightTabBtn.onclick = () => { activeMainTab = "light"; applyMainTab(); };
    poseTabBtn.onclick  = () => { activeMainTab = "pose";  applyMainTab(); };

    applySubTab();
    applyMainTab();

    // ---- Embed cvsWrapper into preview ----
    previewWrap.appendChild(cvsWrapper);
    cvsWrapper.style.position = "relative"; // override absolute if any
    // 呼び出し元がposition:absolute用にtop/leftを設定している場合、position:relativeでは
    // オフセットとして再解釈されてプレビュー枠外に押し出されてしまうためリセットする
    cvsWrapper.style.top  = "0";
    cvsWrapper.style.left = "0";

    function applyScale() {
        const pw = previewWrap.clientWidth  - 8;
        const ph = previewWrap.clientHeight - 8;
        if (pw <= 0 || ph <= 0) return;
        // cvsWrapper の実レイアウトサイズ（transform非依存）を都度計測する。
        // 呼び出し元によってサイズが可変（例: コマの矩形に追従）なため固定値を仮定しない
        const cw = cvsWrapper.offsetWidth;
        const ch = cvsWrapper.offsetHeight;
        if (cw <= 0 || ch <= 0) return;
        const scale = Math.min(pw / cw, ph / ch);
        cvsWrapper.style.transform       = `scale(${scale.toFixed(4)})`;
        cvsWrapper.style.transformOrigin = "center center";

        // CSS transform:scale()で元サイズより拡大表示すると、レンダラーの実解像度が
        // 足りずラスターが荒く見える。拡大後の実表示サイズに合わせてレンダラー側の解像度も
        // 引き上げる（縮小表示時は元解像度のままで十分なため何もしない）。
        if (scale > 1 && typeof editor.resizeRenderer === "function") {
            const dpr = window.devicePixelRatio || 1;
            editor.resizeRenderer(Math.round(cw * scale * dpr), Math.round(ch * scale * dpr));
        }
    }
    // Apply after first layout paint
    requestAnimationFrame(() => {
        applyScale();
        resizeObserver = new ResizeObserver(applyScale);
        resizeObserver.observe(previewWrap);
    });

    // ----------------------------------------------------------------
    // State
    // ----------------------------------------------------------------
    let selectedId   = null;
    let lightCounter = 0;

    // ---- Light list ----
    function refreshList() {
        listContent.innerHTML = "";
        const lights = editor.getLights();
        if (lights.length === 0) {
            listContent.appendChild(el("div", {
                style: "font-size:11px;color:#555;padding:10px;text-align:center;",
            }, "No lights.\nClick ＋ Add."));
            return;
        }
        lights.forEach(cfg => {
            const isSel = selectedId === cfg.id;
            const item = el("div", {
                style: "display:flex;align-items:center;gap:5px;padding:6px 8px;" +
                       "border-radius:5px;cursor:pointer;margin-bottom:2px;" +
                       `background:${isSel ? "#222d45" : "#1c1c2c"};` +
                       `border:1px solid ${isSel ? "#4a6aaa" : "transparent"};`,
            });
            const icon = { directional:"☀", point:"💡", spot:"🔦", rect:"▭", ambient:"🌐" }[cfg.type] ?? "?";
            item.append(
                el("span", {
                    style: "flex:1;font-size:12px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                }, `${icon} ${cfg.name}`),
                mkDot(cfg, () => { editor.setLightEnabled(cfg.id, !cfg.enabled); refreshList(); if (selectedId === cfg.id) showProps(cfg.id); }),
                mkDel(() => { editor.removeLight(cfg.id); if (selectedId === cfg.id) { selectedId = null; showProps(null); } refreshList(); })
            );
            item.addEventListener("click", () => {
                selectedId = cfg.id; refreshList(); showProps(cfg.id); editor.selectLightHelper(cfg.id);
            });
            listContent.appendChild(item);
        });
    }

    // ---- Properties ----
    function showProps(id) {
        propBody.innerHTML = "";
        if (id === null) {
            propBody.appendChild(el("div", { style: "color:#555;font-size:12px;padding:20px 0;text-align:center;" },
                "Select a light to edit"));
            return;
        }
        const cfg = editor.getLights().find(l => l.id === id);
        if (!cfg) { showProps(null); return; }

        function sec(t) {
            propBody.appendChild(el("div", {
                style: "font-size:10px;font-weight:bold;color:#6a8a9a;margin:10px 0 5px;" +
                       "border-bottom:1px solid #252535;padding-bottom:2px;letter-spacing:.4px;",
            }, t.toUpperCase()));
        }
        function row(label, ctrl) {
            const r = el("div", { style: "display:flex;align-items:center;gap:6px;margin-bottom:6px;" });
            r.append(el("label", { style: "font-size:11px;color:#888;width:82px;flex-shrink:0;text-align:right;" }, label), ctrl);
            propBody.appendChild(r);
            return r;
        }
        function appendLast(node) { propBody.lastChild.appendChild(node); }

        // Identity
        sec("Identity");
        const nameIn = mkText(cfg.name);
        nameIn.addEventListener("change", () => { editor.updateLight(id, { name: nameIn.value }); refreshList(); });
        row("Name:", nameIn);

        const typeSel = el("select", {
            style: "flex:1;background:#111;border:1px solid #444;color:#ddd;padding:4px 6px;" +
                   "border-radius:4px;font-size:12px;cursor:pointer;",
        });
        LIGHT_TYPES.forEach(({ value, label }) => typeSel.appendChild(el("option", { value }, label)));
        typeSel.value = cfg.type;
        typeSel.addEventListener("change", () => { editor.updateLight(id, { type: typeSel.value }); showProps(id); refreshList(); });
        typeSel.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
        row("Type:", typeSel);

        // Color & Intensity
        sec("Color & Intensity");
        const colorPick = el("input", { type: "color", value: cfg.color,
            style: "width:34px;height:24px;border:none;cursor:pointer;background:none;padding:0;flex-shrink:0;" });
        const hexIn = mkText(cfg.color, "68px");
        colorPick.addEventListener("input", () => { hexIn.value = colorPick.value; editor.updateLight(id, { color: colorPick.value }); refreshList(); });
        hexIn.addEventListener("change", () => {
            if (/^#[0-9a-f]{6}$/i.test(hexIn.value)) { colorPick.value = hexIn.value; editor.updateLight(id, { color: hexIn.value }); refreshList(); }
        });
        const cw = el("div", { style: "display:flex;align-items:center;gap:5px;flex:1;" });
        cw.append(colorPick, hexIn);
        row("Color:", cw);

        const [iSl, iVl] = mkSl(0, 20, 0.1, cfg.intensity, v => editor.updateLight(id, { intensity: v }));
        row("Intensity:", iSl); appendLast(iVl);

        // Position
        if (cfg.type !== "ambient") {
            sec("Position  (黄球をドラッグで3D移動)");
            ["x","y","z"].forEach(axis => {
                const [sl, vl] = mkSl(-20, 20, 0.1, cfg.position[axis], v => {
                    cfg.position = { ...cfg.position, [axis]: v };
                    editor.updateLight(id, { position: { ...cfg.position } });
                });
                row("Pos " + axis.toUpperCase() + ":", sl); appendLast(vl);
            });
        }

        // Target
        if (cfg.type === "directional" || cfg.type === "spot") {
            sec("Target");
            ["x","y","z"].forEach(axis => {
                const [sl, vl] = mkSl(-20, 20, 0.1, cfg.target[axis], v => {
                    cfg.target = { ...cfg.target, [axis]: v };
                    editor.updateLight(id, { target: { ...cfg.target } });
                });
                row("Target " + axis.toUpperCase() + ":", sl); appendLast(vl);
            });
        }

        // Spot params
        if (cfg.type === "spot") {
            sec("Spot");
            const [aSl, aVl] = mkSl(0, Math.PI / 2, 0.01, cfg.angle ?? Math.PI / 6,
                v => editor.updateLight(id, { angle: v }),
                v => (v * 180 / Math.PI).toFixed(0) + "°");
            row("Angle:", aSl); appendLast(aVl);
            const [pSl, pVl] = mkSl(0, 1, 0.01, cfg.penumbra ?? 0.1, v => editor.updateLight(id, { penumbra: v }));
            row("Penumbra:", pSl); appendLast(pVl);
        }

        // Rect Area size
        if (cfg.type === "rect") {
            sec("Area Size");
            const [wSl, wVl] = mkSl(0.1, 20, 0.1, cfg.width ?? 2, v => editor.updateLight(id, { width: v }));
            row("Width:", wSl); appendLast(wVl);
            const [hSl, hVl] = mkSl(0.1, 20, 0.1, cfg.height ?? 2, v => editor.updateLight(id, { height: v }));
            row("Height:", hSl); appendLast(hVl);
        }

        // Attenuation
        if (cfg.type === "point" || cfg.type === "spot") {
            sec("Attenuation");
            const [decSl, decVl] = mkSl(0, 4, 0.1, cfg.decay ?? 1, v => editor.updateLight(id, { decay: v }));
            row("Decay:", decSl); appendLast(decVl);
            const [dSl, dVl] = mkSl(0, 50, 0.5, cfg.distance ?? 0, v => editor.updateLight(id, { distance: v }),
                v => v === 0 ? "∞" : v.toFixed(1));
            row("Distance:", dSl); appendLast(dVl);
        }

        // Shadows
        sec("Shadow");
        if (cfg.type === "directional") {
            const chk = document.createElement("input");
            chk.type = "checkbox"; chk.checked = cfg.castShadow ?? false;
            chk.addEventListener("change", () => editor.updateLight(id, { castShadow: chk.checked }));
            const lbl = el("label", { style: "font-size:12px;color:#ccc;cursor:pointer;display:flex;align-items:center;gap:6px;" });
            lbl.append(chk, el("span", {}, "Cast Shadows"));
            propBody.appendChild(lbl);
        } else {
            propBody.appendChild(el("div", { style: "font-size:11px;color:#556;padding:2px 0;" },
                cfg.type === "ambient" || cfg.type === "rect"
                    ? "このライトタイプはシャドウ非対応"
                    : "VRM MToon制限: Point/Spotのシャドウは使用不可"));
        }
    }

    // ---- Add button ----
    addBtn.addEventListener("click", () => {
        lightCounter++;
        const cfg = editor.addLight({
            name: "Light " + lightCounter,
            type: "directional", color: "#ffffff", intensity: 2.0,
            position: { x: 2, y: 4, z: 3 }, target: { x: 0, y: 1, z: 0 },
            castShadow: true, enabled: true,
        });
        selectedId = cfg.id; refreshList(); showProps(cfg.id); editor.selectLightHelper(cfg.id);
    });

    // ---- React to 3D drag position updates ----
    function onHelperMoved(e) {
        if (e.detail.id === selectedId) showProps(selectedId);
    }
    window.addEventListener("lightHelperMoved", onHelperMoved);

    // ---- Initial render ----
    refreshList();
    const lights = editor.getLights();
    if (lights.length > 0) {
        lightCounter = lights.length;
        // Select first non-ambient light for meaningful helpers
        const nonAmbient = lights.find(l => l.type !== "ambient") ?? lights[0];
        selectedId = nonAmbient.id;
        refreshList(); showProps(selectedId); editor.selectLightHelper(selectedId);
    }

    return overlay;
}

// ================================================================
// Library Panel (Light Preset)
// ================================================================

/**
 * ライブラリパネルを生成する。
 * @param {object} editor        - initPoseEditor3D 戻り値
 * @param {object} uiRefs        - sceneBar/surfaceBar の各UIコントロール参照
 * @param {Function} refreshList - ライトリストを再描画する関数
 * @param {Function} showProps   - プロパティパネルを再描画する関数
 */
function buildLibraryPanel(editor, uiRefs, refreshList, showProps) {
    const panel = el("div", {
        style: "width:230px;flex-shrink:0;flex-direction:column;" +
               "background:#12121e;border-left:1px solid #2a2a4a;",
    });

    // ---- ヘッダー ----
    const panelHeader = el("div", {
        style: "display:flex;align-items:center;gap:6px;padding:8px 10px;" +
               "border-bottom:1px solid #2a2a4a;flex-shrink:0;background:#16213e;",
    });

    const reloadBtn = el("button", {
        style: "background:none;border:none;color:#7a9aaa;font-size:14px;cursor:pointer;padding:2px 5px;" +
               "border-radius:3px;transition:color 0.15s;",
        title: "Reload",
    }, "↺");
    reloadBtn.addEventListener("mouseover", () => { reloadBtn.style.color = "#aad"; });
    reloadBtn.addEventListener("mouseout",  () => { reloadBtn.style.color = "#7a9aaa"; });

    panelHeader.append(
        el("span", { style: "font-size:12px;font-weight:bold;color:#aac;flex:1;" }, "📚 Library"),
        reloadBtn
    );

    // ---- 検索 ----
    const searchBar = el("div", {
        style: "padding:6px 8px;border-bottom:1px solid #1e1e38;flex-shrink:0;",
    });
    const searchInput = el("input", {
        type: "text", placeholder: "Search…",
        style: "width:100%;box-sizing:border-box;background:#111;border:1px solid #333;" +
               "color:#ccc;padding:4px 8px;border-radius:4px;font-size:11px;",
    });
    searchInput.addEventListener("wheel",   e => e.stopPropagation(), { passive: true });
    searchInput.addEventListener("keydown", e => e.stopPropagation());
    searchBar.appendChild(searchInput);

    // ---- 保存ボタン ----
    const saveBar = el("div", {
        style: "padding:6px 8px;border-bottom:1px solid #1e1e38;flex-shrink:0;",
    });
    const saveBtn = el("button", {
        style: "width:100%;padding:5px 0;background:#2a5a3a;color:#cfc;border:none;" +
               "border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;" +
               "transition:opacity 0.15s;",
    }, "💾 Save Current");
    saveBtn.addEventListener("mouseover", () => { saveBtn.style.opacity = "0.8"; });
    saveBtn.addEventListener("mouseout",  () => { saveBtn.style.opacity = "1"; });
    saveBar.appendChild(saveBtn);

    // ---- プリセット一覧 ----
    const listArea = el("div", { style: "flex:1;overflow-y:auto;padding:6px 6px;" });

    // ---- ステータス ----
    const statusBar = el("div", {
        style: "padding:4px 8px;font-size:10px;color:#444;flex-shrink:0;" +
               "border-top:1px solid #1a1a2a;",
    });

    panel.append(panelHeader, searchBar, saveBar, listArea, statusBar);

    // ----------------------------------------------------------------
    // 状態
    // ----------------------------------------------------------------
    let allPresets = [];

    function setStatus(msg, isError = false) {
        statusBar.textContent = msg;
        statusBar.style.color = isError ? "#a55" : "#444";
    }

    // ---- API ----
    async function apiFetch(url, opts) {
        const res = await fetch(url, opts);
        if (!res.ok) {
            const t = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
        }
        return res.json();
    }

    async function loadLibrary() {
        setStatus("Loading…");
        listArea.innerHTML = "";
        try {
            const data  = await apiFetch("/light_library/list");
            allPresets  = data.presets ?? [];
            setStatus(`${allPresets.length} preset${allPresets.length !== 1 ? "s" : ""}`);
            renderList();
        } catch (e) {
            setStatus("Error: " + e.message, true);
        }
    }

    async function savePreset(name) {
        const preset = captureCurrentSettings(editor, uiRefs);
        try {
            const data = await apiFetch("/light_library/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, preset }),
            });
            allPresets.push({
                id: data.id, path: data.path, name: data.name, createdAt: data.createdAt,
            });
            setStatus(`Saved: ${data.name}`);
            renderList();
        } catch (e) {
            alert("Failed to save: " + e.message);
        }
    }

    async function applyPresetById(id) {
        try {
            const data = await apiFetch(`/light_library/get/${id}`);
            applyPreset(data, editor, uiRefs, refreshList, showProps);
            setStatus("Applied!");
            setTimeout(() => setStatus(allPresets.length + " presets"), 1500);
        } catch (e) {
            alert("Failed to apply preset: " + e.message);
        }
    }

    async function renamePreset(id, newName) {
        try {
            await apiFetch("/light_library/rename", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, new_name: newName }),
            });
            const p = allPresets.find(p => p.id === id);
            if (p) p.name = newName;
            renderList();
        } catch (e) {
            alert("Failed to rename: " + e.message);
        }
    }

    async function deletePreset(id) {
        try {
            await apiFetch("/light_library/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id }),
            });
            allPresets = allPresets.filter(p => p.id !== id);
            setStatus(`${allPresets.length} preset${allPresets.length !== 1 ? "s" : ""}`);
            renderList();
        } catch (e) {
            alert("Failed to delete: " + e.message);
        }
    }

    // ---- フィルタリング ----
    function filtered() {
        const q = searchInput.value.toLowerCase();
        return q ? allPresets.filter(p => p.name.toLowerCase().includes(q)) : allPresets;
    }

    searchInput.addEventListener("input", renderList);

    // ---- 一覧描画 ----
    function renderList() {
        listArea.innerHTML = "";
        const list = filtered();
        if (list.length === 0) {
            const empty = el("div", {
                style: "font-size:11px;color:#444;text-align:center;padding:20px 8px;",
            }, allPresets.length === 0
                ? "プリセットがありません\n💾 で保存してください"
                : "一致するプリセットがありません");
            listArea.appendChild(empty);
            return;
        }
        list.forEach(preset => listArea.appendChild(buildCard(preset)));
    }

    // ---- カード生成 ----
    function buildCard(preset) {
        const card = el("div", {
            style: "padding:8px 10px;border-radius:5px;cursor:pointer;margin-bottom:4px;" +
                   "background:#1a1a2e;border:1px solid #252545;" +
                   "transition:border-color 0.12s,background 0.12s;",
        });
        card.addEventListener("mouseenter", () => {
            card.style.borderColor = "#4a80c0";
            card.style.background  = "#1e2040";
        });
        card.addEventListener("mouseleave", () => {
            card.style.borderColor = "#252545";
            card.style.background  = "#1a1a2e";
        });

        const nameEl = el("div", {
            style: "font-size:11px;color:#cce;font-weight:bold;" +
                   "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
            title: preset.name,
        }, preset.name);

        const dateStr = preset.createdAt
            ? new Date(preset.createdAt).toLocaleString("ja-JP", {
                  month: "2-digit", day: "2-digit",
                  hour: "2-digit", minute: "2-digit",
              })
            : "";
        const dateEl = el("div", {
            style: "font-size:9px;color:#44506a;margin-top:2px;",
        }, dateStr);

        card.append(nameEl, dateEl);

        // クリック → 適用
        card.addEventListener("click", () => applyPresetById(preset.id));

        // 右クリック → コンテキストメニュー
        card.addEventListener("contextmenu", e => {
            e.preventDefault();
            showCtxMenu(e.clientX, e.clientY, preset);
        });

        return card;
    }

    // ---- コンテキストメニュー ----
    function showCtxMenu(x, y, preset) {
        document.getElementById("lib-ctx-menu")?.remove();
        const menu = el("div", {
            id: "lib-ctx-menu",
            style: `position:fixed;left:${x}px;top:${y}px;` +
                   "background:#1a1a38;border:1px solid #3a3a5a;border-radius:6px;" +
                   "z-index:100001;padding:4px 0;min-width:150px;" +
                   "box-shadow:0 4px 16px rgba(0,0,0,0.7);font-family:sans-serif;",
        });

        const menuItem = (label, fn) => {
            const item = el("div", {
                style: "padding:7px 14px;cursor:pointer;font-size:12px;color:#ccc;white-space:nowrap;",
            }, label);
            item.addEventListener("mouseenter", () => item.style.background = "#2a2a5a");
            item.addEventListener("mouseleave", () => item.style.background = "");
            item.addEventListener("click", () => { menu.remove(); fn(); });
            return item;
        };

        menu.append(
            menuItem("✏️ 名前変更", () => showRenameDlg(preset)),
            menuItem("🗑 削除",     () => {
                if (!confirm(`プリセット「${preset.name}」を削除しますか？`)) return;
                deletePreset(preset.id);
            })
        );

        document.body.appendChild(menu);
        const close = e => {
            if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", close); }
        };
        setTimeout(() => document.addEventListener("click", close), 0);
    }

    // ---- 名前変更ダイアログ ----
    function showRenameDlg(preset) {
        const dlg = el("div", {
            style: "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100002;" +
                   "display:flex;align-items:center;justify-content:center;",
        });
        const box = el("div", {
            style: "background:#1e1e3a;border-radius:8px;padding:16px;min-width:280px;" +
                   "box-shadow:0 6px 24px rgba(0,0,0,0.7);font-family:sans-serif;",
        });
        const title = el("div", { style: "font-size:13px;font-weight:bold;color:#e0e0ff;margin-bottom:10px;" }, "✏️ 名前変更");
        const input = el("input", {
            type: "text",
            style: "width:100%;box-sizing:border-box;background:#111;border:1px solid #555;" +
                   "color:#ddd;padding:6px 10px;border-radius:4px;font-size:13px;",
        });
        input.value = preset.name;
        input.addEventListener("keydown", e => {
            e.stopPropagation();
            if (e.key === "Enter") ok();
            if (e.key === "Escape") dlg.remove();
        });
        const btnRow = el("div", { style: "display:flex;gap:6px;justify-content:flex-end;margin-top:10px;" });
        const cancelBtn = el("button", {
            style: "padding:5px 12px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;",
        }, "Cancel");
        const okBtn = el("button", {
            style: "padding:5px 12px;background:#2a5a8a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;",
        }, "Rename");
        function ok() {
            const n = input.value.trim();
            if (!n) return;
            renamePreset(preset.id, n);
            dlg.remove();
        }
        cancelBtn.onclick = () => dlg.remove();
        okBtn.onclick = ok;
        btnRow.append(cancelBtn, okBtn);
        box.append(title, input, btnRow);
        dlg.appendChild(box);
        document.body.appendChild(dlg);
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    // ---- 保存ダイアログ ----
    saveBtn.onclick = () => {
        const dlg = el("div", {
            style: "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100002;" +
                   "display:flex;align-items:center;justify-content:center;",
        });
        const box = el("div", {
            style: "background:#1e1e3a;border-radius:8px;padding:16px;min-width:280px;" +
                   "box-shadow:0 6px 24px rgba(0,0,0,0.7);font-family:sans-serif;",
        });
        const title = el("div", { style: "font-size:13px;font-weight:bold;color:#e0e0ff;margin-bottom:10px;" }, "💾 プリセット名を入力");
        const input = el("input", {
            type: "text", placeholder: "例: 夕方の逆光",
            style: "width:100%;box-sizing:border-box;background:#111;border:1px solid #555;" +
                   "color:#ddd;padding:6px 10px;border-radius:4px;font-size:13px;",
        });
        input.addEventListener("keydown", e => {
            e.stopPropagation();
            if (e.key === "Enter") ok();
            if (e.key === "Escape") dlg.remove();
        });
        const btnRow = el("div", { style: "display:flex;gap:6px;justify-content:flex-end;margin-top:10px;" });
        const cancelBtn = el("button", {
            style: "padding:5px 12px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;",
        }, "Cancel");
        const okBtn = el("button", {
            style: "padding:5px 12px;background:#2a5a3a;color:#cfc;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;",
        }, "Save");
        async function ok() {
            const n = input.value.trim();
            if (!n) { input.style.border = "1px solid #a55"; return; }
            dlg.remove();
            await savePreset(n);
        }
        cancelBtn.onclick = () => dlg.remove();
        okBtn.onclick = ok;
        btnRow.append(cancelBtn, okBtn);
        box.append(title, input, btnRow);
        dlg.appendChild(box);
        document.body.appendChild(dlg);
        setTimeout(() => input.focus(), 0);
    };

    // ---- reload / click ----
    reloadBtn.onclick = loadLibrary;

    // パネルを開いた時に外部から呼べるフック
    panel._reload = loadLibrary;

    return panel;
}

// ================================================================
// captureCurrentSettings
// 現在のライトエディタ状態を全収集してプリセットオブジェクトを返す
// ================================================================
function captureCurrentSettings(editor, uiRefs) {
    const lights = editor.getLights().map(cfg => ({ ...cfg }));

    const sc = editor.getGroundShadowCatcher?.() ?? false;
    const wc = editor.getBgWallShadowCatcher?.() ?? false;

    return {
        scene: {
            shadowQuality:       uiRefs.shadowSel.value,
            groundVisible:       editor.getGroundVisible(),
            groundY:             parseFloat(uiRefs.groundYSl.value),
            groundColor:         uiRefs.groundColorPick.value,
            groundTexRepeat:     parseFloat(uiRefs.groundTileNum.value),
            groundShadowCatcher: sc,
            groundShadowOpacity: parseFloat(uiRefs.groundSCOpNum.value),
            bgWallVisible:       editor.getBgWallVisible(),
            bgWallZ:             parseFloat(uiRefs.bgZSl.value),
            bgWallColor:         uiRefs.wallColorPick.value,
            bgWallTexRepeat:     parseFloat(uiRefs.wallTileNum.value),
            bgWallShadowCatcher: wc,
            bgWallShadowOpacity: parseFloat(uiRefs.wallSCOpNum.value),
        },
        lights,
    };
}

// ================================================================
// applyPreset
// プリセットをエディタAPIに流し込み、UIコントロールも同期する
// ================================================================
function applyPreset(preset, editor, uiRefs, refreshList, showProps) {
    const { scene, lights } = preset;
    if (!scene || !Array.isArray(lights)) return;

    // ---- ライトを全削除→再作成 ----
    const current = editor.getLights();
    current.forEach(l => editor.removeLight(l.id));
    lights.forEach(cfg => {
        // id は再生成されるので除外
        const { id: _id, ...rest } = cfg;
        editor.addLight(rest);
    });
    refreshList();
    showProps(null);

    // ---- Shadow quality ----
    editor.setShadowQuality(scene.shadowQuality);
    uiRefs.shadowSel.value = scene.shadowQuality;

    // ---- Ground ----
    const gVis = scene.groundVisible ?? false;
    if (editor.getGroundVisible() !== gVis) editor.toggleGround();
    applyToggle(uiRefs.groundBtn, "🟫 Ground", gVis);

    editor.setGroundY(scene.groundY ?? 0);
    uiRefs.groundYSl.value = scene.groundY ?? 0;
    // 数値入力の同期（mkSl の vl が number input の場合）
    const groundYVlSync = uiRefs.groundYSl.nextSibling;
    if (groundYVlSync && groundYVlSync.type === "number") groundYVlSync.value = (scene.groundY ?? 0).toFixed(2);

    editor.setGroundColor(scene.groundColor ?? "#555555");
    uiRefs.groundColorPick.value = scene.groundColor ?? "#555555";

    editor.setGroundTexRepeat(scene.groundTexRepeat ?? 1);
    uiRefs.groundTileNum.value = scene.groundTexRepeat ?? 1;

    const gSC = scene.groundShadowCatcher ?? false;
    if ((editor.getGroundShadowCatcher?.() ?? false) !== gSC) editor.toggleGroundShadowCatcher?.();
    applyToggle(uiRefs.groundSCBtn, "🕶 SC", gSC);

    editor.setGroundShadowOpacity(scene.groundShadowOpacity ?? 0.5);
    uiRefs.groundSCOpNum.value = scene.groundShadowOpacity ?? 0.5;

    // ---- BG Wall ----
    const wVis = scene.bgWallVisible ?? false;
    if (editor.getBgWallVisible() !== wVis) editor.toggleBgWall();
    applyToggle(uiRefs.bgWallBtn, "🖼 BG Wall", wVis);

    editor.setBgWallZ(scene.bgWallZ ?? -2);
    uiRefs.bgZSl.value = scene.bgWallZ ?? -2;
    const bgZVlSync = uiRefs.bgZSl.nextSibling;
    if (bgZVlSync && bgZVlSync.type === "number") bgZVlSync.value = (scene.bgWallZ ?? -2).toFixed(2);

    editor.setBgWallColor(scene.bgWallColor ?? "#666666");
    uiRefs.wallColorPick.value = scene.bgWallColor ?? "#666666";

    editor.setBgWallTexRepeat(scene.bgWallTexRepeat ?? 1);
    uiRefs.wallTileNum.value = scene.bgWallTexRepeat ?? 1;

    const wSC = scene.bgWallShadowCatcher ?? false;
    if ((editor.getBgWallShadowCatcher?.() ?? false) !== wSC) editor.toggleBgWallShadowCatcher?.();
    applyToggle(uiRefs.wallSCBtn, "🕶 SC", wSC);

    editor.setBgWallShadowOpacity(scene.bgWallShadowOpacity ?? 0.5);
    uiRefs.wallSCOpNum.value = scene.bgWallShadowOpacity ?? 0.5;
}

// ----------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------
function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "style") e.style.cssText = v;
        else e.setAttribute(k, v);
    }
    if (text !== undefined) e.textContent = text;
    return e;
}

function mkBtn(label, bg) {
    const b = el("button", {
        style: "padding:4px 10px;background:" + bg + ";color:#fff;border:none;" +
               "border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap;",
    }, label);
    b.addEventListener("mouseover", () => { b.style.opacity = "0.8"; });
    b.addEventListener("mouseout",  () => { b.style.opacity = "1"; });
    return b;
}

function mkCloseBtn(fn) {
    const b = el("button", { style: "background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;padding:4px 8px;" }, "✕");
    b.onclick = fn;
    return b;
}

function mkToggleBtn(label, isOn) {
    return el("button", {
        style: "padding:4px 11px;background:" + (isOn ? "#3a6a1a" : "#333344") + ";color:#fff;border:none;" +
               "border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap;",
    }, label + ": " + (isOn ? "ON" : "OFF"));
}

function applyToggle(btn, label, v) {
    btn.style.background = v ? "#3a6a1a" : "#333344";
    btn.textContent = label + ": " + (v ? "ON" : "OFF");
}

function mkText(val, width) {
    const widthCss = width ? "width:" + width + ";" : "";
    return el("input", {
        type: "text", value: val,
        style: "flex:1;" + widthCss + "background:#111;border:1px solid #444;" +
               "color:#ddd;padding:3px 7px;border-radius:4px;font-size:12px;",
    });
}

function mkSl(min, max, step, value, onChange, fmtFn) {
    const dec = step < 0.1 ? 2 : 1;
    const sl  = document.createElement("input");
    sl.type = "range"; sl.min = min; sl.max = max; sl.step = step; sl.value = value;
    sl.style.cssText = "flex:1;height:14px;accent-color:#4a90d9;cursor:pointer;min-width:60px;";
    sl.addEventListener("wheel", e => e.stopPropagation(), { passive: true });

    let vl;
    if (fmtFn) {
        // カスタム表示（度数など）→ 読み取り専用スパン
        vl = el("span", {
            style: "font-size:11px;color:#aaa;width:40px;text-align:right;flex-shrink:0;",
        }, fmtFn(value));
        sl.addEventListener("input", () => { const v = parseFloat(sl.value); vl.textContent = fmtFn(v); onChange(v); });
    } else {
        // 数値 → 直接入力可能な number input
        vl = document.createElement("input");
        vl.type = "number"; vl.step = step;
        vl.value = parseFloat(value).toFixed(dec);
        vl.style.cssText =
            "width:56px;background:#111;border:1px solid #444;color:#ddd;" +
            "padding:2px 5px;border-radius:4px;font-size:11px;text-align:right;flex-shrink:0;" +
            "appearance:textfield;-moz-appearance:textfield;";
        // スライダー → 数値入力 同期
        sl.addEventListener("input", () => {
            const v = parseFloat(sl.value);
            vl.value = v.toFixed(dec);
            onChange(v);
        });
        // 数値入力 → スライダー 同期
        vl.addEventListener("change", () => {
            let v = parseFloat(vl.value);
            if (isNaN(v)) { vl.value = parseFloat(sl.value).toFixed(dec); return; }
            v = Math.max(min, Math.min(max, v));
            vl.value = v.toFixed(dec);
            sl.value  = v;
            onChange(v);
        });
        vl.addEventListener("wheel",   e => e.stopPropagation(), { passive: true });
        vl.addEventListener("keydown", e => e.stopPropagation()); // ComfyUIのキーショートカット干渉防止
    }
    return [sl, vl];
}

function mkDot(cfg, onClick) {
    const d = el("span", {
        style: "font-size:13px;cursor:pointer;opacity:" + (cfg.enabled ? "1" : "0.3") + ";" +
               "user-select:none;flex-shrink:0;color:" + cfg.color + ";",
        title: cfg.enabled ? "Disable" : "Enable",
    }, "●");
    d.addEventListener("click", e => { e.stopPropagation(); onClick(); });
    return d;
}

function mkDel(onClick) {
    const d = el("span", { style: "font-size:11px;cursor:pointer;color:#774;user-select:none;flex-shrink:0;", title: "Delete" }, "✕");
    d.addEventListener("click", e => { e.stopPropagation(); onClick(); });
    return d;
}

function sep() {
    return el("span", { style: "color:#333;margin:0 2px;" }, "|");
}

function mkFileInput(accept) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = accept;
    inp.style.cssText = "display:none;";
    document.body.appendChild(inp);
    return inp;
}

function mkNumInput(min, max, step, value, onChange) {
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = min; inp.max = max; inp.step = step;
    inp.value = value;
    inp.style.cssText =
        "width:52px;background:#111;border:1px solid #444;color:#ddd;" +
        "padding:2px 5px;border-radius:4px;font-size:11px;text-align:right;" +
        "appearance:textfield;-moz-appearance:textfield;";
    inp.addEventListener("change", () => {
        let v = parseFloat(inp.value);
        if (isNaN(v)) { inp.value = value; return; }
        v = Math.max(min, Math.min(max, v));
        inp.value = v;
        onChange(v);
    });
    inp.addEventListener("wheel",   e => e.stopPropagation(), { passive: true });
    inp.addEventListener("keydown", e => e.stopPropagation());
    return inp;
}

// ---- 新規追加ヘルパー(タブUI・Environment縦積みレイアウト用) ----
function mkMainTabBtn(label) {
    const b = el("button", {
        style: "padding:5px 12px;background:#222236;color:#99a;border:none;" +
               "border-radius:5px 5px 0 0;cursor:pointer;font-size:12px;font-weight:bold;white-space:nowrap;",
    }, label);
    return b;
}
function setMainTabActive(btn, active) {
    btn.style.background = active ? "#2a3a6a" : "#222236";
    btn.style.color      = active ? "#fff"    : "#99a";
}

function mkSubTabBtn(label, title) {
    const b = el("button", {
        style: "padding:8px 0;background:#12121c;color:#889;border:none;border-bottom:1px solid #2a2a4a;" +
               "cursor:pointer;font-size:11px;font-weight:bold;",
        title,
    }, label);
    return b;
}
function setSubTabActive(btn, active) {
    btn.style.background = active ? "#222d45" : "#12121c";
    btn.style.color      = active ? "#fff"    : "#889";
}

function sectionTitle(t) {
    return el("div", {
        style: "font-size:10px;font-weight:bold;color:#6a8a9a;margin:6px 0 2px;" +
               "border-bottom:1px solid #252535;padding-bottom:2px;letter-spacing:.4px;",
    }, t.toUpperCase());
}

function lbl(text) {
    return el("span", { style: "font-size:10px;color:#777;flex-shrink:0;" }, text);
}

function fieldRow(label, ctrl) {
    const r = el("div", { style: "display:flex;align-items:center;gap:5px;padding:2px 0;" });
    if (label) r.appendChild(el("span", { style: "font-size:10px;color:#888;width:42px;flex-shrink:0;" }, label));
    r.appendChild(ctrl);
    return r;
}

function sliderRow(label, sl, vl) {
    const r = el("div", { style: "display:flex;align-items:center;gap:5px;padding:2px 0;" });
    if (label) r.appendChild(el("span", { style: "font-size:10px;color:#888;width:42px;flex-shrink:0;" }, label));
    r.append(sl, vl);
    return r;
}

function row2(...items) {
    const r = el("div", { style: "display:flex;align-items:center;gap:5px;flex:1;flex-wrap:wrap;" });
    r.append(...items);
    return r;
}
