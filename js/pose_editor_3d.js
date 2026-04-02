import { app } from "../../scripts/app.js";
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from './vendor/three-vrm.module.js';

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
            btnRow.style.cssText = "display:flex;gap:4px;margin-bottom:4px;align-items:center;flex-wrap:wrap;";

            const captureBtn     = makeSmallButton("📸 Capture", "#4a90d9", "Send pose to output");
            const resetBtn       = makeSmallButton("RP",         "#6c757d", "Reset Pose");
            const cameraResetBtn = makeSmallButton("RC",         "#5a7a5a", "Reset Camera");

            const vrmBtn = makeSmallButton("VRM", "#7a5a9a", "Load VRM/GLB/GLTF file");
            const vrmInput = document.createElement("input");
            vrmInput.type = "file";
            vrmInput.accept = ".vrm,.glb,.gltf";
            vrmInput.style.display = "none";
            vrmBtn.onclick = () => vrmInput.click();

            const savePoseBtn = makeSmallButton("💾", "#4a7a4a", "Save pose as JSON");
            const loadPoseBtn = makeSmallButton("📂", "#7a6a3a", "Load pose from JSON");
            const poseInput = document.createElement("input");
            poseInput.type = "file";
            poseInput.accept = ".json,.vroidpose";
            poseInput.style.display = "none";
            loadPoseBtn.onclick = () => poseInput.click();

            let colorCorrectOn = false;
            const ccBtn = makeSmallButton("CC", "#444", "Color Correct: OFF");
            ccBtn.onclick = () => {
                colorCorrectOn = !colorCorrectOn;
                editor.setColorCorrect(colorCorrectOn);
                ccBtn.style.background = colorCorrectOn ? "#c07a20" : "#444";
                ccBtn.title = `Color Correct: ${colorCorrectOn ? "ON" : "OFF"}`;
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

            const vrmLabel = document.createElement("span");
            vrmLabel.style.cssText = "font-size:10px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100px;";
            vrmLabel.textContent = "default model";

            btnRow.appendChild(captureBtn);
            btnRow.appendChild(resetBtn);
            btnRow.appendChild(cameraResetBtn);
            btnRow.appendChild(vrmBtn);
            btnRow.appendChild(ccBtn);
            btnRow.appendChild(bgBtn);
            btnRow.appendChild(bgClearBtn);
            btnRow.appendChild(savePoseBtn);
            btnRow.appendChild(loadPoseBtn);
            btnRow.appendChild(vrmInput);
            btnRow.appendChild(bgInput);
            btnRow.appendChild(poseInput);
            btnRow.appendChild(vrmLabel);
            container.appendChild(btnRow);

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

            cvsWrapper.appendChild(cvs);
            cvsWrapper.appendChild(gizmoCvs);
            container.appendChild(cvsWrapper);

            // 背景画像ファイル選択処理
            let bgObjectUrl = null;

            function clearBg() {
                if (bgObjectUrl) { URL.revokeObjectURL(bgObjectUrl); bgObjectUrl = null; }
                bgBtn.style.background = "#3a6a4a";
                bgBtn.title = "Load background image";
                editor.clearBgImage();
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

            // ---- シェイプキーパネル（折りたたみ） ----
            const morphPanel = document.createElement("div");
            morphPanel.style.cssText = "margin-top:4px;";

            const morphHeader = document.createElement("div");
            morphHeader.style.cssText =
                "display:flex;align-items:center;gap:6px;cursor:pointer;" +
                "padding:3px 6px;background:#3a3a3a;border-radius:4px;user-select:none;";
            const morphArrow = document.createElement("span");
            morphArrow.textContent = "▶";
            morphArrow.style.cssText = "font-size:10px;color:#aaa;transition:transform 0.15s;";
            const morphTitle = document.createElement("span");
            morphTitle.textContent = "Shape Keys";
            morphTitle.style.cssText = "font-size:11px;color:#ccc;font-weight:bold;";
            const morphCount = document.createElement("span");
            morphCount.style.cssText = "font-size:10px;color:#888;margin-left:auto;";
            morphCount.textContent = "0 keys";
            morphHeader.appendChild(morphArrow);
            morphHeader.appendChild(morphTitle);
            morphHeader.appendChild(morphCount);

            const morphBody = document.createElement("div");
            morphBody.style.cssText =
                "display:none;flex-direction:column;gap:3px;padding:4px 2px;" +
                "max-height:160px;overflow-y:auto;";

            let morphOpen = false;
            morphHeader.onclick = () => {
                morphOpen = !morphOpen;
                morphBody.style.display = morphOpen ? "flex" : "none";
                morphArrow.style.transform = morphOpen ? "rotate(90deg)" : "";
                // パネル開閉に合わせてノードサイズを更新
                updateNodeSize();
            };

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

            morphPanel.appendChild(morphHeader);
            morphPanel.appendChild(morphBody);
            container.appendChild(morphPanel);

            // ノードサイズ動的更新
            function updateNodeSize() {
                const baseH  = 556; // +36px for cpPanel
                const morphH = morphOpen ? Math.min(morphBody.children.length * 26 + 12, 172) : 0;
                node.size = [430, baseH + morphH];
                node.setDirtyCanvas(true, true);
            }

            // シェイプキースライダーを再構築する関数（editorから呼ばれる）
            function rebuildMorphSliders(keys) {
                morphBody.innerHTML = "";
                morphCount.textContent = `${keys.length} keys`;

                if (keys.length === 0) {
                    const empty = document.createElement("div");
                    empty.style.cssText = "font-size:10px;color:#666;padding:4px;";
                    empty.textContent = "No shape keys found.";
                    morphBody.appendChild(empty);
                    updateNodeSize();
                    return;
                }

                for (const { name, getValue, setValue } of keys) {
                    const row = document.createElement("div");
                    row.style.cssText = "display:flex;align-items:center;gap:4px;padding:1px 2px;";

                    const label = document.createElement("span");
                    label.textContent = name;
                    label.title = name;
                    label.style.cssText =
                        "font-size:10px;color:#bbb;width:100px;overflow:hidden;" +
                        "text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;";

                    const slider = document.createElement("input");
                    slider.type = "range";
                    slider.min = "0"; slider.max = "1"; slider.step = "0.01";
                    slider.value = String(getValue());
                    slider.style.cssText = "flex:1;height:14px;accent-color:#4a90d9;cursor:pointer;";

                    const valLabel = document.createElement("span");
                    valLabel.style.cssText = "font-size:10px;color:#aaa;width:28px;text-align:right;flex-shrink:0;";
                    valLabel.textContent = Number(getValue()).toFixed(2);

                    slider.addEventListener("input", () => {
                        const v = parseFloat(slider.value);
                        setValue(v);
                        valLabel.textContent = v.toFixed(2);
                    });

                    // スライダーのホイール操作（ComfyUIキャンバスへの伝播を防ぐ）
                    slider.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });

                    row.appendChild(label);
                    row.appendChild(slider);
                    row.appendChild(valLabel);
                    morphBody.appendChild(row);
                }
                updateNodeSize();
            }

            // ---- DOM ウィジェット登録（メイン） ----
            node.addDOMWidget("pose_editor_3d_widget", "pose_editor_3d", container, {
                getValue() { return node.widgets?.find(w => w.name === "image_data")?.value ?? ""; },
                setValue(v) {},
                computeSize() {
                    const morphH = morphOpen ? Math.min((morphBody.children.length || 1) * 26 + 12, 172) : 0;
                    return [410, 496 + morphH];
                },
            });

            node.size = [430, 556];
            node.resizable = false;
            node.onResize = function () {
                const morphH = morphOpen ? Math.min((morphBody.children.length || 1) * 26 + 12, 172) : 0;
                this.size = [430, 556 + morphH];
            };

            // ---- 3Dエディタ初期化 ----
            const baseUrl = new URL(".", import.meta.url).href;
            const isModern = app.ui?.settings?.getSettingValue?.("Comfy.VueNodes.Enabled", false);
            const editor = initPoseEditor3D(cvs, gizmoCvs, baseUrl, rebuildMorphSliders, isModern);

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

            captureBtn.onclick = () => {
                const dataUrl = editor.capture();
                const w = node.widgets?.find(w => w.name === "image_data");
                if (w) w.value = dataUrl;

                captureBtn.textContent = "✅ Captured!";
                captureBtn.style.background = "#28a745";
                setTimeout(() => {
                    captureBtn.textContent = "📸 Capture";
                    captureBtn.style.background = "#4a90d9";
                }, 1500);
            };

            resetBtn.onclick = () => editor.resetPose();
            cameraResetBtn.onclick = () => editor.resetCamera();

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
                vrmLabel.textContent = file.name.slice(0, 20) + (file.name.length > 20 ? "…" : "");
                vrmBtn.textContent = "⏳";
                vrmBtn.style.background = "#888";
                const reader = new FileReader();
                reader.onload = (e) => {
                    const buffer = e.target.result;
                    // キャッシュに保存（タブ切り替えによる再作成時に復元）
                    _nodeModelCache[node.id] = { buffer, isDefault: false };
                    const url = URL.createObjectURL(new Blob([buffer]));
                    editor.loadVRMFromBuffer(buffer, url, () => {
                        URL.revokeObjectURL(url);
                        vrmBtn.textContent = "VRM";
                        vrmBtn.style.background = "#7a5a9a";
                    });
                };
                reader.readAsArrayBuffer(file);
            }

            // ---- ポーズJSON 保存 ----
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
                }
            });


            // ---- ノード削除時のクリーンアップ ----
            node.onRemoved = function () {
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

// ---- Three.js エディタ本体 ----
function initPoseEditor3D(canvas, gizmoCanvas, baseUrl, onMorphKeysReady, isModern) {

    // -- メインレンダラー --
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(canvas.width, canvas.height, false);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(0, 1, 5);
    camera.lookAt(0, 1, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight.position.set(1, 2, 3);
    scene.add(dirLight);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableRotate = true;
    orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    orbit.target.set(0, 1, 0);
    orbit.update();

    // ---- Node2.0時のみイベント制御 ----
    if (isModern) {
        // wheel/contextmenu がComfyUIキャンバスに伝播しないよう阻止
        renderer.domElement.addEventListener("wheel",       (e) => { e.stopPropagation(); }, { passive: false });
        renderer.domElement.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });

        // Alt+左ドラッグ → ズーム
        // 通常の左ドラッグ=ROTATE、Ctrl+左ドラッグ=PAN はOrbitControls既定のまま
        let altDrag = false;
        let altDragLastY = 0;
        renderer.domElement.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            if (e.button === 0 && e.altKey) {
                // コントロールポイント上ではAltズームを起動しない
                updateMouse(e);
                raycaster.setFromCamera(mouse, camera);
                if (raycaster.intersectObjects(interactableBones).length > 0) return;
                altDrag = true;
                altDragLastY = e.clientY;
                orbit.enableRotate = false;
                orbit.enablePan    = false;
            }
        });
        renderer.domElement.addEventListener("pointermove", (e) => {
            e.stopPropagation();
            if (!altDrag) return;
            const dy = e.clientY - altDragLastY;
            altDragLastY = e.clientY;
            const dir = new THREE.Vector3().subVectors(camera.position, orbit.target).normalize();
            camera.position.addScaledVector(dir, dy * 0.01);
            orbit.update();
        });
        function endAltDrag() {
            if (!altDrag) return;
            altDrag = false;
            orbit.enableRotate = true;
            orbit.enablePan    = true;
        }
        window.addEventListener("pointerup", endAltDrag);
        window.addEventListener("keyup", (e) => { if (e.key === "Alt") endAltDrag(); });
    }

    // -- ギズモレンダラー --
    const gizmoRenderer = new THREE.WebGLRenderer({ canvas: gizmoCanvas, antialias: true, alpha: true });
    gizmoRenderer.setSize(gizmoCanvas.width, gizmoCanvas.height, false);
    gizmoRenderer.setClearColor(0x000000, 0);

    const gizmoScene = new THREE.Scene();
    const gizmoCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 100);

    function makeAxisLabel(text, color) {
        const size = 64;
        const c = document.createElement("canvas");
        c.width = size; c.height = size;
        const ctx = c.getContext("2d");
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 28px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, size / 2, size / 2);
        const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(0.6, 0.6, 0.6);
        return sprite;
    }

    const axisX  = makeAxisLabel("X",  "#e05050"); axisX.position.set( 1.1, 0, 0);
    const axisY  = makeAxisLabel("Y",  "#50c050"); axisY.position.set( 0, 1.1, 0);
    const axisZ  = makeAxisLabel("Z",  "#4080e0"); axisZ.position.set( 0, 0, 1.1);
    const axisXn = makeAxisLabel("-X", "#803030"); axisXn.position.set(-1.1, 0, 0);
    const axisYn = makeAxisLabel("-Y", "#307030"); axisYn.position.set( 0,-1.1, 0);
    const axisZn = makeAxisLabel("-Z", "#204060"); axisZn.position.set( 0, 0,-1.1);
    gizmoScene.add(axisX, axisY, axisZ, axisXn, axisYn, axisZn);

    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false });
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
         0,0,0, 1,0,0,  0,0,0,-1,0,0,
         0,0,0, 0,1,0,  0,0,0, 0,-1,0,
         0,0,0, 0,0,1,  0,0,0, 0,0,-1,
    ]), 3));
    lineGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array([
        1,.3,.3, 1,.3,.3,  .5,.2,.2, .5,.2,.2,
        .3,.8,.3,.3,.8,.3, .2,.4,.2, .2,.4,.2,
        .3,.5,1, .3,.5,1,  .1,.2,.5, .1,.2,.5,
    ]), 3));
    gizmoScene.add(new THREE.LineSegments(lineGeo, lineMat));

    const snapTargets = [
        { sprite: axisX,  dir: new THREE.Vector3( 1, 0, 0) },
        { sprite: axisXn, dir: new THREE.Vector3(-1, 0, 0) },
        { sprite: axisY,  dir: new THREE.Vector3( 0, 1, 0) },
        { sprite: axisYn, dir: new THREE.Vector3( 0,-1, 0) },
        { sprite: axisZ,  dir: new THREE.Vector3( 0, 0, 1) },
        { sprite: axisZn, dir: new THREE.Vector3( 0, 0,-1) },
    ];
    const gizmoRaycaster = new THREE.Raycaster();
    const gizmoMouse = new THREE.Vector2();

    gizmoCanvas.addEventListener("click", (e) => {
        const rect = gizmoCanvas.getBoundingClientRect();
        gizmoMouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
        gizmoMouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
        gizmoRaycaster.setFromCamera(gizmoMouse, gizmoCamera);
        const hits = gizmoRaycaster.intersectObjects(snapTargets.map(t => t.sprite));
        if (!hits.length) return;
        const hit = snapTargets.find(t => t.sprite === hits[0].object);
        if (!hit) return;
        const dist = camera.position.distanceTo(orbit.target);
        camera.position.copy(hit.dir.clone().multiplyScalar(dist).add(orbit.target));
        camera.up.set(0, Math.abs(hit.dir.y) > 0.9 ? 0 : 1, Math.abs(hit.dir.y) > 0.9 ? (hit.dir.y > 0 ? -1 : 1) : 0);
        orbit.update();
    });

    // ---- モデル管理 ----
    let interactableBones = [];
    let loadedModel = null;
    let currentVRM = null;
    let initialPoses = new Map();
    let pointSize = 1.0; // コントロールポイントサイズ倍率

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    function setupModel(model, displayScale) {
        model.traverse((obj) => {
            if (obj.isBone) {
                initialPoses.set(obj, { rot: obj.rotation.clone(), pos: obj.position.clone() });
                const geo = new THREE.SphereGeometry(0.02 * pointSize / displayScale, 16, 16);
                const mat = new THREE.MeshBasicMaterial({ color: 0x0055ff, transparent: true, opacity: 0.7, depthTest: false });
                const hitbox = new THREE.Mesh(geo, mat);
                hitbox.userData.isHitbox = true;
                hitbox.userData.bone = obj;
                hitbox.userData.baseRadius = 0.02 / displayScale;
                obj.add(hitbox);
                interactableBones.push(hitbox);
            }
            if (obj.isMesh || obj.isSkinnedMesh) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                mats.forEach(m => { if (m) m.side = THREE.DoubleSide; });
                obj.frustumCulled = false;
            }
        });
    }

    function clearModel() {
        if (loadedModel) {
            scene.remove(loadedModel);
            if (currentVRM) { VRMUtils.deepDispose(currentVRM.scene); currentVRM = null; }
            loadedModel = null;
        }
        interactableBones = [];
        initialPoses.clear();
    }

    function placeModel(model) {
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const displayScale = 1.8 / maxDim;
        model.scale.set(displayScale, displayScale, displayScale);
        model.position.sub(center.multiplyScalar(displayScale));
        model.position.y += 1.0;
        return displayScale;
    }

    // ---- シェイプキー収集 ----
    // GLTF: morphTargetDictionary から収集
    function collectGltfMorphKeys(model) {
        const keys = [];
        const seen = new Set();
        model.traverse((obj) => {
            if (!(obj.isMesh || obj.isSkinnedMesh)) return;
            if (!obj.morphTargetDictionary) return;
            for (const [name, idx] of Object.entries(obj.morphTargetDictionary)) {
                if (seen.has(name)) continue;
                seen.add(name);
                const mesh = obj; // クロージャでキャプチャ
                const i = idx;
                keys.push({
                    name,
                    getValue: () => mesh.morphTargetInfluences?.[i] ?? 0,
                    setValue: (v) => { if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[i] = v; },
                });
            }
        });
        return keys;
    }

    // VRM: ExpressionManager から収集
    function collectVrmExpressionKeys(vrm) {
        const keys = [];
        const em = vrm.expressionManager;
        if (!em) return keys;
        for (const name of Object.keys(em.expressionMap ?? {})) {
            keys.push({
                name,
                getValue: () => em.getValue(name) ?? 0,
                setValue: (v) => { em.setValue(name, v); },
            });
        }
        return keys;
    }

    (function tryLoadDefaultModel(exts) {
        if (exts.length === 0) return;
        const [ext, ...rest] = exts;
        const url = baseUrl + "model." + ext;
        fetch(url, { method: "HEAD" }).then(res => {
            if (!res.ok) { tryLoadDefaultModel(rest); return; }
            lastLoadedUrl = url;
            lastLoadedIsDefault = true;
            loadVRM(url, undefined);
        }).catch(() => tryLoadDefaultModel(rest));
    })(["glb", "vrm", "gltf"]);

    function loadVRM(url, onComplete) {
        loader.load(url, (gltf) => {
            const vrm = gltf.userData.vrm;
            if (!vrm) {
                console.warn("[PoseEditor3D] Falling back to plain GLTF.");
                clearModel();
                const model = gltf.scene;
                loadedModel = model;
                scene.add(model);
                const displayScale = placeModel(model);
                setupModel(model, displayScale);
                onMorphKeysReady(collectGltfMorphKeys(model));
                if (onComplete) onComplete();
                return;
            }

            clearModel();
            currentVRM = vrm;
            // rotateVRM0は使わない（normalized bone座標系を素のまま使うため）
            const model = vrm.scene;
            loadedModel = model;
            scene.add(model);
            const displayScale = placeModel(model);

            // VRM0はrotateVRM0なしだとZ軸負方向が正面 → カメラをZ軸負方向から見る
            // VRM1はZ軸正方向が正面 → カメラをZ軸正方向から見る（従来通り）
            const isVrm0 = vrm.meta?.metaVersion === '0';
            const camZ = isVrm0 ? -5 : 5;
            camera.position.set(0, 1, camZ);
            camera.lookAt(0, 1, 0);
            orbit.target.set(0, 1, 0);
            orbit.update();

            const humanoid = vrm.humanoid;
            if (humanoid) {
                const vrmBoneNames = [
                    "hips","spine","chest","upperChest","neck","head",
                    "leftEye","rightEye",
                    "leftShoulder","leftUpperArm","leftLowerArm","leftHand",
                    "rightShoulder","rightUpperArm","rightLowerArm","rightHand",
                    "leftUpperLeg","leftLowerLeg","leftFoot","leftToes",
                    "rightUpperLeg","rightLowerLeg","rightFoot","rightToes",
                    "leftThumbMetacarpal","leftThumbProximal","leftThumbDistal",
                    "leftIndexProximal","leftIndexIntermediate","leftIndexDistal",
                    "leftMiddleProximal","leftMiddleIntermediate","leftMiddleDistal",
                    "leftRingProximal","leftRingIntermediate","leftRingDistal",
                    "leftLittleProximal","leftLittleIntermediate","leftLittleDistal",
                    "rightThumbMetacarpal","rightThumbProximal","rightThumbDistal",
                    "rightIndexProximal","rightIndexIntermediate","rightIndexDistal",
                    "rightMiddleProximal","rightMiddleIntermediate","rightMiddleDistal",
                    "rightRingProximal","rightRingIntermediate","rightRingDistal",
                    "rightLittleProximal","rightLittleIntermediate","rightLittleDistal",
                ];
                for (const boneName of vrmBoneNames) {
                    const boneNode = humanoid.getNormalizedBoneNode(boneName);
                    if (!boneNode) continue;
                    initialPoses.set(boneNode, { rot: boneNode.rotation.clone(), pos: boneNode.position.clone() });
                    const geo = new THREE.SphereGeometry(0.02 * pointSize / displayScale, 16, 16);
                    const mat = new THREE.MeshBasicMaterial({ color: 0x0055ff, transparent: true, opacity: 0.7, depthTest: false });
                    const hitbox = new THREE.Mesh(geo, mat);
                    hitbox.userData.isHitbox = true;
                    hitbox.userData.bone = boneNode;
                    hitbox.userData.boneName = boneName;
                    hitbox.userData.baseRadius = 0.02 / displayScale;
                    boneNode.add(hitbox);
                    interactableBones.push(hitbox);
                }
            } else {
                setupModel(model, displayScale);
            }

            onMorphKeysReady(collectVrmExpressionKeys(vrm));
            if (onComplete) onComplete();
        }, undefined, (err) => {
            console.error("[PoseEditor3D] VRM load error:", err);
            if (onComplete) onComplete();
        });
    }

    // ---- ボーンドラッグ回転 ----
    const DRAG_SENSITIVITY = 0.01;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let isDragging = false;
    let draggedBone = null;
    let prevClientX = 0;
    let prevClientY = 0;

    function updateMouse(e) {
        const rect = canvas.getBoundingClientRect();
        mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
        mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    }

    canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        updateMouse(e);
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(interactableBones);
        if (hits.length > 0) {
            isDragging = true;
            draggedBone = hits[0].object.userData.bone;
            prevClientX = e.clientX;
            prevClientY = e.clientY;
            orbit.enabled = false;
        }
    });

    function handleMouseMove(e) {
        if (!isDragging || !draggedBone) return;
        const dx = e.clientX - prevClientX;
        const dy = e.clientY - prevClientY;
        prevClientX = e.clientX;
        prevClientY = e.clientY;
        if (e.altKey) {
            draggedBone.rotation.z -= dy * DRAG_SENSITIVITY;
        } else {
            draggedBone.rotation.y += dx * DRAG_SENSITIVITY;
            draggedBone.rotation.x += dy * DRAG_SENSITIVITY;
        }
    }

    function handleMouseUp() {
        isDragging = false;
        draggedBone = null;
        orbit.enabled = true;
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    // ---- WebGLコンテキストロスト対策 ----
    let lastLoadedBuffer = null; // ユーザー読み込みファイルのArrayBuffer
    let lastLoadedUrl = null;    // デフォルトモデルのURL（fetch可能）
    let lastLoadedIsDefault = true;

    function reloadLastModel() {
        console.log(`[PoseEditor3D] reloadLastModel isDefault=${lastLoadedIsDefault} hasBuffer=${!!lastLoadedBuffer} url=${lastLoadedUrl}`);
        if (!lastLoadedIsDefault && lastLoadedBuffer) {
            const url = URL.createObjectURL(new Blob([lastLoadedBuffer]));
            loadVRM(url, () => URL.revokeObjectURL(url));
        } else if (lastLoadedIsDefault && lastLoadedUrl) {
            loadVRM(lastLoadedUrl, undefined);
        }
    }

    canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
        renderer.setSize(canvas.width, canvas.height, false);
        renderer.setPixelRatio(window.devicePixelRatio);
        reloadLastModel();
    }, false);

    // ---- アニメーションループ ----
    let animFrameId = null;

    function animate() {
        animFrameId = requestAnimationFrame(animate);
        if (renderer.getContext().isContextLost()) return;
        if (currentVRM) currentVRM.update(1 / 60);
        orbit.update();
        renderer.render(scene, camera);

        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        gizmoCamera.position.copy(camDir.clone().negate().multiplyScalar(5));
        gizmoCamera.up.copy(camera.up);
        gizmoCamera.lookAt(0, 0, 0);
        gizmoRenderer.render(gizmoScene, gizmoCamera);
    }
    animate();

    // ---- タブ再表示時にレンダリングを再開 ----
    function onVisibilityChange() {
        if (document.visibilityState === 'visible') {
            if (animFrameId === null) animate();
        }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);


    // ---- 背景PlaneGeometry管理 ----
    let bgMesh = null;
    const bgTextureLoader = new THREE.TextureLoader();

    function loadBgImage(url) {
        bgTextureLoader.load(url, (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            const iw = texture.image.width;
            const ih = texture.image.height;
            // カメラのフラスタムに合わせてPlaneのサイズを決定
            // PerspectiveCamera: Z=-50に置き、その距離でのフラスタム幅に合わせる
            const dist = 50;
            const fovRad = (camera.fov * Math.PI) / 180;
            const planeH = 2 * dist * Math.tan(fovRad / 2);
            const planeW = planeH * (iw / ih);

            if (bgMesh) {
                bgMesh.geometry.dispose();
                bgMesh.material.map?.dispose();
                bgMesh.geometry = new THREE.PlaneGeometry(planeW, planeH);
                bgMesh.material.map = texture;
                bgMesh.material.needsUpdate = true;
            } else {
                const geo = new THREE.PlaneGeometry(planeW, planeH);
                const mat = new THREE.MeshBasicMaterial({ map: texture });
                bgMesh = new THREE.Mesh(geo, mat);
                bgMesh.position.set(0, 0, -dist);
                scene.add(bgMesh);
            }
        });
    }

    function clearBgImage() {
        if (bgMesh) {
            bgMesh.geometry.dispose();
            bgMesh.material.map?.dispose();
            bgMesh.material.dispose();
            scene.remove(bgMesh);
            bgMesh = null;
        }
    }

    return {
        loadBgImage,
        clearBgImage,

        capture() {
            interactableBones.forEach(h => h.visible = false);
            if (currentVRM) currentVRM.update(0);
            renderer.render(scene, camera);
            const data = canvas.toDataURL("image/png");
            interactableBones.forEach(h => h.visible = true);
            return data;
        },
        resetPose() {
            initialPoses.forEach((val, bone) => {
                bone.rotation.copy(val.rot);
                bone.position.copy(val.pos);
            });
        },
        resetCamera() {
            const isVrm0 = currentVRM?.meta?.metaVersion === '0';
            const camZ = isVrm0 ? -5 : 5;
            camera.position.set(0, 1, camZ);
            camera.up.set(0, 1, 0);
            orbit.target.set(0, 1, 0);
            orbit.update();
        },
        loadVRM,
        loadVRMFromBuffer(buffer, url, onComplete) {
            lastLoadedBuffer = buffer;
            lastLoadedIsDefault = false;
            loadVRM(url, onComplete);
        },
        setPointSize(scale) {
            pointSize = scale;
            interactableBones.forEach(h => {
                const base = h.userData.baseRadius ?? 0.02;
                h.geometry.dispose();
                h.geometry = new THREE.SphereGeometry(base * scale, 16, 16);
            });
        },
        exportPose() {
            if (!loadedModel) return null;
            const data = {};
            interactableBones.forEach(h => {
                const bone = h.userData.bone;
                const key = h.userData.boneName ?? bone.name;
                if (!key) return;
                const q = bone.quaternion;
                data[key] = { qx: q.x, qy: q.y, qz: q.z, qw: q.w };
            });
            const vrmVer = currentVRM?.meta?.metaVersion ?? null;
            return JSON.stringify({ version: 2, vrmVersion: vrmVer, bones: data }, null, 2);
        },
        importPose(jsonStr) {
            const parsed = JSON.parse(jsonStr);

            // ---- .vroidpose形式 ----
            if (parsed.BoneDefinition) {
                const VROID_TO_VRM = {
                    'Hips':           'hips',
                    'Spine':          'spine',
                    'Chest':          'chest',
                    'UpperChest':     'upperChest',
                    'Neck':           'neck',
                    'Head':           'head',
                    'LeftShoulder':   'leftShoulder',
                    'LeftUpperArm':   'leftUpperArm',
                    'LeftLowerArm':   'leftLowerArm',
                    'LeftHand':       'leftHand',
                    'RightShoulder':  'rightShoulder',
                    'RightUpperArm':  'rightUpperArm',
                    'RightLowerArm':  'rightLowerArm',
                    'RightHand':      'rightHand',
                    'LeftUpperLeg':   'leftUpperLeg',
                    'LeftLowerLeg':   'leftLowerLeg',
                    'LeftFoot':       'leftFoot',
                    'LeftToes':       'leftToes',
                    'RightUpperLeg':  'rightUpperLeg',
                    'RightLowerLeg':  'rightLowerLeg',
                    'RightFoot':      'rightFoot',
                    'RightToes':      'rightToes',
                };
                // VRoidのrest poseとVRM normalized rest poseのずれを補正するX軸オフセット（度数）
                const BONE_CORRECTION_X = {
                    Spine: 10, Chest: -18, UpperChest: -9, Neck: 15, Head: 0,
                    LeftUpperLeg: 2, RightUpperLeg: 2,
                    LeftShoulder: 16, RightShoulder: 16,
                };
                const bd = parsed.BoneDefinition;
                // boneMapはVRM以外（GLB等）のフォールバック用
                const boneMap = {};
                interactableBones.forEach(h => {
                    const key = h.userData.boneName ?? h.userData.bone.name;
                    if (key) boneMap[key] = h.userData.bone;
                });
                const isVrm0 = currentVRM?.meta?.metaVersion === '0';
                // VRM1用の補正値（VRM0とrest poseが異なるため別途調整）
                const BONE_CORRECTION_X_VRM1 = {
                    Spine: -10, Chest: 18, UpperChest: 9, Neck: -15, Head: 0,
                    LeftUpperLeg: -2, RightUpperLeg: -2,
                    LeftShoulder: -16, RightShoulder: -16,
                };
                const activeBoneCorrection = isVrm0 ? BONE_CORRECTION_X : BONE_CORRECTION_X_VRM1;
                for (const [vroidKey, vrmKey] of Object.entries(VROID_TO_VRM)) {
                    const r = bd[vroidKey];
                    if (!r) continue;
                    // VRMモデルの場合はgetNormalizedBoneNodeで直接取得
                    const node = currentVRM
                        ? currentVRM.humanoid.getNormalizedBoneNode(vrmKey)
                        : boneMap[vrmKey];
                    if (!node) continue;
                    // Unity左手系 → Three.js右手系の変換
                    // VRM0式で変換後、VRM1の場合はVRM0→VRM1変換(x,-y,z,-w)を適用
                    const base = new THREE.Quaternion(r.x, r.y, -r.z, -r.w).normalize();
                    if (!isVrm0) {
                        base.set(base.x, -base.y, base.z, -base.w).normalize();
                    }
                    const corrDeg = activeBoneCorrection[vroidKey];
                    if (corrDeg) {
                        const corr = new THREE.Quaternion().setFromEuler(
                            new THREE.Euler(THREE.MathUtils.degToRad(corrDeg), 0, 0)
                        );
                        corr.premultiply(base); // base * corr
                        node.quaternion.copy(corr);
                    } else {
                        node.quaternion.copy(base);
                    }
                }
                if (currentVRM) {
                    currentVRM.humanoid.update();
                    currentVRM.scene.updateMatrixWorld(true);
                }
                return;
            }

            // ---- gaoo.json形式（クォータニオン {rotation:[x,y,z,w]}） ----
            const isQuatFormat = Object.values(parsed).some(v => Array.isArray(v?.rotation));
            if (isQuatFormat) {
                const q = new THREE.Quaternion();
                interactableBones.forEach(h => {
                    const bone = h.userData.bone;
                    const key = h.userData.boneName ?? bone.name;
                    if (!key || !parsed[key]?.rotation) return;
                    const r = parsed[key].rotation;
                    q.set(r[0], r[1], r[2], r[3]);
                    bone.rotation.setFromQuaternion(q);
                });
                return;
            }

            // ---- 自前exportPose形式 version2（クォータニオン + vrmVersionタグ） ----
            if (parsed.version === 2 && parsed.bones) {
                const savedVrmVer = parsed.vrmVersion;
                const curVrmVer   = currentVRM?.meta?.metaVersion ?? null;
                const needConvert = savedVrmVer !== null && curVrmVer !== null && savedVrmVer !== curVrmVer;
                const q = new THREE.Quaternion();
                interactableBones.forEach(h => {
                    const bone = h.userData.bone;
                    const key  = h.userData.boneName ?? bone.name;
                    const bd   = parsed.bones[key];
                    if (!key || !bd) return;
                    q.set(bd.qx, bd.qy, bd.qz, bd.qw);
                    if (needConvert) {
                        // VRM0↔VRM1間の変換: Y軸とWを反転
                        q.set(q.x, -q.y, q.z, -q.w).normalize();
                    }
                    bone.quaternion.copy(q);
                });
                if (currentVRM) {
                    currentVRM.humanoid.update();
                    currentVRM.scene.updateMatrixWorld(true);
                }
                return;
            }

            // ---- 自前exportPose旧形式（オイラー角 version1） ----
            const bones = parsed.bones ?? parsed;
            interactableBones.forEach(h => {
                const bone = h.userData.bone;
                const key = h.userData.boneName ?? bone.name;
                if (!key || !bones[key]) return;
                bone.rotation.x = bones[key].x ?? 0;
                bone.rotation.y = bones[key].y ?? 0;
                bone.rotation.z = bones[key].z ?? 0;
            });
        },
        setColorCorrect(enabled) {
            renderer.outputColorSpace    = enabled ? THREE.SRGBColorSpace       : THREE.LinearSRGBColorSpace;
            renderer.toneMapping         = enabled ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
            renderer.toneMappingExposure = 1.0;
            scene.traverse((obj) => {
                if (obj.isMesh || obj.isSkinnedMesh) {
                    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                    mats.forEach(m => { if (m) m.needsUpdate = true; });
                }
            });
        },
        _handleMouseMove: handleMouseMove,
        _handleMouseUp:   handleMouseUp,
        dispose() {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup',   handleMouseUp);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (animFrameId !== null) { cancelAnimationFrame(animFrameId); animFrameId = null; }
            clearBgImage();
            renderer.dispose();
            gizmoRenderer.dispose();
        },
    };
}
