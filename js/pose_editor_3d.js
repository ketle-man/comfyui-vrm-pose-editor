import { app } from "../../scripts/app.js";
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from './vendor/three-vrm.module.js';

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
                for (const name of ["image_data", "output_size_mode", "custom_width", "custom_height", "preview"]) {
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
            btnRow.appendChild(vrmInput);
            btnRow.appendChild(bgInput);
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

            morphPanel.appendChild(morphHeader);
            morphPanel.appendChild(morphBody);
            container.appendChild(morphPanel);

            // ノードサイズ動的更新
            function updateNodeSize() {
                const baseH  = 520;
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
                    return [410, 460 + morphH];
                },
            });

            node.size = [430, 520];
            node.resizable = false;
            node.onResize = function () {
                const morphH = morphOpen ? Math.min((morphBody.children.length || 1) * 26 + 12, 172) : 0;
                this.size = [430, 520 + morphH];
            };

            // ---- 3Dエディタ初期化 ----
            const baseUrl = new URL(".", import.meta.url).href;
            const editor = initPoseEditor3D(cvs, gizmoCvs, baseUrl, rebuildMorphSliders);

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
                vrmLabel.textContent = file.name.slice(0, 20) + (file.name.length > 20 ? "…" : "");
                vrmBtn.textContent = "⏳";
                vrmBtn.style.background = "#888";
                const url = URL.createObjectURL(file);
                editor.loadVRM(url, () => {
                    URL.revokeObjectURL(url);
                    vrmBtn.textContent = "VRM";
                    vrmBtn.style.background = "#7a5a9a";
                });
                vrmInput.value = "";
            });


            // ---- ノード削除時のクリーンアップ ----
            node.onRemoved = function () {
                editor.dispose();
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
function initPoseEditor3D(canvas, gizmoCanvas, baseUrl, onMorphKeysReady) {

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

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    function setupModel(model, displayScale) {
        model.traverse((obj) => {
            if (obj.isBone) {
                initialPoses.set(obj, { rot: obj.rotation.clone(), pos: obj.position.clone() });
                const geo = new THREE.SphereGeometry(0.02 / displayScale, 16, 16);
                const mat = new THREE.MeshBasicMaterial({ color: 0x0055ff, transparent: true, opacity: 0.7, depthTest: false });
                const hitbox = new THREE.Mesh(geo, mat);
                hitbox.userData.isHitbox = true;
                hitbox.userData.bone = obj;
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
            VRMUtils.rotateVRM0(vrm);
            const model = vrm.scene;
            loadedModel = model;
            scene.add(model);
            const displayScale = placeModel(model);

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
                    const geo = new THREE.SphereGeometry(0.02 / displayScale, 16, 16);
                    const mat = new THREE.MeshBasicMaterial({ color: 0x0055ff, transparent: true, opacity: 0.7, depthTest: false });
                    const hitbox = new THREE.Mesh(geo, mat);
                    hitbox.userData.isHitbox = true;
                    hitbox.userData.bone = boneNode;
                    hitbox.userData.boneName = boneName;
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

    // ---- アニメーションループ ----
    function animate() {
        requestAnimationFrame(animate);
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
            camera.position.set(0, 1, 5);
            camera.up.set(0, 1, 0);
            orbit.target.set(0, 1, 0);
            orbit.update();
        },
        loadVRM,
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
            clearBgImage();
            renderer.dispose();
            gizmoRenderer.dispose();
        },
    };
}
