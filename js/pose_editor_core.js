// pose_editor_core.js — pose_editor_3d.js から ComfyUI 非依存のコアロジックのみを切り出したモジュール
// ComfyUIノード(pose_editor_3d.js)・外部ページ(SPA等)の両方から import して利用できる

import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from './vendor/three-vrm.module.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from './vendor/three-vrm-animation.module.js';

// ---- Three.js エディタ本体 ----
export function initPoseEditor3D(canvas, gizmoCanvas, baseUrl, onMorphKeysReady, isModern, onModelReady) {

    // -- メインレンダラー --
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(canvas.width, canvas.height, false);

    // ---- スーパーサンプリング（アンチエイリアス強化）----
    // WebGLコンテキストのMSAA(antialias:true)だけでは、Light EditorのプレビューのようにCSS
    // transform:scale()で拡大表示するケースで輪郭が荒く見える（ラスターを単純拡大するため）。
    // devicePixelRatioを底上げして実解像度を上げることで緩和する。ON/OFFはlocalStorageに永続化し、
    // 3Dテキスト側(text3d-core.js)と同じキーを共有する（どちらで切り替えても連動する）。
    const _SUPERSAMPLE_STORAGE_KEY = 'vrmPoseEditor_superSample';
    function _loadSuperSample() {
        try { return localStorage.getItem(_SUPERSAMPLE_STORAGE_KEY) === '1'; } catch (e) { return false; }
    }
    let _superSample = _loadSuperSample();
    function _applyPixelRatio() {
        const base = window.devicePixelRatio || 1;
        // setPixelRatio()内部で現在のwidth/heightを使ってsetSize()が再実行されるため、
        // ここで改めてrenderer.setSize()を呼ぶ必要はない
        renderer.setPixelRatio(_superSample ? Math.min(base * 2, 4) : base);
    }
    _applyPixelRatio();

    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const perspCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    perspCamera.position.set(0, 1, 5);
    perspCamera.lookAt(0, 1, 0);

    const orthoCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 1000);
    orthoCamera.position.set(0, 1, 5);
    orthoCamera.lookAt(0, 1, 0);

    let isOrtho = false;
    let camera = perspCamera;

    // Perspective カメラの画角(FOV)を変更する。Ortho 表示中は見た目のサイズも追随させる
    function setFov(deg) {
        perspCamera.fov = Math.min(170, Math.max(1, deg));
        perspCamera.updateProjectionMatrix();
        if (isOrtho) switchCamera(true);
    }

    // ニアクリップ面を変更する（Perspective/Ortho両カメラに適用）
    function setNear(v) {
        const n = Math.min(perspCamera.far - 0.01, Math.max(0.001, v));
        perspCamera.near = n;
        perspCamera.updateProjectionMatrix();
        orthoCamera.near = n;
        orthoCamera.updateProjectionMatrix();
    }

    // Perspective ↔ Orthographic 切り替え
    // Ortho のサイズは「現在のカメラ距離 × tan(fov/2)」で Perspective と同じ高さに合わせる
    function switchCamera(toOrtho) {
        const dist = camera.position.distanceTo(orbit.target);
        if (toOrtho) {
            const halfH = dist * Math.tan((perspCamera.fov / 2) * Math.PI / 180);
            orthoCamera.left   = -halfH;
            orthoCamera.right  =  halfH;
            orthoCamera.top    =  halfH;
            orthoCamera.bottom = -halfH;
            orthoCamera.updateProjectionMatrix();
            orthoCamera.position.copy(perspCamera.position);
            orthoCamera.quaternion.copy(perspCamera.quaternion);
            orthoCamera.up.copy(perspCamera.up);
        } else {
            perspCamera.position.copy(orthoCamera.position);
            perspCamera.quaternion.copy(orthoCamera.quaternion);
            perspCamera.up.copy(orthoCamera.up);
        }
        isOrtho = toOrtho;
        camera = toOrtho ? orthoCamera : perspCamera;
        orbit.object = camera;
        orbit.update();
    }

    // ================================================================
    // Managed light system
    // ================================================================
    // RectAreaLight requires UniformsLib init (if available in vendor bundle)
    if (THREE.RectAreaLightUniformsLib) THREE.RectAreaLightUniformsLib.init();

    let nextLightId = 0;
    const managedLights = []; // { id, config, threeLight, helperMesh }

    function _hexToColor(hex) { return new THREE.Color(hex); }

    function _createThreeLight(cfg) {
        let light;
        const col = _hexToColor(cfg.color);
        switch (cfg.type) {
            case "directional":
                light = new THREE.DirectionalLight(col, cfg.intensity);
                light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
                light.target.position.set(cfg.target.x, cfg.target.y, cfg.target.z);
                scene.add(light.target);
                if (cfg.castShadow) {
                    light.castShadow = true;
                    light.shadow.mapSize.width = light.shadow.mapSize.height = 2048;
                    light.shadow.camera.near = 0.1; light.shadow.camera.far = 100;
                    light.shadow.camera.left = light.shadow.camera.bottom = -8;
                    light.shadow.camera.right = light.shadow.camera.top = 8;
                }
                break;
            case "point":
                light = new THREE.PointLight(col, cfg.intensity, cfg.distance ?? 0, cfg.decay ?? 1);
                light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
                // PointLight/SpotLight castShadow not supported: VRM MToon shader lacks vPointShadowCoord/vSpotShadowCoord varyings
                break;
            case "spot":
                light = new THREE.SpotLight(col, cfg.intensity, cfg.distance ?? 0, cfg.angle ?? Math.PI / 6, cfg.penumbra ?? 0.1, cfg.decay ?? 1);
                light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
                light.target.position.set(cfg.target.x, cfg.target.y, cfg.target.z);
                scene.add(light.target);
                // SpotLight castShadow not supported: VRM MToon shader lacks vSpotShadowCoord varying
                break;
            case "rect":
                light = new THREE.RectAreaLight(col, cfg.intensity, cfg.width ?? 2, cfg.height ?? 2);
                light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
                light.lookAt(cfg.target.x, cfg.target.y, cfg.target.z);
                break;
            case "ambient":
            default:
                light = new THREE.AmbientLight(col, cfg.intensity);
                break;
        }
        light.visible = cfg.enabled !== false;
        return light;
    }

    function _createHelperMesh(cfg) {
        if (cfg.type === "ambient") return null;
        const geo = new THREE.SphereGeometry(0.07, 12, 12);
        const mat = new THREE.MeshBasicMaterial({ color: _hexToColor(cfg.color), depthTest: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
        mesh.userData.isLightHelper = true;
        mesh.userData.lightId = cfg.id;
        mesh.renderOrder = 100;
        mesh.visible = false; // hidden unless editor open
        return mesh;
    }

    function _addManagedLight(config) {
        const id = nextLightId++;
        const cfg = {
            id,
            name:      config.name      ?? `Light ${id + 1}`,
            type:      config.type      ?? "directional",
            color:     config.color     ?? "#ffffff",
            intensity: config.intensity ?? 1.0,
            position:  { x: 2, y: 4, z: 3, ...(config.position ?? {}) },
            target:    { x: 0, y: 1, z: 0, ...(config.target   ?? {}) },
            angle:     config.angle     ?? Math.PI / 6,
            penumbra:  config.penumbra  ?? 0.1,
            decay:     config.decay     ?? 1,
            distance:  config.distance  ?? 0,
            width:     config.width     ?? 2,
            height:    config.height    ?? 2,
            castShadow: config.castShadow ?? false,
            enabled:   config.enabled   !== false,
        };
        const threeLight = _createThreeLight(cfg);
        scene.add(threeLight);
        const helperMesh = _createHelperMesh(cfg);
        if (helperMesh) scene.add(helperMesh);
        managedLights.push({ id, config: cfg, threeLight, helperMesh });
        return cfg;
    }

    function _removeManagedLight(id) {
        const idx = managedLights.findIndex(l => l.id === id);
        if (idx < 0) return;
        const { threeLight, helperMesh } = managedLights[idx];
        scene.remove(threeLight);
        if (threeLight.target) scene.remove(threeLight.target);
        threeLight.dispose?.();
        if (helperMesh) {
            scene.remove(helperMesh);
            helperMesh.geometry.dispose();
            helperMesh.material.dispose();
        }
        managedLights.splice(idx, 1);
    }

    function _updateManagedLight(id, changes) {
        const entry = managedLights.find(l => l.id === id);
        if (!entry) return;
        const cfg = entry.config;

        const typeChanged = changes.type && changes.type !== cfg.type;
        Object.assign(cfg, changes);

        if (typeChanged) {
            scene.remove(entry.threeLight);
            if (entry.threeLight.target) scene.remove(entry.threeLight.target);
            entry.threeLight.dispose?.();
            if (entry.helperMesh) { scene.remove(entry.helperMesh); entry.helperMesh.geometry.dispose(); entry.helperMesh.material.dispose(); }
            entry.threeLight = _createThreeLight(cfg);
            scene.add(entry.threeLight);
            entry.helperMesh = _createHelperMesh(cfg);
            if (entry.helperMesh) scene.add(entry.helperMesh);
            return;
        }

        const tl = entry.threeLight;
        if (changes.color     !== undefined) { tl.color.set(changes.color); if (entry.helperMesh && !entry.helperMesh.userData.selected) entry.helperMesh.material.color.set(changes.color); }
        if (changes.intensity !== undefined) tl.intensity = cfg.intensity;
        if (changes.enabled   !== undefined) tl.visible = cfg.enabled;
        if (changes.position  !== undefined) {
            tl.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
            if (entry.helperMesh) entry.helperMesh.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
        }
        if (changes.target    !== undefined && tl.target) tl.target.position.set(cfg.target.x, cfg.target.y, cfg.target.z);
        if (changes.angle     !== undefined && tl.isSpotLight) tl.angle = cfg.angle;
        if (changes.penumbra  !== undefined && tl.isSpotLight) tl.penumbra = cfg.penumbra;
        if (changes.decay     !== undefined && (tl.isSpotLight || tl.isPointLight)) tl.decay = cfg.decay;
        if (changes.distance  !== undefined && (tl.isSpotLight || tl.isPointLight)) tl.distance = cfg.distance;
        if (changes.castShadow !== undefined && tl.isDirectionalLight) {
            // Only DirectionalLight supports shadows with VRM MToon shader
            tl.castShadow = cfg.castShadow;
            if (cfg.castShadow && tl.shadow) {
                tl.shadow.mapSize.width = tl.shadow.mapSize.height = 2048;
                tl.shadow.camera.left = tl.shadow.camera.bottom = -8;
                tl.shadow.camera.right = tl.shadow.camera.top = 8;
                tl.shadow.camera.far = 100;
                tl.shadow.needsUpdate = true;
            }
        }
        if (changes.width  !== undefined && tl.isRectAreaLight) tl.width  = cfg.width;
        if (changes.height !== undefined && tl.isRectAreaLight) tl.height = cfg.height;
    }

    // Default lights (ambient + directional sun)
    _addManagedLight({ name: "Ambient", type: "ambient",      color: "#ffffff", intensity: 0.7,  enabled: true });
    _addManagedLight({ name: "Sun",     type: "directional",  color: "#ffffff", intensity: 2.0,  position: { x: 2, y: 4, z: 3 }, target: { x: 0, y: 1, z: 0 }, castShadow: true, enabled: true });

    // ================================================================
    // Ground plane
    // ================================================================
    let groundMesh = null;
    let _groundVisible = false;
    let _groundY = 0;
    let _groundColor = "#555555";
    let _groundTex   = null; // THREE.Texture
    let _groundTexRepeat = 1;
    let _groundShadowCatcher = false;
    let _groundShadowOpacity = 0.5;

    function _makeSurfaceMat(color, tex, repeat) {
        const mat = new THREE.MeshStandardMaterial({
            color: _hexToColor(color),
            roughness: 1.0, metalness: 0.0,
            transparent: false,
            map: tex ?? null,
        });
        if (tex) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat, repeat); }
        return mat;
    }

    function _setGroundVisible(v) {
        _groundVisible = v;
        if (v && !groundMesh) {
            groundMesh = new THREE.Mesh(
                new THREE.PlaneGeometry(20, 20),
                _makeSurfaceMat(_groundColor, _groundTex, _groundTexRepeat)
            );
            groundMesh.rotation.x = -Math.PI / 2;
            groundMesh.position.y = _groundY;
            groundMesh.receiveShadow = true;
            scene.add(groundMesh);
        } else if (groundMesh) {
            groundMesh.visible = v;
        }
    }

    function _setGroundY(y)        { _groundY = y; if (groundMesh) groundMesh.position.y = y; if (bgWallMesh) bgWallMesh.position.y = y + 10; }
    function _setGroundColor(hex)  { _groundColor = hex; if (groundMesh && !_groundShadowCatcher) { groundMesh.material.color.set(hex); groundMesh.material.needsUpdate = true; } }
    function _setGroundTexture(url) {
        new THREE.TextureLoader().load(url, tex => {
            if (_groundTex) _groundTex.dispose();
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(_groundTexRepeat, _groundTexRepeat);
            _groundTex = tex;
            if (groundMesh && !_groundShadowCatcher) { groundMesh.material.map = tex; groundMesh.material.needsUpdate = true; }
        });
    }
    function _clearGroundTexture() {
        if (_groundTex) { _groundTex.dispose(); _groundTex = null; }
        if (groundMesh && !_groundShadowCatcher) { groundMesh.material.map = null; groundMesh.material.needsUpdate = true; }
    }
    function _setGroundTexRepeat(n) {
        _groundTexRepeat = n;
        if (_groundTex) { _groundTex.repeat.set(n, n); _groundTex.needsUpdate = true; }
    }
    function _setGroundShadowCatcher(enabled) {
        _groundShadowCatcher = enabled;
        if (!groundMesh) return;
        groundMesh.material.dispose();
        groundMesh.material = enabled
            ? new THREE.ShadowMaterial({ opacity: _groundShadowOpacity, transparent: true })
            : _makeSurfaceMat(_groundColor, _groundTex, _groundTexRepeat);
    }
    function _setGroundShadowOpacity(v) {
        _groundShadowOpacity = v;
        if (_groundShadowCatcher && groundMesh) { groundMesh.material.opacity = v; groundMesh.material.needsUpdate = true; }
    }

    // ================================================================
    // Background wall
    // ================================================================
    let bgWallMesh = null;
    let _bgWallVisible = false;
    let _bgWallZ = -2;
    let _bgWallColor = "#666666";
    let _bgWallTex   = null;
    let _bgWallTexRepeat = 1;
    let _bgWallShadowCatcher = false;
    let _bgWallShadowOpacity = 0.5;

    function _setBgWallVisible(v) {
        _bgWallVisible = v;
        if (v && !bgWallMesh) {
            bgWallMesh = new THREE.Mesh(
                new THREE.PlaneGeometry(20, 20),
                _makeSurfaceMat(_bgWallColor, _bgWallTex, _bgWallTexRepeat)
            );
            bgWallMesh.position.set(0, _groundY + 10, _bgWallZ);
            bgWallMesh.receiveShadow = true;
            scene.add(bgWallMesh);
        } else if (bgWallMesh) {
            bgWallMesh.visible = v;
        }
    }

    function _setBgWallZ(z)          { _bgWallZ = z; if (bgWallMesh) bgWallMesh.position.z = z; }
    function _setBgWallColor(hex)    { _bgWallColor = hex; if (bgWallMesh && !_bgWallShadowCatcher) { bgWallMesh.material.color.set(hex); bgWallMesh.material.needsUpdate = true; } }
    function _setBgWallTexture(url)  {
        new THREE.TextureLoader().load(url, tex => {
            if (_bgWallTex) _bgWallTex.dispose();
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(_bgWallTexRepeat, _bgWallTexRepeat);
            _bgWallTex = tex;
            if (bgWallMesh && !_bgWallShadowCatcher) { bgWallMesh.material.map = tex; bgWallMesh.material.needsUpdate = true; }
        });
    }
    function _clearBgWallTexture()   {
        if (_bgWallTex) { _bgWallTex.dispose(); _bgWallTex = null; }
        if (bgWallMesh && !_bgWallShadowCatcher) { bgWallMesh.material.map = null; bgWallMesh.material.needsUpdate = true; }
    }
    function _setBgWallTexRepeat(n)  {
        _bgWallTexRepeat = n;
        if (_bgWallTex) { _bgWallTex.repeat.set(n, n); _bgWallTex.needsUpdate = true; }
    }
    function _setBgWallShadowCatcher(enabled) {
        _bgWallShadowCatcher = enabled;
        if (!bgWallMesh) return;
        bgWallMesh.material.dispose();
        bgWallMesh.material = enabled
            ? new THREE.ShadowMaterial({ opacity: _bgWallShadowOpacity, transparent: true })
            : _makeSurfaceMat(_bgWallColor, _bgWallTex, _bgWallTexRepeat);
    }
    function _setBgWallShadowOpacity(v) {
        _bgWallShadowOpacity = v;
        if (_bgWallShadowCatcher && bgWallMesh) { bgWallMesh.material.opacity = v; bgWallMesh.material.needsUpdate = true; }
    }

    // ================================================================
    // LookAt target (視線ターゲット): VRMLookAt を利用した視線誘導
    // ================================================================
    // three-vrm.module.js には VRMLookAt が同梱されており、VRMLoaderPlugin
    // でロードした vrm には常に vrm.lookAt が生成される（表情ベース/ボーンベース
    // いずれの場合も）。ここではドラッグ可能な3Dマーカーを vrm.lookAt.target に
    // 割り当てることで、目・頭がマーカーの方向を自動追従するようにする。
    const lookAtHelperMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x00d0d0, transparent: true, opacity: 0.85, depthTest: false })
    );
    lookAtHelperMesh.renderOrder = 100;
    lookAtHelperMesh.visible = false;
    lookAtHelperMesh.position.set(0, 1.5, 2);
    scene.add(lookAtHelperMesh);
    let _lookAtEnabled = false;

    function _setLookAtEnabled(v) {
        _lookAtEnabled = v;
        lookAtHelperMesh.visible = v;
        if (currentVRM?.lookAt) {
            if (_vrmaMixer) return; // VRMA再生中はlookAt.targetをnullのまま維持（_clearVRMA()が復元を担当）
            currentVRM.lookAt.target = v ? lookAtHelperMesh : null;
            if (!v) currentVRM.lookAt.reset();
        }
    }

    // ================================================================
    // Spring bone physics（揺れ物理）
    // ================================================================
    // VRMLoaderPlugin は springBonePlugin を内包しており、VRMアセット自体に
    // 定義された揺れボーン(髪・スカート等)は vrm.springBoneManager として
    // 既に生成済み。VRM.update(delta) が毎フレーム自動的に物理を進めるため、
    // 実装済みの機構を配線するのみでよい。
    // - ポーズを瞬間的に切り替える操作(リセット/読込/ミラー)の直後は、
    //   揺れボーンの内部状態が旧ポーズのままになり「一瞬跳ねる」ため、
    //   setInitState() で新しいボーン位置を基準として再アンカーする。
    // - 物理のON/OFFは update(delta) の delta を 0 にすることで実現する
    //   （capture() で既に使われている「delta=0=一時停止」と同じ手法）。
    let _springBoneEnabled = true;

    function _settleSpringBoneAnchor() {
        currentVRM?.springBoneManager?.setInitState();
    }

    // ================================================================
    // Wind physics（風エフェクト・そよ風）
    // ================================================================
    // three-vrmには風専用のAPIが存在しないため、VRMSpringBoneJointが公開している
    // settings.gravityDir / settings.gravityPower（ミュータブルなプレーンオブジェクト）を
    // 毎フレーム動的に上書きし、「モデル本来の重力ベクトル + 時間変動する風ベクトル」の
    // 合成結果を注入することで実現する（vendorのthree-vrm.module.jsは無改造）。
    // Spring Bone物理自体がOFF(delta=0)の間はVRMSpringBoneJoint.update()が即returnして
    // gravityDir/gravityPowerを読まないため、風は自動的に無効化される。
    let _windEnabled = false;
    let _windStrength = 1.0;    // gravityPowerと同スケールの無次元値
    let _windDirectionDeg = 0;  // 水平面の風向き(度数)。0°=ワールド+Z方向、90°=+X方向
    let _windTurbulence = 0.4;  // そよぎの度合い 0(一定風)〜1(強いガスト)

    // joint -> { dir: THREE.Vector3, power: number }  ロード時点の「本来の重力設定」
    const _origJointGravity = new Map();
    let _windWasApplied = false; // 直前フレームで風を適用していたか(OFF定常状態での書き込み省略用)
    const _windTmpVecA = new THREE.Vector3();
    const _windTmpVecB = new THREE.Vector3();

    function _captureOriginalJointGravity() {
        _origJointGravity.clear();
        const joints = currentVRM?.springBoneManager?.joints;
        if (!joints) return;
        joints.forEach(joint => {
            _origJointGravity.set(joint, {
                dir: joint.settings.gravityDir.clone(),
                power: joint.settings.gravityPower,
            });
        });
    }

    // 風ベクトル（ワールド空間・水平面、gravityDir*gravityPowerと同スケール）を計算
    function _computeWindVector(t, out) {
        // 強さのゆらぎ(ガスト): 周期の異なる3つのsin波を重ねる(合計振幅1.0で正規化)
        const gust =
            0.55 * Math.sin(2 * Math.PI * t / 6.7) +
            0.30 * Math.sin(2 * Math.PI * t / 2.3 + 1.7) +
            0.15 * Math.sin(2 * Math.PI * t / 0.9 + 4.1);
        const strength = Math.max(0, _windStrength * (1 + _windTurbulence * gust));

        // 向きのゆらぎ(そよぎ): ガストより長い周期で±18°、短い周期で±7°揺れる
        const swayDeg =
            18 * Math.sin(2 * Math.PI * t / 5.3 + 0.6) +
            7  * Math.sin(2 * Math.PI * t / 1.6 + 2.9);
        const angleRad = (_windDirectionDeg + _windTurbulence * swayDeg) * Math.PI / 180;

        return out.set(Math.sin(angleRad), 0, Math.cos(angleRad)).multiplyScalar(strength);
    }

    // ---- 風の発生源マーカー(視線(LookAt)と同様にドラッグ可能な3Dオブジェクトで向きを指定) ----
    // モデル非依存の固定基準点方式: マーカー位置 → _windSourceRefPoint への方向を風向きとして使う。
    const _windSourceRefPoint = new THREE.Vector3(0, 1, 0); // orbit.targetと同じ固定基準点
    const _windWorldUp = new THREE.Vector3(0, 1, 0);
    const _windAxisAlt = new THREE.Vector3(1, 0, 0); // baseDirがほぼ垂直な時のフォールバック軸

    const windSourceHelperGeo = new THREE.ConeGeometry(0.08, 0.26, 16);
    windSourceHelperGeo.rotateX(-Math.PI / 2); // 先端がローカル-Z方向を向くようにし、lookAt()で基準点を指せるようにする
    const windSourceHelperMesh = new THREE.Mesh(
        windSourceHelperGeo,
        new THREE.MeshBasicMaterial({ color: 0xff8c00, transparent: true, opacity: 0.85, depthTest: false })
    );
    windSourceHelperMesh.renderOrder = 100;
    windSourceHelperMesh.visible = false;
    windSourceHelperMesh.position.set(2, 1.5, 0); // 風上側の横位置(横風になり効果が視認しやすい)
    windSourceHelperMesh.lookAt(_windSourceRefPoint);
    scene.add(windSourceHelperMesh);
    let _windSourceEnabled = false;

    function _setWindSourceEnabled(v) {
        _windSourceEnabled = v;
        windSourceHelperMesh.visible = v;
    }

    const _windTmpVecC = new THREE.Vector3();
    const _windTmpRight = new THREE.Vector3();
    const _windTmpUp = new THREE.Vector3();
    const _windTmpQuat = new THREE.Quaternion();

    // 発生源マーカーからの風ベクトルを計算(強さのガストは_computeWindVectorと同じ式を再利用し、
    // 向きのそよぎは「baseDirに直交する疑似上軸まわりの回転」として一般化する)
    function _computeWindVectorFromSource(t, out) {
        const gust =
            0.55 * Math.sin(2 * Math.PI * t / 6.7) +
            0.30 * Math.sin(2 * Math.PI * t / 2.3 + 1.7) +
            0.15 * Math.sin(2 * Math.PI * t / 0.9 + 4.1);
        const strength = Math.max(0, _windStrength * (1 + _windTurbulence * gust));

        _windTmpVecC.subVectors(_windSourceRefPoint, windSourceHelperMesh.position);
        const baseLen = _windTmpVecC.length();
        if (baseLen < 1e-6) return out.set(0, 0, 0);
        const baseDir = _windTmpVecC.multiplyScalar(1 / baseLen);

        const upRef = Math.abs(baseDir.y) > 0.99 ? _windAxisAlt : _windWorldUp;
        _windTmpRight.crossVectors(upRef, baseDir).normalize();
        _windTmpUp.crossVectors(baseDir, _windTmpRight).normalize();

        const swayDeg =
            18 * Math.sin(2 * Math.PI * t / 5.3 + 0.6) +
            7  * Math.sin(2 * Math.PI * t / 1.6 + 2.9);
        _windTmpQuat.setFromAxisAngle(_windTmpUp, (_windTurbulence * swayDeg) * Math.PI / 180);

        return out.copy(baseDir).applyQuaternion(_windTmpQuat).multiplyScalar(strength);
    }

    function _applyWindToSpringBones() {
        const joints = currentVRM?.springBoneManager?.joints;
        if (!joints || _origJointGravity.size === 0) return;
        if (!_windEnabled && !_windWasApplied) return;

        const windVec = _windEnabled
            ? (_windSourceEnabled
                ? _computeWindVectorFromSource(performance.now() / 1000, _windTmpVecA)
                : _computeWindVector(performance.now() / 1000, _windTmpVecA))
            : null;

        joints.forEach(joint => {
            const orig = _origJointGravity.get(joint);
            if (!orig) return;

            if (windVec) {
                _windTmpVecB.copy(orig.dir).multiplyScalar(orig.power).add(windVec);
                const len = _windTmpVecB.length();
                if (len > 1e-6) {
                    joint.settings.gravityDir.copy(_windTmpVecB).divideScalar(len);
                    joint.settings.gravityPower = len;
                } else {
                    joint.settings.gravityDir.copy(orig.dir);
                    joint.settings.gravityPower = 0;
                }
            } else {
                joint.settings.gravityDir.copy(orig.dir);
                joint.settings.gravityPower = orig.power;
            }
        });
        _windWasApplied = !!windVec;
    }

    // ================================================================
    // Light helper drag (3D)
    // ================================================================
    let _draggingEntry = null;
    let _draggingLookAt = false;
    let _draggingWindSource = false;
    const _dragPlane = new THREE.Plane();
    const _dragPt    = new THREE.Vector3();
    let _selectedHelperMesh = null;

    function _getHelperMeshes() {
        return managedLights.filter(l => l.helperMesh).map(l => l.helperMesh);
    }

    canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        updateMouse(e);
        raycaster.setFromCamera(mouse, camera);
        const targets = _getHelperMeshes();
        if (lookAtHelperMesh.visible) targets.push(lookAtHelperMesh);
        if (windSourceHelperMesh.visible) targets.push(windSourceHelperMesh);
        const hits = raycaster.intersectObjects(targets);
        if (hits.length > 0) {
            const hit = hits[0];
            if (hit.object === lookAtHelperMesh) {
                _draggingLookAt = true;
                const camDir = new THREE.Vector3();
                camera.getWorldDirection(camDir);
                _dragPlane.setFromNormalAndCoplanarPoint(camDir, hit.point);
                orbit.enabled = false;
                e.stopImmediatePropagation();
                return;
            }
            if (hit.object === windSourceHelperMesh) {
                _draggingWindSource = true;
                const camDir = new THREE.Vector3();
                camera.getWorldDirection(camDir);
                _dragPlane.setFromNormalAndCoplanarPoint(camDir, hit.point);
                orbit.enabled = false;
                e.stopImmediatePropagation();
                return;
            }
            const entry = managedLights.find(l => l.helperMesh === hit.object);
            if (entry) {
                _draggingEntry = entry;
                const camDir = new THREE.Vector3();
                camera.getWorldDirection(camDir);
                _dragPlane.setFromNormalAndCoplanarPoint(camDir, hit.point);
                orbit.enabled = false;
                e.stopImmediatePropagation();
            }
        }
    }, true);

    canvas.addEventListener("pointermove", (e) => {
        if (_draggingLookAt) {
            updateMouse(e);
            raycaster.setFromCamera(mouse, camera);
            if (raycaster.ray.intersectPlane(_dragPlane, _dragPt)) {
                lookAtHelperMesh.position.copy(_dragPt);
            }
            return;
        }
        if (_draggingWindSource) {
            updateMouse(e);
            raycaster.setFromCamera(mouse, camera);
            if (raycaster.ray.intersectPlane(_dragPlane, _dragPt)) {
                windSourceHelperMesh.position.copy(_dragPt);
                windSourceHelperMesh.lookAt(_windSourceRefPoint);
            }
            return;
        }
        if (!_draggingEntry) return;
        updateMouse(e);
        raycaster.setFromCamera(mouse, camera);
        if (raycaster.ray.intersectPlane(_dragPlane, _dragPt)) {
            const pos = { x: _dragPt.x, y: _dragPt.y, z: _dragPt.z };
            _updateManagedLight(_draggingEntry.id, { position: pos });
            window.dispatchEvent(new CustomEvent("lightHelperMoved", { detail: { id: _draggingEntry.id, position: pos } }));
        }
    }, true);

    canvas.addEventListener("pointerup", () => {
        if (_draggingLookAt) { _draggingLookAt = false; orbit.enabled = true; return; }
        if (_draggingWindSource) { _draggingWindSource = false; orbit.enabled = true; return; }
        if (_draggingEntry) { _draggingEntry = null; orbit.enabled = true; }
    });

    const orbit = new OrbitControls(perspCamera, renderer.domElement);
    orbit.enableRotate = true;
    orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    orbit.target.set(0, 1, 0);
    orbit.update();

    // ---- ズーム操作モード切り替え ----
    // 環境によってはマウスホイールでのズームが機能しないため、
    // Ctrl+右ドラッグでズームする操作モードに切り替えられるようにする
    // 設定は localStorage に永続化し、ノード・外部ページ(SPA等)の双方で共有される
    const _ZOOM_MODE_STORAGE_KEY = "vrmPoseEditor_zoomMode";
    function _loadZoomMode() {
        try {
            return localStorage.getItem(_ZOOM_MODE_STORAGE_KEY) === "ctrlDrag" ? "ctrlDrag" : "wheel";
        } catch (e) {
            return "wheel";
        }
    }
    let _zoomMode = _loadZoomMode(); // "wheel" | "ctrlDrag"
    let _ctrlRightDrag = false;
    let _ctrlRightDragLastY = 0;

    function _applyZoomMode() {
        orbit.enableZoom = (_zoomMode === "wheel");
    }
    _applyZoomMode();

    // ctrlDragモード時はホイールでページがスクロールしてしまわないよう阻止
    renderer.domElement.addEventListener("wheel", (e) => {
        if (_zoomMode === "ctrlDrag") e.preventDefault();
    }, { passive: false });

    renderer.domElement.addEventListener("pointerdown", (e) => {
        if (_zoomMode !== "ctrlDrag" || e.button !== 2 || !e.ctrlKey) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        _ctrlRightDrag = true;
        _ctrlRightDragLastY = e.clientY;
        orbit.enableRotate = false;
        orbit.enablePan    = false;
    }, true);

    renderer.domElement.addEventListener("pointermove", (e) => {
        if (!_ctrlRightDrag) return;
        const dy = e.clientY - _ctrlRightDragLastY;
        _ctrlRightDragLastY = e.clientY;
        const dir = new THREE.Vector3().subVectors(camera.position, orbit.target).normalize();
        camera.position.addScaledVector(dir, dy * 0.01);
        orbit.update();
    }, true);

    function _endCtrlRightDrag() {
        if (!_ctrlRightDrag) return;
        _ctrlRightDrag = false;
        orbit.enableRotate = true;
        orbit.enablePan    = true;
    }
    window.addEventListener("pointerup", _endCtrlRightDrag);
    window.addEventListener("blur", _endCtrlRightDrag);

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
                obj.castShadow = true;
            }
        });
    }

    function _applyGroundToModel(model) {
        const box = new THREE.Box3().setFromObject(model);
        _groundY = box.min.y;
        if (groundMesh) groundMesh.position.y = _groundY;
        if (bgWallMesh) bgWallMesh.position.set(0, _groundY + 10, _bgWallZ);
    }

    function clearModel() {
        _clearVRMA();
        if (loadedModel) {
            scene.remove(loadedModel);
            if (currentVRM) { VRMUtils.deepDispose(currentVRM.scene); currentVRM = null; }
            loadedModel = null;
        }
        interactableBones = [];
        initialPoses.clear();
        _origJointGravity.clear();
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
                _applyGroundToModel(model);
                onMorphKeysReady(collectGltfMorphKeys(model));
                if (onModelReady) onModelReady();
                if (onComplete) onComplete();
                return;
            }

            clearModel();
            currentVRM = vrm;
            _captureOriginalJointGravity();
            // rotateVRM0は使わない（normalized bone座標系を素のまま使うため）
            const model = vrm.scene;
            loadedModel = model;
            scene.add(model);
            const displayScale = placeModel(model);
            model.traverse(obj => { if (obj.isMesh || obj.isSkinnedMesh) obj.castShadow = true; });
            _applyGroundToModel(model);

            // VRM0はrotateVRM0なしだとZ軸負方向が正面 → カメラをZ軸負方向から見る
            // VRM1はZ軸正方向が正面 → カメラをZ軸正方向から見る（従来通り）
            const isVrm0 = vrm.meta?.metaVersion === '0';
            const camZ = isVrm0 ? -5 : 5;
            camera.position.set(0, 1, camZ);
            camera.lookAt(0, 1, 0);
            orbit.target.set(0, 1, 0);
            orbit.update();

            // 新しいモデルの正面側にLookAtターゲットの初期位置を合わせ、
            // 有効化されていれば新モデルのvrm.lookAtに再割り当てする
            lookAtHelperMesh.position.set(0, 1.5, isVrm0 ? -2 : 2);
            if (vrm.lookAt) vrm.lookAt.target = _lookAtEnabled ? lookAtHelperMesh : null;

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
            if (onModelReady) onModelReady();
            if (onComplete) onComplete();
        }, undefined, (err) => {
            console.error("[PoseEditor3D] VRM load error:", err);
            if (onModelReady) onModelReady();
            if (onComplete) onComplete();
        });
    }

    // ================================================================
    // VRMA playback (.vrmaファイルの読込・タイムライン再生・任意フレームでの静止ポーズ化)
    // ================================================================
    // vrmaLoaderはメインのloaderとは別インスタンス。VRMAnimationLoaderPluginを
    // 登録するのはVRMアニメーションファイル専用で、通常のVRM/GLB/GLTF読込には使わない。
    const vrmaLoader = new GLTFLoader();
    vrmaLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    let _vrmaMixer = null;   // THREE.AnimationMixer | null
    let _vrmaAction = null;  // THREE.AnimationAction | null
    let _vrmaClip   = null;  // THREE.AnimationClip   | null
    let _vrmaPlaying = false;
    // mixer専用の実delta計測。既存の固定1/60運用(spring bone/VRM.update)には一切触れない。
    const _vrmaClock = new THREE.Clock();

    function _clearVRMA() {
        if (_vrmaMixer) {
            _vrmaMixer.stopAllAction();
            if (_vrmaClip) _vrmaMixer.uncacheClip(_vrmaClip);
        }
        _vrmaMixer = null;
        _vrmaAction = null;
        _vrmaClip = null;
        _vrmaPlaying = false;
        // VRMAロード中はnullにしていたlookAtターゲットを、トグルボタンの状態に合わせて復元する
        if (currentVRM?.lookAt) {
            currentVRM.lookAt.target = _lookAtEnabled ? lookAtHelperMesh : null;
        }
    }

    function loadVRMAFromBuffer(buffer, onComplete, onError) {
        if (!currentVRM || !currentVRM.humanoid) {
            onError?.("A VRM model (with humanoid bones) must be loaded before playing a VRMA animation.");
            return;
        }
        const url = URL.createObjectURL(new Blob([buffer]));
        vrmaLoader.load(url, (gltf) => {
            URL.revokeObjectURL(url);
            const vrmAnimations = gltf.userData.vrmAnimations;
            if (!vrmAnimations || vrmAnimations.length === 0) {
                onError?.("This file does not contain a VRMC_vrm_animation extension (not a valid .vrma).");
                return;
            }
            _clearVRMA(); // 既存の再生セッションを破棄(lookAt復元含む)

            const clip = createVRMAnimationClip(vrmAnimations[0], currentVRM);
            if (!clip.tracks.length) {
                console.warn("[PoseEditor3D] VRMA loaded but no compatible tracks were found for this model's humanoid.");
            }
            _vrmaClip = clip;
            _vrmaMixer = new THREE.AnimationMixer(currentVRM.scene);
            _vrmaAction = _vrmaMixer.clipAction(clip);
            _vrmaAction.setLoop(THREE.LoopRepeat, Infinity);
            _vrmaAction.play(); // enabled=trueにするためだけに呼ぶ。時間進行はplay/pause状態(_vrmaPlaying)で制御
            _vrmaPlaying = false; // ロード直後は先頭フレームで一時停止

            // LookAtマーカーとの競合回避: VRMAロード中は常にtargetをnullにする
            if (currentVRM.lookAt) currentVRM.lookAt.target = null;

            _vrmaMixer.update(0); // 先頭フレームのポーズを即時反映
            onComplete?.();
        }, undefined, (err) => {
            URL.revokeObjectURL(url);
            onError?.(err?.message ?? String(err));
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
        _applyPixelRatio();
        reloadLastModel();
    }, false);

    // ---- アニメーションループ ----
    let animFrameId = null;

    function animate() {
        animFrameId = requestAnimationFrame(animate);
        if (renderer.getContext().isContextLost()) return;
        if (_vrmaMixer) {
            const vrmaDelta = _vrmaClock.getDelta();
            if (_vrmaPlaying) _vrmaMixer.update(vrmaDelta);
        }
        if (currentVRM) {
            _applyWindToSpringBones();
            currentVRM.update(_springBoneEnabled ? (1 / 60) : 0);
        }
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
            const fovRad = (perspCamera.fov * Math.PI) / 180;
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
        setBgColor(hex)  { scene.background = new THREE.Color(hex); },
        clearBgColor()   { scene.background = null; },

        // ---- LookAt target (視線ターゲット) ----
        hasLookAt()          { return !!currentVRM?.lookAt; },
        getLookAtEnabled()   { return _lookAtEnabled; },
        toggleLookAt()       { _setLookAtEnabled(!_lookAtEnabled); return _lookAtEnabled; },

        // ---- Spring bone physics (揺れ物理) ----
        hasSpringBones()          { return !!currentVRM?.springBoneManager; },
        getSpringBoneEnabled()    { return _springBoneEnabled; },
        toggleSpringBoneEnabled() { _springBoneEnabled = !_springBoneEnabled; return _springBoneEnabled; },

        // ---- Wind physics (風エフェクト・そよ風) ----
        getWindEnabled()      { return _windEnabled; },
        toggleWindEnabled()   { _windEnabled = !_windEnabled; return _windEnabled; },
        getWindStrength()     { return _windStrength; },
        setWindStrength(v)    { _windStrength = v; },
        getWindDirection()    { return _windDirectionDeg; },
        setWindDirection(v)   { _windDirectionDeg = v; },
        getWindTurbulence()   { return _windTurbulence; },
        setWindTurbulence(v)  { _windTurbulence = v; },

        // ---- Wind source marker (風の発生源マーカー) ----
        getWindSourceEnabled()    { return _windSourceEnabled; },
        toggleWindSourceEnabled() { _setWindSourceEnabled(!_windSourceEnabled); return _windSourceEnabled; },

        // ---- Light management API (used by light_editor.js) ----
        getLights()          { return managedLights.map(l => l.config); },
        addLight(config)     { return _addManagedLight(config); },
        removeLight(id)      { _removeManagedLight(id); },
        updateLight(id, ch)  { _updateManagedLight(id, ch); },
        setLightEnabled(id, v) { _updateManagedLight(id, { enabled: v }); },

        // Light helper visibility (shown only when editor is open)
        selectLightHelper(id) {
            // Reset all to their own color
            managedLights.forEach(l => {
                if (l.helperMesh) {
                    l.helperMesh.visible = true;
                    l.helperMesh.userData.selected = false;
                    l.helperMesh.material.color.set(l.config.color);
                }
            });
            // Highlight selected
            const entry = managedLights.find(l => l.id === id);
            if (entry?.helperMesh) {
                entry.helperMesh.material.color.set(0xffdd00);
                entry.helperMesh.userData.selected = true;
                _selectedHelperMesh = entry.helperMesh;
            }
        },
        clearLightHelpers() {
            managedLights.forEach(l => {
                if (l.helperMesh) {
                    l.helperMesh.visible = false;
                    l.helperMesh.userData.selected = false;
                    l.helperMesh.material.color.set(l.config.color);
                }
            });
            _selectedHelperMesh = null;
        },

        // ---- Canvas (for preview mirror) ----
        getCanvas() { return canvas; },

        // ---- Ground ----
        getGroundVisible()       { return _groundVisible; },
        toggleGround()           { _setGroundVisible(!_groundVisible); return _groundVisible; },
        getGroundY()             { return _groundY; },
        setGroundY(y)            { _setGroundY(y); },
        getGroundColor()         { return _groundColor; },
        setGroundColor(hex)      { _setGroundColor(hex); },
        setGroundTexture(url)    { _setGroundTexture(url); },
        clearGroundTexture()     { _clearGroundTexture(); },
        setGroundTexRepeat(n)    { _setGroundTexRepeat(n); },
        getGroundShadowCatcher() { return _groundShadowCatcher; },
        toggleGroundShadowCatcher() { _setGroundShadowCatcher(!_groundShadowCatcher); return _groundShadowCatcher; },
        setGroundShadowOpacity(v){ _setGroundShadowOpacity(v); },
        // ---- Background wall ----
        getBgWallVisible()       { return _bgWallVisible; },
        toggleBgWall()           { _setBgWallVisible(!_bgWallVisible); return _bgWallVisible; },
        getBgWallZ()             { return _bgWallZ; },
        setBgWallZ(z)            { _setBgWallZ(z); },
        getBgWallColor()         { return _bgWallColor; },
        setBgWallColor(hex)      { _setBgWallColor(hex); },
        setBgWallTexture(url)    { _setBgWallTexture(url); },
        clearBgWallTexture()     { _clearBgWallTexture(); },
        setBgWallTexRepeat(n)    { _setBgWallTexRepeat(n); },
        getBgWallShadowCatcher() { return _bgWallShadowCatcher; },
        toggleBgWallShadowCatcher() { _setBgWallShadowCatcher(!_bgWallShadowCatcher); return _bgWallShadowCatcher; },
        setBgWallShadowOpacity(v){ _setBgWallShadowOpacity(v); },

        // ---- Zoom operation mode ----
        // "wheel": マウスホイールでズーム(既定) / "ctrlDrag": Ctrl+右ドラッグでズーム
        getZoomMode()  { return _zoomMode; },
        setZoomMode(m) {
            _zoomMode = (m === "ctrlDrag") ? "ctrlDrag" : "wheel";
            _applyZoomMode();
            try { localStorage.setItem(_ZOOM_MODE_STORAGE_KEY, _zoomMode); } catch (e) { /* noop */ }
        },

        // ---- Shadow quality ----
        setShadowQuality(q) {
            if (q === "none") {
                renderer.shadowMap.enabled = false;
            } else {
                renderer.shadowMap.enabled = true;
                renderer.shadowMap.type = q === "hard" ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
            }
            renderer.shadowMap.needsUpdate = true;
        },

        capture(frameRect, displaySize) {
            interactableBones.forEach(h => h.visible = false);
            // Save and hide light helper visibility
            const helperVisState = managedLights.map(l => l.helperMesh ? l.helperMesh.visible : false);
            managedLights.forEach(l => { if (l.helperMesh) l.helperMesh.visible = false; });
            const lookAtHelperVisBefore = lookAtHelperMesh.visible;
            lookAtHelperMesh.visible = false;
            const windSourceHelperVisBefore = windSourceHelperMesh.visible;
            windSourceHelperMesh.visible = false;

            if (currentVRM) currentVRM.update(0);
            renderer.render(scene, camera);

            // frameRect はディスプレイ座標系 (displaySize px) なので
            // 実キャンバスピクセル座標に変換してクロップ
            const scaleX = canvas.width  / (displaySize ?? canvas.width);
            const scaleY = canvas.height / (displaySize ?? canvas.height);
            const sx = Math.round((frameRect?.x ?? 0) * scaleX);
            const sy = Math.round((frameRect?.y ?? 0) * scaleY);
            const sw = Math.round((frameRect?.w ?? canvas.width)  * scaleX);
            const sh = Math.round((frameRect?.h ?? canvas.height) * scaleY);

            const crop = document.createElement("canvas");
            crop.width  = sw;
            crop.height = sh;
            crop.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
            const data = crop.toDataURL("image/png");

            interactableBones.forEach(h => h.visible = true);
            managedLights.forEach((l, i) => { if (l.helperMesh) l.helperMesh.visible = helperVisState[i]; });
            lookAtHelperMesh.visible = lookAtHelperVisBefore;
            windSourceHelperMesh.visible = windSourceHelperVisBefore;
            return data;
        },
        resetPose() {
            initialPoses.forEach((val, bone) => {
                bone.rotation.copy(val.rot);
                bone.position.copy(val.pos);
            });
            _settleSpringBoneAnchor();
        },
        resetCamera() {
            const isVrm0 = currentVRM?.meta?.metaVersion === '0';
            const camZ = isVrm0 ? -5 : 5;
            perspCamera.position.set(0, 1, camZ);
            perspCamera.up.set(0, 1, 0);
            orthoCamera.position.set(0, 1, camZ);
            orthoCamera.up.set(0, 1, 0);
            orbit.target.set(0, 1, 0);
            // Ortho なら再度サイズ合わせ
            if (isOrtho) switchCamera(true);
            orbit.update();
        },
        switchCamera,
        setFov,
        getFov() { return perspCamera.fov; },
        setNear,
        getNear() { return perspCamera.near; },
        loadVRM,
        loadVRMFromBuffer(buffer, url, onComplete) {
            lastLoadedBuffer = buffer;
            lastLoadedIsDefault = false;
            loadVRM(url, onComplete);
        },
        loadVRMAFromBuffer,
        hasVRMA()          { return !!_vrmaClip; },
        getVRMADuration()  { return _vrmaClip?.duration ?? 0; },
        getVRMATime()      { return _vrmaAction?.time ?? 0; },
        isVRMAPlaying()    { return _vrmaPlaying; },
        playVRMA() {
            if (!_vrmaAction) return;
            _vrmaClock.getDelta(); // 直前の経過分を捨てて次のdeltaを0起点にする
            _vrmaPlaying = true;
        },
        pauseVRMA() { _vrmaPlaying = false; },
        seekVRMA(t) {
            if (!_vrmaAction || !_vrmaClip) return;
            _vrmaAction.time = THREE.MathUtils.clamp(t, 0, _vrmaClip.duration);
            _vrmaMixer.update(0); // その場でポーズを反映（進行はしない）
        },
        clearVRMA() { _clearVRMA(); },
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
                _settleSpringBoneAnchor();
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
                _settleSpringBoneAnchor();
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
                _settleSpringBoneAnchor();
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
            _settleSpringBoneAnchor();
        },
        mirrorPose() {
            // 現在のポーズをversion2形式でエクスポートし、左右ミラーして再インポート
            const json = this.exportPose();
            if (!json) return;
            const parsed = JSON.parse(json);
            if (parsed.version !== 2 || !parsed.bones) return;

            // Left↔Right ボーン名の対応表（VRM humanoid bone名ベース）
            const MIRROR_PAIRS = [
                ["leftShoulder",  "rightShoulder"],
                ["leftUpperArm",  "rightUpperArm"],
                ["leftLowerArm",  "rightLowerArm"],
                ["leftHand",      "rightHand"],
                ["leftUpperLeg",  "rightUpperLeg"],
                ["leftLowerLeg",  "rightLowerLeg"],
                ["leftFoot",      "rightFoot"],
                ["leftToes",      "rightToes"],
                ["leftThumbMetacarpal",   "rightThumbMetacarpal"],
                ["leftThumbProximal",     "rightThumbProximal"],
                ["leftThumbDistal",       "rightThumbDistal"],
                ["leftIndexProximal",     "rightIndexProximal"],
                ["leftIndexIntermediate", "rightIndexIntermediate"],
                ["leftIndexDistal",       "rightIndexDistal"],
                ["leftMiddleProximal",    "rightMiddleProximal"],
                ["leftMiddleIntermediate","rightMiddleIntermediate"],
                ["leftMiddleDistal",      "rightMiddleDistal"],
                ["leftRingProximal",      "rightRingProximal"],
                ["leftRingIntermediate",  "rightRingIntermediate"],
                ["leftRingDistal",        "rightRingDistal"],
                ["leftLittleProximal",    "rightLittleProximal"],
                ["leftLittleIntermediate","rightLittleIntermediate"],
                ["leftLittleDistal",      "rightLittleDistal"],
            ];

            // クォータニオンを左右ミラー変換: YZ軸を反転 (x, -y, -z, w)
            function mirrorQuat(bd) {
                return { qx: bd.qx, qy: -bd.qy, qz: -bd.qz, qw: bd.qw };
            }

            const src   = parsed.bones;
            const mirrored = {};

            // ペアボーンを左右入れ替えてミラー変換
            for (const [left, right] of MIRROR_PAIRS) {
                if (src[left])  mirrored[right] = mirrorQuat(src[left]);
                if (src[right]) mirrored[left]  = mirrorQuat(src[right]);
            }

            // ペア以外（中央ボーン: hips / spine / chest 等）もミラー変換
            for (const [key, bd] of Object.entries(src)) {
                if (!(key in mirrored)) mirrored[key] = mirrorQuat(bd);
            }

            const mirroredJson = JSON.stringify({
                version: 2,
                vrmVersion: parsed.vrmVersion,
                bones: mirrored,
            });
            this.importPose(mirroredJson);
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
        hasModel() {
            return loadedModel !== null;
        },
        // canvas サイズ変更時に renderer とカメラアスペクト比を同期する（外部から呼び出し用）
        resizeRenderer(w, h) {
            renderer.setSize(w, h, false);
            perspCamera.aspect = w / h;
            perspCamera.updateProjectionMatrix();
            // Ortho モード中はサイズ比を維持して再計算
            if (isOrtho) {
                const aspect = w / h;
                const halfH = orthoCamera.top;
                orthoCamera.left   = -halfH * aspect;
                orthoCamera.right  =  halfH * aspect;
                orthoCamera.updateProjectionMatrix();
            }
        },
        // ---- スーパーサンプリング（アンチエイリアス強化）----
        getSuperSample() { return _superSample; },
        setSuperSample(v) {
            _superSample = !!v;
            try { localStorage.setItem(_SUPERSAMPLE_STORAGE_KEY, _superSample ? '1' : '0'); } catch (e) { /* localStorage不可の環境は無視 */ }
            _applyPixelRatio();
        },
        stopLoop() {
            if (animFrameId !== null) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        },
        startLoop() {
            if (animFrameId === null) animate();
        },
        forceReload() {
            // タブ切り替えと同等: webglcontextrestored と同じ処理を手動実行
            renderer.setSize(canvas.width, canvas.height, false);
            _applyPixelRatio();
            reloadLastModel();
        },
        isContextLost() {
            return renderer.getContext().isContextLost();
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
