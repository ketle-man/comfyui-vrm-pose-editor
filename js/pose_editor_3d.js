import { app } from "../../scripts/app.js";
import { initPoseEditor3D } from './pose_editor_core.js';
import { openLightPoseEditor, importVrmaAsKeyframesFromNode } from './light_editor.js';

// ノードIDごとのモデルバッファキャッシュ（タブ切り替えによる再作成対策）
// { nodeId: { buffer: ArrayBuffer|null, isDefault: bool, url: string|null } }
const _nodeModelCache = {};

app.registerExtension({
    name: "Comfy.3DPoseEditor",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PoseEditor3D") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = onNodeCreated?.apply(this, arguments);
            const node = this;

            node.show_preview = false;

            const hideWidgets = () => {
                // Comfy.VueNodes.Enabled=true のモダンノードではComfyUIがパラメータをUI上に表示するため非表示にする
                // クラシックノード（false）では表示したままにする
                const isModern = app.ui?.settings?.getSettingValue?.("Comfy.VueNodes.Enabled", false);
                const toHide = isModern
                    ? ["image_data", "output_size_mode", "custom_width", "custom_height", "preview"]
                    : ["image_data", "preview"];
                for (const name of toHide) {
                    const w = node.widgets?.find(w => w.name === name);
                    if (w) { w.computeSize = () => [0, -4]; w.hidden = true; }
                }
                updateNodeSize(); // ウィジェット非表示完了後にサイズを再計算
            };
            setTimeout(hideWidgets, 0);
            setTimeout(hideWidgets, 100);

            // ---- コンテナ ----
            const container = document.createElement("div");
            container.style.cssText =
                "display:flex;flex-direction:column;align-items:stretch;" +
                "background:#2c2c2c;padding:6px;box-sizing:border-box;";

            // ---- ボタン行 ----
            const btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:4px;margin-bottom:2px;align-items:center;flex-wrap:wrap;";
            const btnRow2 = document.createElement("div");
            btnRow2.style.cssText = "display:flex;gap:4px;margin-bottom:4px;align-items:center;flex-wrap:wrap;";

            const captureBtn     = makeSmallButton("📸 Capture", "#4a90d9", "Send pose to output");
            const timerBtn       = makeSmallButton("⏱ OFF",     "#555",    "Timer Capture: OFF");
            // RP(Reset Pose)/RC(Reset Camera)はLight & Pose Editorのキーフレームパネルにも同機能の
            // 複製ボタンがある(pose_vrma_export.js)。モーダルを開かず素早くリセットしたいという
            // 要望により、ノード側にも設置する(両方editor.resetPose()/resetCamera()を呼ぶだけ)
            const resetBtn       = makeSmallButton("RP",         "#6c757d", "Reset Pose");
            const mirrorBtn      = makeSmallButton("↔",          "#5a6a7a", "Mirror Pose (flip left/right)");
            const cameraResetBtn = makeSmallButton("RC",         "#5a7a5a", "Reset Camera");
            const camModeBtn     = makeSmallButton("OT",         "#444",    "Camera: Perspective (click to toggle Orthographic)");

            const vrmBtn = makeSmallButton("VRM", "#7a5a9a", "Load VRM/GLB/GLTF file");
            const vrmInput = document.createElement("input");
            vrmInput.type = "file";
            vrmInput.accept = ".vrm,.glb,.gltf";
            vrmInput.style.display = "none";
            vrmBtn.onclick = () => vrmInput.click();

            const vrmaBtn = makeSmallButton("VRMA", "#3a7a9a", "Load .vrma animation onto the current VRM");
            const vrmaInput = document.createElement("input");
            vrmaInput.type = "file";
            vrmaInput.accept = ".vrma";
            vrmaInput.style.display = "none";
            vrmaBtn.onclick = () => vrmaInput.click();

            // VRMAボタンのキーフレーム読み込み版。選んだ.vrmaをそのまま流すのではなく、
            // Light & Pose Editorのキーフレームタイムライン(Poseトラック)へサンプリング読み込みする
            const vrmaKeyBtn = makeSmallButton("VRMA (KEY)", "#3a7a9a", "Load .vrma as pose keyframes (Light & Pose Editor)");
            const vrmaKeyInput = document.createElement("input");
            vrmaKeyInput.type = "file";
            vrmaKeyInput.accept = ".vrma";
            vrmaKeyInput.style.display = "none";
            vrmaKeyBtn.onclick = () => vrmaKeyInput.click();

            const savePoseBtn    = makeSmallButton("⬇️", "#4a7a4a", "Download the pose");
            const saveToPosesBtn = makeSmallButton("💾", "#4a6a8a", "Save pose to poses/");
            const loadPoseBtn    = makeSmallButton("📂", "#7a6a3a", "Load pose from JSON");
            const poseInput = document.createElement("input");
            poseInput.type = "file";
            poseInput.accept = ".json,.vroidpose";
            poseInput.style.display = "none";
            loadPoseBtn.onclick = () => poseInput.click();

            let _currentVrmBuffer = null; // VRMバッファへの参照（ライブラリ内サムネイル生成用）

            // Light & Pose Editor統合モーダルを開くボタン(旧: 1個の🎛ボタンから、Light/Poseそれぞれの
            // タブへ直接開ける2ボタンに分割。モーダル自体は共通で、initialTabで開始タブだけ切り替える)
            const lightBtn = makeSmallButton("💡 Light", "#5a5a9a", "Open Light Editor");
            const poseBtn  = makeSmallButton("🕺 Pose",  "#5a5a9a", "Open Pose Editor");

            let colorCorrectOn = false;
            const ccBtn = makeSmallButton("CC", "#444", "Color Correct: OFF");
            ccBtn.onclick = () => {
                colorCorrectOn = !colorCorrectOn;
                editor.setColorCorrect(colorCorrectOn);
                ccBtn.style.background = colorCorrectOn ? "#c07a20" : "#444";
                ccBtn.title = `Color Correct: ${colorCorrectOn ? "ON" : "OFF"}`;
            };

            // 視線ターゲット(LookAt)トグルボタン
            const lookAtBtn = makeSmallButton("👁 OFF", "#444", "LookAt Target: OFF");
            lookAtBtn.onclick = () => {
                const on = editor.toggleLookAt();
                lookAtBtn.textContent = on ? "👁 ON" : "👁 OFF";
                lookAtBtn.style.background = on ? "#1a9a9a" : "#444";
                lookAtBtn.title = `LookAt Target: ${on ? "ON (drag the cyan marker)" : "OFF"}`;
            };

            // 揺れ物理(SpringBone)トグルボタン
            const springBoneBtn = makeSmallButton("🎐 ON", "#3a6a4a", "Spring Bone Physics: ON");
            springBoneBtn.onclick = () => {
                const on = editor.toggleSpringBoneEnabled();
                springBoneBtn.textContent = on ? "🎐 ON" : "🎐 OFF";
                springBoneBtn.style.background = on ? "#3a6a4a" : "#444";
                springBoneBtn.title = `Spring Bone Physics: ${on ? "ON" : "OFF"}`;
            };

            // 風エフェクト(Wind)トグルボタン。詳細パラメータ(強さ・向き・そよぎ)はLight & Pose Editor内で調整する
            const windBtn = makeSmallButton("🌬 OFF", "#444", "Wind: OFF (詳細はLight & Pose Editor内で調整)");
            windBtn.onclick = () => {
                const on = editor.toggleWindEnabled();
                windBtn.textContent = on ? "🌬 ON" : "🌬 OFF";
                windBtn.style.background = on ? "#2a6a8a" : "#444";
                windBtn.title = `Wind: ${on ? "ON" : "OFF"} (詳細はLight & Pose Editor内で調整)`;
            };

            // 風の発生源マーカー(視線と同様にドラッグ可能な3Dオブジェクトで向きを指定)トグルボタン
            const windSourceBtn = makeSmallButton("🧭 OFF", "#444", "Wind Source Marker: OFF");
            windSourceBtn.onclick = () => {
                const on = editor.toggleWindSourceEnabled();
                windSourceBtn.textContent = on ? "🧭 ON" : "🧭 OFF";
                windSourceBtn.style.background = on ? "#c07a20" : "#444";
                windSourceBtn.title = `Wind Source Marker: ${on ? "ON (drag the orange cone)" : "OFF"}`;
            };

            // 背景画像ロードボタン
            const bgBtn = makeSmallButton("BG", "#3a6a4a", "Load background image");
            const bgInput = document.createElement("input");
            bgInput.type = "file";
            bgInput.accept = "image/*";
            bgInput.style.display = "none";
            bgBtn.onclick = () => bgInput.click();

            // 背景クリアボタン
            const bgClearBtn = makeSmallButton("✕", "#5a3a3a", "Clear background image");
            bgClearBtn.style.padding = "4px 7px";

            const bgColorInput = document.createElement("input");
            bgColorInput.type = "color";
            bgColorInput.value = "#e0e0e0";
            bgColorInput.title = "背景色";
            bgColorInput.style.cssText =
                "width:28px;height:26px;border:none;cursor:pointer;background:none;" +
                "padding:0;flex-shrink:0;border-radius:3px;";

            const vrmLabel = document.createElement("span");
            vrmLabel.style.cssText = "font-size:10px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;";
            vrmLabel.textContent = "default model";

            // ---- 3行目: 視線・揺れ + ポーズ操作系 ----
            const btnRow2b = document.createElement("div");
            btnRow2b.style.cssText = "display:flex;gap:4px;margin-bottom:4px;align-items:center;flex-wrap:wrap;";

            // ---- 4行目: ファイル名表示 ----
            const btnRow3 = document.createElement("div");
            btnRow3.style.cssText = "display:flex;gap:4px;margin-bottom:4px;align-items:center;flex-wrap:wrap;";

            // ---- 1行目: キャプチャ・タイマー・VRM・CC ----
            btnRow.appendChild(captureBtn);
            btnRow.appendChild(timerBtn);
            btnRow.appendChild(vrmBtn);
            btnRow.appendChild(vrmaBtn);
            btnRow.appendChild(vrmaKeyBtn);
            btnRow.appendChild(ccBtn);
            btnRow.appendChild(vrmInput);
            btnRow.appendChild(vrmaInput);
            btnRow.appendChild(vrmaKeyInput);
            btnRow.appendChild(bgInput);
            btnRow.appendChild(poseInput);
            // ---- 2行目: Light & Pose Editor + 背景系 ----
            btnRow2.appendChild(lightBtn);
            btnRow2.appendChild(poseBtn);
            btnRow2.appendChild(bgBtn);
            btnRow2.appendChild(bgClearBtn);
            btnRow2.appendChild(bgColorInput);
            btnRow2.appendChild(savePoseBtn);
            btnRow2.appendChild(saveToPosesBtn);
            btnRow2.appendChild(loadPoseBtn);
            // ---- 3行目: 視線・揺れ + カメラ操作 + ポーズ操作系 ----
            btnRow2b.appendChild(lookAtBtn);
            btnRow2b.appendChild(springBoneBtn);
            btnRow2b.appendChild(windBtn);
            btnRow2b.appendChild(windSourceBtn);
            btnRow2b.appendChild(cameraResetBtn);
            btnRow2b.appendChild(camModeBtn);
            btnRow2b.appendChild(resetBtn);
            btnRow2b.appendChild(mirrorBtn);
            // ---- 4行目: 読み込みファイル名 ----
            btnRow3.appendChild(vrmLabel);
            container.appendChild(btnRow);
            container.appendChild(btnRow2);
            container.appendChild(btnRow2b);
            container.appendChild(btnRow3);

            // ---- キャンバスラッパー ----
            const CVS_DISPLAY = 384;
            const cvsWrapper = document.createElement("div");
            // height を明示しないと position:absolute の子のみで高さが 0 になる
            cvsWrapper.style.cssText =
                `position:relative;width:${CVS_DISPLAY}px;height:${CVS_DISPLAY}px;` +
                "flex-shrink:0;";

            const cvs = document.createElement("canvas");
            cvs.width = 600; cvs.height = 600;
            cvs.style.cssText =
                `width:${CVS_DISPLAY}px;height:${CVS_DISPLAY}px;` +
                "border-radius:6px;display:block;" +
                "box-shadow:0 2px 8px rgba(0,0,0,0.5);";

            const gizmoCvs = document.createElement("canvas");
            const GIZMO_SIZE = 80;
            gizmoCvs.width = GIZMO_SIZE; gizmoCvs.height = GIZMO_SIZE;
            gizmoCvs.style.cssText =
                `position:absolute;top:6px;right:6px;width:${GIZMO_SIZE}px;height:${GIZMO_SIZE}px;` +
                "border-radius:50%;cursor:pointer;background:rgba(40,40,40,0.6);";

            // ---- アスペクト比フレームオーバーレイ（2D Canvas） ----
            const overlayCvs = document.createElement("canvas");
            overlayCvs.width = CVS_DISPLAY; overlayCvs.height = CVS_DISPLAY;
            overlayCvs.style.cssText =
                `position:absolute;top:0;left:0;width:${CVS_DISPLAY}px;height:${CVS_DISPLAY}px;` +
                "pointer-events:none;border-radius:6px;";

            // output_size_mode / custom_width / custom_height ウィジェットを読んでフレーム矩形を計算
            // 戻り値: { x, y, w, h } — すべてCVS_DISPLAY座標系（ピクセル）
            function getFrameRect() {
                const modeW  = node.widgets?.find(w => w.name === "output_size_mode");
                const cwW    = node.widgets?.find(w => w.name === "custom_width");
                const chW    = node.widgets?.find(w => w.name === "custom_height");
                const mode   = modeW?.value  ?? "Standard";
                const cw     = cwW?.value    ?? 600;
                const ch     = chW?.value    ?? 600;

                let ar; // 縦横比 (width / height)
                if (mode === "Custom") {
                    ar = cw / ch;
                } else {
                    ar = 1; // Standard / Background は正方形扱い
                }

                // CVS_DISPLAY × CVS_DISPLAY の中に ar を letterbox 配置
                let fw, fh;
                if (ar >= 1) {
                    fw = CVS_DISPLAY;
                    fh = Math.round(CVS_DISPLAY / ar);
                } else {
                    fh = CVS_DISPLAY;
                    fw = Math.round(CVS_DISPLAY * ar);
                }
                const fx = Math.round((CVS_DISPLAY - fw) / 2);
                const fy = Math.round((CVS_DISPLAY - fh) / 2);
                return { x: fx, y: fy, w: fw, h: fh };
            }

            // オーバーレイ（黒帯）を描画
            function drawOverlay() {
                const ctx = overlayCvs.getContext("2d");
                ctx.clearRect(0, 0, CVS_DISPLAY, CVS_DISPLAY);
                const { x, y, w, h } = getFrameRect();
                // フレーム外を半透明黒で塗る
                ctx.fillStyle = "rgba(0,0,0,0.75)";
                // 上
                if (y > 0)            ctx.fillRect(0, 0, CVS_DISPLAY, y);
                // 下
                if (y + h < CVS_DISPLAY) ctx.fillRect(0, y + h, CVS_DISPLAY, CVS_DISPLAY - (y + h));
                // 左
                if (x > 0)            ctx.fillRect(0, y, x, h);
                // 右
                if (x + w < CVS_DISPLAY) ctx.fillRect(x + w, y, CVS_DISPLAY - (x + w), h);
                // フレーム枠線
                ctx.strokeStyle = "rgba(255,255,255,0.4)";
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            }
            drawOverlay();

            cvsWrapper.appendChild(cvs);
            cvsWrapper.appendChild(gizmoCvs);
            cvsWrapper.appendChild(overlayCvs);
            container.appendChild(cvsWrapper);

            // 背景画像ファイル選択処理
            let bgObjectUrl = null;

            function clearBg() {
                if (bgObjectUrl) { URL.revokeObjectURL(bgObjectUrl); bgObjectUrl = null; }
                bgBtn.style.background = "#3a6a4a";
                bgBtn.title = "Load background image";
                editor.clearBgImage();
                editor.clearBgColor();
                bgColorInput.value = "#e0e0e0";
            }

            bgInput.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > 50 * 1024 * 1024) {
                    alert(`File too large: ${(file.size/1024/1024).toFixed(1)} MB (max 50 MB)`);
                    bgInput.value = "";
                    return;
                }
                if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
                bgObjectUrl = URL.createObjectURL(file);
                bgBtn.style.background = "#2a8a5a";
                bgBtn.title = `BG: ${file.name}`;
                editor.loadBgImage(bgObjectUrl);
                bgInput.value = "";
            });

            bgClearBtn.onclick = clearBg;

            // ---- コントロールポイントサイズパネル ----
            const cpPanel = document.createElement("div");
            cpPanel.style.cssText = "margin-top:4px;padding:3px 6px;background:#3a3a3a;border-radius:4px;display:flex;align-items:center;gap:6px;";

            const cpLabel = document.createElement("span");
            cpLabel.textContent = "Point Size";
            cpLabel.style.cssText = "font-size:11px;color:#ccc;font-weight:bold;white-space:nowrap;";

            const cpSlider = document.createElement("input");
            cpSlider.type = "range";
            cpSlider.min = "0.2"; cpSlider.max = "3.0"; cpSlider.step = "0.1";
            cpSlider.value = "1.0";
            cpSlider.style.cssText = "flex:1;height:14px;accent-color:#4a90d9;cursor:pointer;";

            const cpValLabel = document.createElement("span");
            cpValLabel.textContent = "1.0";
            cpValLabel.style.cssText = "font-size:10px;color:#aaa;width:24px;text-align:right;flex-shrink:0;";

            cpSlider.addEventListener("input", () => {
                const v = parseFloat(cpSlider.value);
                cpValLabel.textContent = v.toFixed(1);
                editor.setPointSize(v);
            });
            cpSlider.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });

            cpPanel.appendChild(cpLabel);
            cpPanel.appendChild(cpSlider);
            cpPanel.appendChild(cpValLabel);
            container.appendChild(cpPanel);

            // ---- VRMAタイムラインパネル（.vrma読込後のみ表示） ----
            const vrmaPanel = document.createElement("div");
            vrmaPanel.style.cssText =
                "margin-top:4px;padding:3px 6px;background:#3a3a3a;border-radius:4px;" +
                "display:none;align-items:center;gap:6px;";

            const vrmaPlayBtn = document.createElement("button");
            vrmaPlayBtn.textContent = "▶";
            vrmaPlayBtn.style.cssText =
                "padding:3px 8px;background:#4a90d9;color:#fff;border:none;border-radius:3px;" +
                "cursor:pointer;font-size:11px;flex-shrink:0;";

            const vrmaSeek = document.createElement("input");
            vrmaSeek.type = "range";
            vrmaSeek.min = "0"; vrmaSeek.max = "1"; vrmaSeek.step = "0.001"; vrmaSeek.value = "0";
            vrmaSeek.style.cssText = "flex:1;height:14px;accent-color:#4a90d9;cursor:pointer;";
            vrmaSeek.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });

            const vrmaTimeLabel = document.createElement("span");
            vrmaTimeLabel.style.cssText = "font-size:10px;color:#aaa;white-space:nowrap;flex-shrink:0;";
            vrmaTimeLabel.textContent = "0.0 / 0.0s";

            const vrmaEjectBtn = document.createElement("button");
            vrmaEjectBtn.textContent = "✕";
            vrmaEjectBtn.title = "Unload VRMA animation";
            vrmaEjectBtn.style.cssText =
                "padding:3px 7px;background:#5a3a3a;color:#fff;border:none;border-radius:3px;" +
                "cursor:pointer;font-size:11px;flex-shrink:0;";

            vrmaPanel.appendChild(vrmaPlayBtn);
            vrmaPanel.appendChild(vrmaSeek);
            vrmaPanel.appendChild(vrmaTimeLabel);
            vrmaPanel.appendChild(vrmaEjectBtn);
            container.appendChild(vrmaPanel);

            // ---- カメラFOV(画角)パネル ----
            const fovPanel = document.createElement("div");
            fovPanel.style.cssText = "margin-top:4px;padding:3px 6px;background:#3a3a3a;border-radius:4px;display:flex;align-items:center;gap:6px;";

            const fovLabel = document.createElement("span");
            fovLabel.textContent = "FOV";
            fovLabel.style.cssText = "font-size:11px;color:#ccc;font-weight:bold;white-space:nowrap;";

            const fovSlider = document.createElement("input");
            fovSlider.type = "range";
            fovSlider.min = "10"; fovSlider.max = "120"; fovSlider.step = "1";
            fovSlider.value = "45";
            fovSlider.style.cssText = "flex:1;height:14px;accent-color:#4a90d9;cursor:pointer;";

            const fovValLabel = document.createElement("span");
            fovValLabel.textContent = "45";
            fovValLabel.style.cssText = "font-size:10px;color:#aaa;width:24px;text-align:right;flex-shrink:0;";

            fovSlider.addEventListener("input", () => {
                const v = parseFloat(fovSlider.value);
                fovValLabel.textContent = String(v);
                editor.setFov(v);
            });
            fovSlider.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });

            fovPanel.appendChild(fovLabel);
            fovPanel.appendChild(fovSlider);
            fovPanel.appendChild(fovValLabel);
            container.appendChild(fovPanel);

            // ---- カメラNear(ニアクリップ)パネル ----
            const nearPanel = document.createElement("div");
            nearPanel.style.cssText = "margin-top:4px;padding:3px 6px;background:#3a3a3a;border-radius:4px;display:flex;align-items:center;gap:6px;";

            const nearLabel = document.createElement("span");
            nearLabel.textContent = "Near";
            nearLabel.style.cssText = "font-size:11px;color:#ccc;font-weight:bold;white-space:nowrap;";

            const nearSlider = document.createElement("input");
            nearSlider.type = "range";
            nearSlider.min = "0.01"; nearSlider.max = "5"; nearSlider.step = "0.01";
            nearSlider.value = "0.1";
            nearSlider.style.cssText = "flex:1;height:14px;accent-color:#4a90d9;cursor:pointer;";

            const nearValLabel = document.createElement("span");
            nearValLabel.textContent = "0.10";
            nearValLabel.style.cssText = "font-size:10px;color:#aaa;width:28px;text-align:right;flex-shrink:0;";

            nearSlider.addEventListener("input", () => {
                const v = parseFloat(nearSlider.value);
                nearValLabel.textContent = v.toFixed(2);
                editor.setNear(v);
            });
            nearSlider.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });

            nearPanel.appendChild(nearLabel);
            nearPanel.appendChild(nearSlider);
            nearPanel.appendChild(nearValLabel);
            container.appendChild(nearPanel);

            // ノードサイズ動的更新
            function updateNodeSize() {
                if (node.computeSize) {
                    const sz = node.computeSize();
                    node.size = [430, sz[1] + 16]; // DOM要素のはみ出しを防ぐため余白を追加
                    node.setDirtyCanvas(true, true);
                } else {
                    const vrmaH = vrmaPanel.style.display !== "none" ? 34 : 0;
                    node.size = [430, 590 + vrmaH];
                    node.setDirtyCanvas(true, true);
                }
            }

            // シェイプキー一覧を保持するだけの軽量コールバック（editorから呼ばれる）。
            // シェイプキーの編集UI自体はLight & Pose Editorモーダルのposeタブへ完全移設したため、
            // ノード側では最新のkeys配列を保持し、モーダルを開く際に渡すだけでよい。
            let currentMorphKeys = [];
            function onMorphKeysReady(keys) {
                currentMorphKeys = keys;
            }

            // ---- DOM ウィジェット登録（メイン） ----
            const domWidget = node.addDOMWidget("pose_editor_3d_widget", "pose_editor_3d", container, {
                getValue() { return node.widgets?.find(w => w.name === "image_data")?.value ?? ""; },
                setValue(v) {},
            });
            // getValue()がimage_dataと同じ値を返す実装のため、serialize=falseにしないと
            // ワークフロー保存時にキャプチャ画像(数百KB〜数MB)がimage_dataと二重に書き込まれる
            domWidget.serialize = false;
            domWidget.computeSize = function() {
                const vrmaH = vrmaPanel.style.display !== "none" ? 34 : 0;
                return [430, 590 + vrmaH];
            };

            node.resizable = false;
            node.onResize = function () {
                if (this.computeSize) {
                    const sz = this.computeSize();
                    this.size = [430, sz[1] + 16];
                }
            };

            // 初期サイズ設定
            updateNodeSize();

            // ---- 3Dエディタ初期化 ----
            const baseUrl = new URL(".", import.meta.url).href;
            const isModern = app.ui?.settings?.getSettingValue?.("Comfy.VueNodes.Enabled", false);
            const editor = initPoseEditor3D(cvs, gizmoCvs, baseUrl, onMorphKeysReady, isModern);

            // タブ切り替えによるノード再作成時にキャッシュから復元
            const cachedModel = _nodeModelCache[node.id];
            if (cachedModel) {
                if (!cachedModel.isDefault && cachedModel.buffer) {
                    const url = URL.createObjectURL(new Blob([cachedModel.buffer]));
                    editor.loadVRMFromBuffer(cachedModel.buffer, url, () => {
                        URL.revokeObjectURL(url);
                        vrmBtn.textContent = "VRM";
                        vrmBtn.style.background = "#7a5a9a";
                    });
                }
                // デフォルトモデルの場合はinitPoseEditor3D内で自動ロードされるので何もしない
            }

            // output_size_mode / custom_width / custom_height の変更を監視してオーバーレイを更新
            for (const wName of ["output_size_mode", "custom_width", "custom_height"]) {
                const wgt = node.widgets?.find(w => w.name === wName);
                if (wgt) {
                    const origCallback = wgt.callback;
                    wgt.callback = function(...args) {
                        origCallback?.apply(this, args);
                        drawOverlay();
                    };
                }
            }

            function doCapture() {
                const frame = getFrameRect();
                const dataUrl = editor.capture(frame, CVS_DISPLAY);
                const w = node.widgets?.find(w => w.name === "image_data");
                if (w) w.value = dataUrl;

                if (_timerCapId === null) {
                    captureBtn.textContent = "✅ Captured!";
                    captureBtn.style.background = "#28a745";
                    setTimeout(() => {
                        captureBtn.textContent = "📸 Capture";
                        captureBtn.style.background = "#4a90d9";
                    }, 1500);
                } else {
                    timerBtn.style.background = "#e74c3c";
                    setTimeout(() => { timerBtn.style.background = "#7b0000"; }, 300);
                }
            }

            captureBtn.onclick = doCapture;

            let _timerCapId = null;
            timerBtn.onclick = () => {
                if (_timerCapId !== null) {
                    clearInterval(_timerCapId);
                    _timerCapId = null;
                    timerBtn.textContent = "⏱ OFF";
                    timerBtn.style.background = "#555";
                    timerBtn.title = "Timer Capture: OFF";
                } else {
                    const intervalW = node.widgets?.find(w => w.name === "timer_interval");
                    const sec = Math.max(1, intervalW?.value ?? 5);
                    doCapture();
                    _timerCapId = setInterval(doCapture, sec * 1000);
                    timerBtn.textContent = `⏱ ${sec}s`;
                    timerBtn.style.background = "#7b0000";
                    timerBtn.title = `Timer Capture: every ${sec}s (click to stop)`;
                }
            };

            // Light & Pose Editorを閉じた際、モーダル内でWind状態が変更された可能性があるため
            // ツールバー側の表示を再同期する(Light/Poseどちらのボタンから開いた場合も共通)
            function onLightPoseEditorClosed() {
                const on = editor.getWindEnabled();
                windBtn.textContent = on ? "🌬 ON" : "🌬 OFF";
                windBtn.style.background = on ? "#2a6a8a" : "#444";
                windBtn.title = `Wind: ${on ? "ON" : "OFF"} (詳細はLight & Pose Editor内で調整)`;

                const srcOn = editor.getWindSourceEnabled();
                windSourceBtn.textContent = srcOn ? "🧭 ON" : "🧭 OFF";
                windSourceBtn.style.background = srcOn ? "#c07a20" : "#444";
                windSourceBtn.title = `Wind Source Marker: ${srcOn ? "ON (drag the orange cone)" : "OFF"}`;

                // Light & Pose Editor内にも複製したPoint Sizeスライダーで値が変わった可能性があるため再同期
                const ps = editor.getPointSize();
                cpSlider.value = String(ps);
                cpValLabel.textContent = ps.toFixed(1);

                // Light & Pose Editor(PoseタブのProperties・キーフレームパネル)にも複製した
                // カメラ/LookAt/FOV/Nearコントロールで値が変わった可能性があるため、ノード側の表示も再同期する
                const orthoOn = editor.getIsOrtho();
                camModeBtn.dataset.mode     = orthoOn ? "ortho" : "persp";
                camModeBtn.textContent      = orthoOn ? "PR" : "OT";
                camModeBtn.style.background = orthoOn ? "#4a7aaa" : "#444";
                camModeBtn.title            = orthoOn
                    ? "Camera: Orthographic (click to switch to Perspective)"
                    : "Camera: Perspective (click to toggle Orthographic)";

                const lookOn = editor.getLookAtEnabled();
                lookAtBtn.textContent = lookOn ? "👁 ON" : "👁 OFF";
                lookAtBtn.style.background = lookOn ? "#1a9a9a" : "#444";
                lookAtBtn.title = `LookAt Target: ${lookOn ? "ON (drag the cyan marker)" : "OFF"}`;

                const fovNow = editor.getFov();
                fovSlider.value = String(fovNow);
                fovValLabel.textContent = String(fovNow);

                const nearNow = editor.getNear();
                nearSlider.value = String(nearNow);
                nearValLabel.textContent = nearNow.toFixed(2);
            }

            // Light & Pose Editorモーダル(Pose Properties欄・キーフレームパネル)から、
            // ノード側にしか無い機能(画像キャプチャ・VRM/VRMAロード)を呼び出すためのブリッジ。
            // モーダル側は複製ボタンを持つが、実処理はここに定義済みのノード側関数をそのまま再利用する
            // (キャッシュ更新・ノードサイズ再計算等の副作用を二重実装しないため)。
            const nodeActions = { doCapture, loadVrmFile, loadVrmaFile, unloadVrma };

            lightBtn.onclick = () => {
                openLightPoseEditor(editor, cvsWrapper, _currentVrmBuffer, () => currentMorphKeys, onLightPoseEditorClosed, "light", nodeActions);
            };
            poseBtn.onclick = () => {
                openLightPoseEditor(editor, cvsWrapper, _currentVrmBuffer, () => currentMorphKeys, onLightPoseEditorClosed, "pose", nodeActions);
            };

            // ---- VRMAタイムライン制御 ----
            let _vrmaUISyncId = null; // UI表示をplayback timeへ追従させるrAFループ

            function _formatVrmaTime() {
                const dur = editor.getVRMADuration();
                const t = editor.getVRMATime();
                vrmaTimeLabel.textContent = `${t.toFixed(1)} / ${dur.toFixed(1)}s`;
                vrmaSeek.value = String(t);
            }

            function _startVrmaUISync() {
                if (_vrmaUISyncId !== null) return;
                const tick = () => {
                    if (!editor.isVRMAPlaying()) { _vrmaUISyncId = null; return; }
                    _formatVrmaTime();
                    _vrmaUISyncId = requestAnimationFrame(tick);
                };
                _vrmaUISyncId = requestAnimationFrame(tick);
            }

            function _setVrmaPlayingUI(playing) {
                vrmaPlayBtn.textContent = playing ? "⏸" : "▶";
                if (playing) _startVrmaUISync();
            }

            vrmaPlayBtn.onclick = () => {
                if (editor.isVRMAPlaying()) {
                    editor.pauseVRMA();
                    _setVrmaPlayingUI(false);
                } else {
                    editor.playVRMA();
                    _setVrmaPlayingUI(true);
                }
            };

            // スライダー操作時は自動的に一時停止してスクラブに専念させる
            vrmaSeek.addEventListener("pointerdown", () => {
                if (editor.isVRMAPlaying()) { editor.pauseVRMA(); _setVrmaPlayingUI(false); }
            });
            vrmaSeek.addEventListener("input", () => {
                editor.seekVRMA(parseFloat(vrmaSeek.value));
                _formatVrmaTime();
            });

            // Light & Pose Editorモーダル(Pose Properties欄)にも複製した「✕」ボタンから
            // nodeActions経由で呼べるよう、名前付き関数として切り出す
            function unloadVrma() {
                editor.clearVRMA();
                vrmaPanel.style.display = "none";
                updateNodeSize();
            }
            vrmaEjectBtn.onclick = unloadVrma;

            vrmaInput.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (!file) return;
                loadVrmaFile(file);
                vrmaInput.value = "";
            });

            // VRMA(KEY): 選んだ.vrmaをそのままロードせず、Light & Pose Editorのキーフレーム
            // タイムライン(Poseトラック)へサンプリング読み込みする。モーダルが閉じていれば
            // Poseタブで開いてから読み込む(importVrmaAsKeyframesFromNode内で判定)
            vrmaKeyInput.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    importVrmaAsKeyframesFromNode(
                        editor, cvsWrapper, _currentVrmBuffer, () => currentMorphKeys,
                        onLightPoseEditorClosed, nodeActions,
                        ev.target.result, file.name.replace(/\.vrma$/i, ""),
                    );
                };
                reader.readAsArrayBuffer(file);
                vrmaKeyInput.value = "";
            });

            function loadVrmaFile(file) {
                vrmaBtn.textContent = "⏳";
                const reader = new FileReader();
                reader.onload = (ev) => {
                    editor.loadVRMAFromBuffer(ev.target.result, () => {
                        vrmaBtn.textContent = "VRMA";
                        vrmaSeek.max = String(editor.getVRMADuration());
                        vrmaSeek.value = "0";
                        _formatVrmaTime();
                        vrmaPanel.style.display = "flex";
                        _setVrmaPlayingUI(false);
                        updateNodeSize();
                    }, (msg) => {
                        vrmaBtn.textContent = "VRMA";
                        alert("VRMA load error: " + msg);
                    });
                };
                reader.readAsArrayBuffer(file);
            }

            bgColorInput.addEventListener("input", () => editor.setBgColor(bgColorInput.value));

            resetBtn.onclick   = () => editor.resetPose();
            mirrorBtn.onclick  = () => editor.mirrorPose();
            cameraResetBtn.onclick = () => editor.resetCamera();
            camModeBtn.onclick = () => {
                const toOrtho = camModeBtn.dataset.mode !== "ortho";
                editor.switchCamera(toOrtho);
                camModeBtn.dataset.mode     = toOrtho ? "ortho" : "persp";
                camModeBtn.textContent      = toOrtho ? "PR" : "OT";
                camModeBtn.style.background = toOrtho ? "#4a7aaa" : "#444";
                camModeBtn.title            = toOrtho
                    ? "Camera: Orthographic (click to switch to Perspective)"
                    : "Camera: Perspective (click to toggle Orthographic)";
            };

            const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

            vrmInput.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > MAX_FILE_SIZE) {
                    alert(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 50 MB)`);
                    vrmInput.value = "";
                    return;
                }
                loadVrmFile(file);
                vrmInput.value = "";
            });

            function loadVrmFile(file) {
                vrmLabel.textContent = file.name.slice(0, 32) + (file.name.length > 32 ? "…" : "");
                vrmBtn.textContent = "⏳";
                vrmBtn.style.background = "#888";
                const reader = new FileReader();
                reader.onload = (e) => {
                    const buffer = e.target.result;
                    // キャッシュに保存（タブ切り替えによる再作成時に復元）
                    _nodeModelCache[node.id] = { buffer, isDefault: false };
                    // ライブラリのサムネイル生成用に保持
                    _currentVrmBuffer = buffer;
                    const url = URL.createObjectURL(new Blob([buffer]));
                    editor.loadVRMFromBuffer(buffer, url, () => {
                        URL.revokeObjectURL(url);
                        vrmBtn.textContent = "VRM";
                        vrmBtn.style.background = "#7a5a9a";
                        // モデル切替でコア側のVRMA状態はクリア済み(clearModel→_clearVRMA)。UI側も追従させる
                        vrmaPanel.style.display = "none";
                        if (_vrmaUISyncId !== null) { cancelAnimationFrame(_vrmaUISyncId); _vrmaUISyncId = null; }
                        updateNodeSize();
                    });
                };
                reader.readAsArrayBuffer(file);
            }

            // ---- ポーズJSON ダウンロード ----
            savePoseBtn.onclick = () => {
                const json = editor.exportPose();
                if (!json) return;
                const blob = new Blob([json], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "pose.json";
                a.click();
                URL.revokeObjectURL(a.href);
            };

            // ---- ポーズJSON を poses/ に保存 ----
            saveToPosesBtn.onclick = async () => {
                const json = editor.exportPose();
                if (!json) return;
                try {
                    const res  = await fetch("/pose_library/save_pose", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ json }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error ?? res.status);
                    saveToPosesBtn.textContent = "✅";
                    setTimeout(() => { saveToPosesBtn.textContent = "💾"; }, 1500);
                } catch (e) {
                    alert("poses/ への保存に失敗しました: " + e.message);
                }
            };

            // ---- ポーズJSON 読み込み ----
            function loadPoseFile(file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    try {
                        editor.importPose(e.target.result);
                    } catch (err) {
                        alert("Invalid pose JSON: " + err.message);
                    }
                };
                reader.readAsText(file);
            }

            poseInput.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (!file) return;
                loadPoseFile(file);
                poseInput.value = "";
            });

            // ---- canvas へのファイルドロップ ----
            cvsWrapper.addEventListener("dragover", (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
                cvsWrapper.style.outline = "2px solid #4a90d9";
            });
            cvsWrapper.addEventListener("dragleave", (e) => {
                e.stopPropagation();
                cvsWrapper.style.outline = "";
            });
            cvsWrapper.addEventListener("drop", (e) => {
                e.preventDefault();
                e.stopPropagation();
                cvsWrapper.style.outline = "";
                const file = e.dataTransfer.files[0];
                if (!file) return;
                const ext = file.name.split(".").pop().toLowerCase();
                if (ext === "json" || ext === "vroidpose") {
                    loadPoseFile(file);
                } else if (["vrm", "glb", "gltf"].includes(ext)) {
                    if (file.size > MAX_FILE_SIZE) {
                        alert(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 50 MB)`);
                        return;
                    }
                    loadVrmFile(file);
                } else if (ext === "vrma") {
                    if (file.size > MAX_FILE_SIZE) {
                        alert(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 50 MB)`);
                        return;
                    }
                    loadVrmaFile(file);
                }
            });


            // ---- ノード削除時のクリーンアップ ----
            node.onRemoved = function () {
                if (_timerCapId !== null) { clearInterval(_timerCapId); _timerCapId = null; }
                if (_vrmaUISyncId !== null) { cancelAnimationFrame(_vrmaUISyncId); _vrmaUISyncId = null; }
                editor.dispose();
                delete _nodeModelCache[node.id];
            };

            return ret;
        };
    },
});

// ---- ボタン生成ヘルパー ----
function makeSmallButton(label, bg, title = "") {
    const btn = document.createElement("button");
    btn.textContent = label;
    if (title) btn.title = title;
    btn.style.cssText =
        `padding:4px 10px;background:${bg};color:#fff;border:none;` +
        "border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;" +
        "transition:opacity 0.15s;white-space:nowrap;";
    btn.addEventListener("mouseover", () => { btn.style.opacity = "0.8"; });
    btn.addEventListener("mouseout",  () => { btn.style.opacity = "1"; });
    return btn;
}

