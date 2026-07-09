// pose_editor_core.js — pose_editor_3d.js から ComfyUI 非依存のコアロジックのみを切り出したモジュール
// ComfyUIノード(pose_editor_3d.js)・外部ページ(SPA等)の両方から import して利用できる

import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from './vendor/three-vrm.module.js';

// ---- Three.js エディタ本体 ----
export function initPoseEditor3D(canvas, gizmoCanvas, baseUrl, onMorphKeysReady, isModern, onModelReady) {

    // -- メインレンダラー --
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(canvas.width, canvas.height, false);
    renderer.setPixelRatio(window.devicePixelRatio);
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
    // Light helper drag (3D)
    // ================================================================
    let _draggingEntry = null;
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
        const hits = raycaster.intersectObjects(_getHelperMeshes());
        if (hits.length > 0) {
            const hit = hits[0];
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
                _applyGroundToModel(model);
                onMorphKeysReady(collectGltfMorphKeys(model));
                if (onModelReady) onModelReady();
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
        stopLoop() {
            if (animFrameId !== null) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        },
        startLoop() {
            if (animFrameId === null) animate();
        },
        forceReload() {
            // タブ切り替えと同等: webglcontextrestored と同じ処理を手動実行
            renderer.setSize(canvas.width, canvas.height, false);
            renderer.setPixelRatio(window.devicePixelRatio);
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
