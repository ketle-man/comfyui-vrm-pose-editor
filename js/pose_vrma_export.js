/**
 * VRMA Keyframe Panel (フレームベース)
 * - フレーム番号ベースでキーフレームを管理する（PSD-Figure-Creator, feat/keyframe-video の
 *   psd_loader.js のUXパターンを参考: 現在位置に追加/削除ボタン、タイムライン上でドラッグ移動）
 * - editor.exportVrma() は秒単位のtimeを要求するため、fps設定で time = frame / fps に変換して渡す
 * - ポーズKF編集中のプレビューは「自己ロードバック」方式: 生成したglbをそのまま
 *   editor.loadVRMAFromBuffer() に渡し、editor.seekVRMA(t) でシーク時にその場でポーズを反映する
 * - 再生ボタンは自パネル駆動のrAFタイマーで0〜totalFramesのフレームを進める方式(PSD-Figure-Creator
 *   のstartPlayback()と同型)。ポーズKFが1つも無い(カメラ/シェイプキーのみの)タイムラインでも
 *   再生でき、かつ再生範囲がポーズKFの最終フレームに制限されずtotalFramesまで届く
 *   (詳細はbuildKeyframePanel内「プレビュー再生」節のコメント参照)
 * - editor.seekVRMA(t) はその場でポーズを反映するため、フレームへシークしてから editor.exportPose() を
 *   呼べば「そのフレームの補間済みポーズ」を独自補間ロジック無しで正しくキャプチャできる
 * - 本バージョンはブラウザダウンロードのみ(サーバー保存は未対応)
 * - Light & Pose Editorモーダル下部に常時マウントされるパネル部品として提供する(buildKeyframePanel)。
 *   単体モーダルではないため、開閉やEscape/クリック外側での終了処理は持たない。
 */

// ----------------------------------------------------------------
// エントリポイント
// editor: initPoseEditor3D の戻り値（exportPose / exportVrma / loadVRMAFromBuffer 等を持つ）
// getVrmBuffer: 現在ロード済みのVRMバッファ(ArrayBuffer|null)を返す関数（将来のサムネイル生成用に受け取っておく）
// getShapeKeys: 現在のシェイプキー一覧 [{name,getValue,setValue}] を返す関数(省略可)。
//   ポーズと同じキーフレームに束ねて保存し、プレビュー内シーク/再生でのみ補間適用する(.vrma書き出しには含めない)。
// onShapeKeysApplied: シーク/再生でシェイプキー値を適用した直後に呼ばれるコールバック(省略可)。
//   呼び出し元のシェイプキー編集UI(スライダー等)を再同期させるためのフック。
// 戻り値: { el, destroy } — el を呼び出し元のDOMへ追加し、閉じる際に destroy() を呼ぶこと
// ----------------------------------------------------------------
export function buildKeyframePanel(editor, getVrmBuffer, getShapeKeys, onShapeKeysApplied) {
    const panel = el("div", {
        style: "display:flex;flex-direction:column;background:#16162a;" +
               "border-top:1px solid #2a2a4a;flex-shrink:0;font-family:sans-serif;",
    });

    // ---- 操作行 ----
    const toolbar = el("div", {
        style: "display:flex;align-items:center;gap:6px;padding:6px 12px;" +
               "background:#1a1a2e;border-bottom:1px solid #2a2a4a;flex-shrink:0;flex-wrap:wrap;",
    });
    const titleEl = el("span", { style: "font-size:11px;font-weight:bold;color:#9aa;margin-right:2px;" }, "🎬 Keyframes");
    const addBtn = mkBtn("✚ Add/Update KF", "#4a7a4a", "現在フレームに、今のポーズをキーフレームとして追加/上書き");
    const delBtn = mkBtn("− Delete KF", "#5a3a3a", "現在フレームのキーフレームを削除");
    const addFromLibBtn = mkBtn("📚 + From Library", "#4a4a8a", "ポーズライブラリから選んで現在フレームに追加/上書き");
    const camAddBtn = mkBtn("📷 + Cam KF", "#3a6a8a", "現在フレームに、今のカメラ位置をキーフレームとして追加/上書き");
    const camDelBtn = mkBtn("📷 − Cam KF", "#5a3a3a", "現在フレームのカメラキーフレームを削除");
    const moveBtn = mkToggle("🔀 Move", "ONの間はタイムライン上のマーカーをドラッグして移動できます");

    const gotoStartBtn = mkBtn("⏮", "#333344", "フレーム0へ");
    const prevBtn = mkBtn("❮", "#333344", "1フレーム戻る");
    const frameInput = mkNumInput(0, 100000, 1, 0);
    const slashLbl = el("span", { style: "font-size:11px;color:#666;" }, "/");
    const totalInput = mkNumInput(1, 100000, 1, 60);
    const nextBtn = mkBtn("❯", "#333344", "1フレーム進む");

    toolbar.append(
        titleEl, addBtn, delBtn, addFromLibBtn,
        sep(), camAddBtn, camDelBtn,
        sep(), moveBtn,
        sep(), gotoStartBtn, prevBtn, frameInput, slashLbl, totalInput, nextBtn,
    );

    // ---- ライブラリピッカー(サブビュー、通常は非表示) ----
    const libView = el("div", {
        style: "display:none;flex-direction:column;gap:4px;max-height:140px;overflow-y:auto;" +
               "padding:6px 12px;background:#111118;border-bottom:1px solid #2a2a4a;flex-shrink:0;box-sizing:border-box;",
    });

    // ---- プロジェクト保存/読込パネル(サブビュー、通常は非表示。libViewと排他表示) ----
    const projView = el("div", {
        style: "display:none;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto;" +
               "padding:6px 12px;background:#111118;border-bottom:1px solid #2a2a4a;flex-shrink:0;box-sizing:border-box;",
    });

    // ---- タイムライン ----
    const timelineWrap = el("div", {
        style: "padding:6px 12px;background:#111118;border-bottom:1px solid #2a2a4a;flex-shrink:0;",
    });
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:40px;display:block;cursor:pointer;border-radius:4px;background:#1a1a2e;";
    timelineWrap.appendChild(canvas);

    // ---- 再生 / 書き出し行 ----
    const previewPanel = el("div", {
        style: "display:flex;align-items:center;gap:8px;padding:6px 12px;" +
               "background:#13131e;flex-shrink:0;flex-wrap:wrap;",
    });
    const fpsLbl = el("span", { style: "font-size:10px;color:#888;" }, "FPS:");
    const fpsInput = mkNumInput(1, 60, 1, 24);
    const newBtn = mkBtn("🆕 New", "#5a4a3a", "現在のタイムラインをすべてクリアして新規作成");
    const projBtn = mkBtn("💾 Proj", "#4a4a8a", "タイムラインをプロジェクトとして保存/読込");
    const rpBtn = mkBtn("RP", "#6c757d", "Reset Pose");
    const rcBtn = mkBtn("RC", "#5a7a5a", "Reset Camera");
    const statusMsg = el("span", { style: "flex:1;font-size:11px;color:#888;min-width:80px;" }, "0 keyframes");
    const playBtn = el("button", {
        style: "padding:4px 10px;background:#4a90d9;color:#fff;border:none;border-radius:3px;" +
               "cursor:pointer;font-size:12px;flex-shrink:0;",
    }, "▶");
    const downloadBtn = mkBtn("💾 Save .vrma", "#4a7a4a", "Export and save the animation to poses/ (visible in Pose Library)");
    const webmBtn = mkBtn("🎬 WebM", "#3a6a8a", "タイムライン全体(ポーズ・カメラ・シェイプキー)をWebM動画としてダウンロード");
    const gifBtn = mkBtn("🎞️ GIF", "#3a6a8a", "タイムライン全体を透過GIFとしてダウンロード(フレーム数が多いと時間がかかります)");
    previewPanel.append(fpsLbl, fpsInput, newBtn, projBtn, rpBtn, rcBtn, statusMsg, playBtn, downloadBtn, webmBtn, gifBtn);

    panel.append(toolbar, libView, projView, timelineWrap, previewPanel);

    // ----------------------------------------------------------------
    // 状態
    // ----------------------------------------------------------------
    let keyframes = [];      // { frame:number, label?:string, bones?, shapeKeys?, camera? } (frame昇順)
                              // bones/shapeKeysはポーズKFとして束ねて追加/削除される(表情はポーズと同時に変わることが多いため)
    let fps = 24;
    let totalFrames = 60;
    let currentFrame = 0;
    let moveMode = false;
    let poseCounter = 1;

    let dpr = window.devicePixelRatio || 1;
    let resizeObserver = null;
    let _playing = false;    // 自パネル駆動の再生中フラグ(下記「プレビュー再生」参照)
    let _playRafId = null;   // 再生タイマーのrAF ID
    let _lastTickTime = 0;   // 直近のフレーム送り時刻(performance.now())
    let _debounceId = null;  // プレビュー再生成のデバウンス
    let draggingFrame = null; // Moveモード中、ドラッグ中のKFの現在フレーム値
    let isScrubbing = false;  // 非Moveモード中のタイムラインドラッグ(スクラブ)

    function destroy() {
        stopPlayback();
        if (_debounceId !== null) { clearTimeout(_debounceId); _debounceId = null; }
        resizeObserver?.disconnect();
        window.removeEventListener("mousemove", onWindowMouseMove);
        window.removeEventListener("mouseup", onWindowMouseUp);
        editor.clearVRMA();
    }

    function clampFrame(f) {
        return Math.max(0, Math.min(totalFrames, Math.round(f)));
    }

    function ensureTotalFrames() {
        const maxKf = keyframes.reduce((m, k) => Math.max(m, k.frame), 0);
        if (maxKf > totalFrames) {
            totalFrames = maxKf;
            totalInput.value = String(totalFrames);
        }
    }

    function updateStatus() {
        const poseCount = keyframes.filter(k => k.bones).length;
        const camCount  = keyframes.filter(k => k.camera).length;
        statusMsg.textContent = `${poseCount} pose · ${camCount} camera`;
    }

    // ----------------------------------------------------------------
    // フレームシーク
    // ----------------------------------------------------------------
    function seekToFrame(frame, opts = {}) {
        currentFrame = clampFrame(frame);
        frameInput.value = String(currentFrame);
        if (editor.hasVRMA()) {
            editor.seekVRMA(currentFrame / fps);
        }
        applyCameraForFrame(currentFrame);
        applyShapeKeysForFrame(currentFrame);
        // 再生中(rAFループ)からの毎フレーム呼び出しではスライダー全再構築コストを避けるため呼ばない
        if (!opts.silent) onShapeKeysApplied?.();
        if (!opts.silent) drawTimeline();
    }

    // ----------------------------------------------------------------
    // 現在フレームへのキーフレーム追加/上書き・削除
    // ----------------------------------------------------------------
    // 現在のシェイプキー値のスナップショットを {name: value} で返す。シェイプキーが無ければundefined
    function captureShapeKeysSnapshot() {
        const keys = getShapeKeys?.() ?? [];
        if (keys.length === 0) return undefined;
        const snap = {};
        keys.forEach(k => { snap[k.name] = k.getValue?.() ?? 0; });
        return snap;
    }

    function captureAtCurrentFrame(label, bonesOverride) {
        let bones = bonesOverride;
        if (!bones) {
            const json = editor.exportPose?.();
            if (!json) { alert("No pose data available. Load a VRM model first."); return; }
            bones = JSON.parse(json).bones;
        }
        const shapeKeys = captureShapeKeysSnapshot();
        const existing = keyframes.find(k => k.frame === currentFrame);
        if (existing) {
            existing.bones = bones;
            if (shapeKeys) existing.shapeKeys = shapeKeys;
            if (label) existing.label = label;
        } else {
            keyframes.push({
                frame: currentFrame, label: label ?? `Pose ${poseCounter++}`, bones,
                ...(shapeKeys ? { shapeKeys } : {}),
            });
            keyframes.sort((a, b) => a.frame - b.frame);
        }
        ensureTotalFrames();
        drawTimeline();
        updateStatus();
        schedulePreviewRefresh();
    }
    addBtn.onclick = () => captureAtCurrentFrame();

    // ポーズ(bones/shapeKeys)のフィールドだけを削除する(cameraが残っていればエントリ自体は維持)。
    // PSD-Figure-Creatorのdeleteキーフレーム実装(pose/camera独立管理)を踏襲。
    function deleteAtCurrentFrame() {
        const idx = keyframes.findIndex(k => k.frame === currentFrame);
        if (idx === -1) return;
        const kf = keyframes[idx];
        if (!kf.bones) return;
        delete kf.bones;
        delete kf.label;
        delete kf.shapeKeys;
        if (!kf.camera) keyframes.splice(idx, 1);
        drawTimeline();
        updateStatus();
        schedulePreviewRefresh();
    }
    delBtn.onclick = deleteAtCurrentFrame;

    // ----------------------------------------------------------------
    // カメラキーフレーム(プレビュー内シーク/再生専用、.vrma書き出しには含めない)
    // ----------------------------------------------------------------
    function captureCameraAtCurrentFrame() {
        const state = editor.getCameraState?.();
        if (!state) return;
        const existing = keyframes.find(k => k.frame === currentFrame);
        if (existing) {
            existing.camera = state;
        } else {
            keyframes.push({ frame: currentFrame, camera: state });
            keyframes.sort((a, b) => a.frame - b.frame);
        }
        ensureTotalFrames();
        drawTimeline();
        updateStatus();
    }
    camAddBtn.onclick = captureCameraAtCurrentFrame;

    function deleteCameraAtCurrentFrame() {
        const idx = keyframes.findIndex(k => k.frame === currentFrame);
        if (idx === -1) return;
        const kf = keyframes[idx];
        if (!kf.camera) return;
        delete kf.camera;
        if (!kf.bones) keyframes.splice(idx, 1);
        drawTimeline();
        updateStatus();
        applyCameraForFrame(currentFrame);
    }
    camDelBtn.onclick = deleteCameraAtCurrentFrame;

    function lerp(a, b, t) { return a + (b - a) * t; }
    function lerpVec3(a, b, t) {
        return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
    }
    function normalizeVec3(v) {
        const len = Math.hypot(v.x, v.y, v.z) || 1;
        return { x: v.x / len, y: v.y / len, z: v.z / len };
    }
    function lerpCameraState(a, b, t) {
        return {
            position: lerpVec3(a.position, b.position, t),
            target:   lerpVec3(a.target, b.target, t),
            // upを補間することでカメラロール(視軸まわりの傾き)もKF間で滑らかに遷移する
            up:       normalizeVec3(lerpVec3(a.up ?? { x: 0, y: 1, z: 0 }, b.up ?? { x: 0, y: 1, z: 0 }, t)),
            fov:      lerp(a.fov, b.fov, t),
        };
    }

    // camera を持つエントリだけを対象に、指定フレームの状態を前後から線形補間してカメラへ適用する。
    // カメラKFが1つも無ければ何もしない(ユーザーの手動オービットを妨げない)。
    function applyCameraForFrame(frame) {
        const camKfs = keyframes.filter(k => k.camera).sort((a, b) => a.frame - b.frame);
        if (camKfs.length === 0) return;
        let before = null, after = null;
        for (const k of camKfs) {
            if (k.frame <= frame) before = k;
            if (k.frame >= frame && !after) after = k;
        }
        let state;
        if (before && after) {
            state = before.frame === after.frame
                ? before.camera
                : lerpCameraState(before.camera, after.camera, (frame - before.frame) / (after.frame - before.frame));
        } else {
            state = (before ?? after).camera;
        }
        editor.setCameraState?.(state);
    }

    // ----------------------------------------------------------------
    // シェイプキー(表情)補間 — プレビュー内シーク/再生専用。ポーズ(bones)と同じエントリに束ねて
    // 保存されるため、shapeKeysを持つエントリ = ポーズKFとほぼ一致する。
    // ----------------------------------------------------------------
    function lerpShapeKeysState(a, b, t) {
        const result = {};
        for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
            result[name] = lerp(a[name] ?? 0, b[name] ?? 0, t);
        }
        return result;
    }

    function applyShapeKeysForFrame(frame) {
        const keys = getShapeKeys?.() ?? [];
        if (keys.length === 0) return;
        const skKfs = keyframes.filter(k => k.shapeKeys).sort((a, b) => a.frame - b.frame);
        if (skKfs.length === 0) return;
        let before = null, after = null;
        for (const k of skKfs) {
            if (k.frame <= frame) before = k;
            if (k.frame >= frame && !after) after = k;
        }
        let state;
        if (before && after) {
            state = before.frame === after.frame
                ? before.shapeKeys
                : lerpShapeKeysState(before.shapeKeys, after.shapeKeys, (frame - before.frame) / (after.frame - before.frame));
        } else {
            state = (before ?? after).shapeKeys;
        }
        keys.forEach(k => {
            if (state[k.name] !== undefined) k.setValue?.(state[k.name]);
        });
    }

    // ----------------------------------------------------------------
    // 「ポーズライブラリから追加」(簡易一覧サブビュー)
    // ----------------------------------------------------------------
    async function apiFetch(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async function openLibraryPicker() {
        projView.style.display = "none";
        libView.style.display = "flex";
        libView.innerHTML = "";
        libView.appendChild(el("div", { style: "font-size:11px;color:#888;padding:4px 0;" }, "Loading poses…"));
        try {
            const data = await apiFetch("/pose_library/list");
            libView.innerHTML = "";
            const backRow = el("div", { style: "margin-bottom:4px;" });
            const backBtn = mkBtn("← Back", "#444");
            backBtn.onclick = () => { libView.style.display = "none"; };
            backRow.appendChild(backBtn);
            libView.appendChild(backRow);

            // このピッカーは静止ポーズ専用(.vrmaはeditor.importPose()に渡すと壊れるため除外)
            const poses = (data.poses ?? []).filter(p => p.ext !== ".vrma");
            if (poses.length === 0) {
                libView.appendChild(el("div", { style: "font-size:11px;color:#666;padding:8px;" }, "No poses found in poses/."));
                return;
            }
            for (const pose of poses) {
                const row = el("div", {
                    style: "display:flex;align-items:center;gap:6px;padding:5px 8px;" +
                           "background:#2a2a3e;border-radius:4px;cursor:pointer;",
                });
                row.appendChild(el("span", { style: "font-size:11px;color:#ccc;flex:1;" }, pose.name));
                if (pose.vrmVersion) {
                    row.appendChild(el("span", { style: "font-size:9px;color:#666;" }, `VRM${pose.vrmVersion}`));
                }
                row.addEventListener("mouseenter", () => row.style.background = "#3a3a52");
                row.addEventListener("mouseleave", () => row.style.background = "#2a2a3e");
                row.addEventListener("click", async () => {
                    try {
                        const content = await (await fetch(`/pose_library/content?path=${encodeURIComponent(pose.path)}`)).text();
                        // 現在ロード中のVRMへ実際に適用してから読み直すことで、
                        // ポーズ側のvrmVersionと現在のモデルが異なる場合もVRM0/VRM1変換込みで正規化される
                        // (pose_editor_core.js の importPose()/exportPose() の変換ロジックをそのまま利用)
                        editor.importPose(content);
                        const normalized = JSON.parse(editor.exportPose());
                        captureAtCurrentFrame(pose.name, normalized.bones);
                        libView.style.display = "none";
                    } catch (e) {
                        alert("Failed to load pose: " + e.message);
                    }
                });
                libView.appendChild(row);
            }
        } catch (e) {
            libView.innerHTML = "";
            libView.appendChild(el("div", { style: "font-size:11px;color:#e07a7a;padding:8px;" }, "Error: " + e.message));
        }
    }
    addFromLibBtn.onclick = openLibraryPicker;

    // ----------------------------------------------------------------
    // タイムライン描画
    // ----------------------------------------------------------------
    function resizeCanvas() {
        const cssW = canvas.clientWidth || 300;
        const cssH = canvas.clientHeight || 40;
        dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(cssW * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
        drawTimeline();
    }

    function xForFrame(f, cssW) {
        const usableW = Math.max(1, cssW - 12);
        const t = totalFrames > 0 ? f / totalFrames : 0;
        return 6 + t * usableW;
    }

    function drawTimeline() {
        const cssW = canvas.clientWidth || 300;
        const cssH = canvas.clientHeight || 40;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const midY = cssH / 2;
        ctx.strokeStyle = "#313244";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(6, midY);
        ctx.lineTo(cssW - 6, midY);
        ctx.stroke();

        keyframes.forEach(kf => {
            const x = xForFrame(kf.frame, cssW);
            const isCurrent = kf.frame === currentFrame;
            const size = isCurrent ? 9 : 7;
            // 両方=緑、ポーズのみ=黄、カメラのみ=紫 (PSD-Figure-Creatorのマーカー色分けを踏襲)
            const baseColor = kf.bones && kf.camera ? "#44ee88" : kf.camera ? "#cc66ff" : "#ffdd44";
            ctx.save();
            ctx.translate(x, midY);
            ctx.rotate(Math.PI / 4);
            if (isCurrent) { ctx.shadowColor = baseColor; ctx.shadowBlur = 8; }
            ctx.fillStyle = baseColor;
            ctx.fillRect(-size / 2, -size / 2, size, size);
            ctx.restore();
        });

        const px = xForFrame(currentFrame, cssW);
        ctx.strokeStyle = "#e05a5a";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, 2);
        ctx.lineTo(px, cssH - 2);
        ctx.stroke();
        ctx.fillStyle = "#e05a5a";
        ctx.beginPath();
        ctx.moveTo(px - 4, 2);
        ctx.lineTo(px + 4, 2);
        ctx.lineTo(px, 8);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#666";
        ctx.font = "9px sans-serif";
        ctx.textBaseline = "bottom";
        ctx.textAlign = "left";
        ctx.fillText("0", 4, cssH - 2);
        ctx.textAlign = "right";
        ctx.fillText(String(totalFrames), cssW - 4, cssH - 2);
        ctx.textAlign = "left";
    }

    // ----------------------------------------------------------------
    // タイムライン操作(クリックでシーク / Moveモードでドラッグ移動)
    // ----------------------------------------------------------------
    function frameFromClientX(clientX) {
        const rect = canvas.getBoundingClientRect();
        const usableW = Math.max(1, rect.width - 12);
        const x = clientX - rect.left - 6;
        const t = x / usableW;
        return clampFrame(t * totalFrames);
    }

    function nearestKeyframe(clientX) {
        const rect = canvas.getBoundingClientRect();
        const usableW = Math.max(1, rect.width - 12);
        let best = null, bestDist = Infinity;
        keyframes.forEach(kf => {
            const t = totalFrames > 0 ? kf.frame / totalFrames : 0;
            const x = rect.left + 6 + t * usableW;
            const dist = Math.abs(clientX - x);
            if (dist < bestDist) { bestDist = dist; best = kf; }
        });
        return bestDist <= 10 ? best : null;
    }

    // 移動先に既存KFがあれば無条件で上書き(消滅)する。PSD-Figure-Creatorのmoveキーフレーム実装を踏襲。
    function moveKeyframeFrame(fromFrame, toFrame) {
        if (fromFrame === toFrame) return;
        const idx = keyframes.findIndex(k => k.frame === fromFrame);
        if (idx === -1) return;
        const moved = keyframes[idx];
        keyframes = keyframes.filter(k => k.frame !== fromFrame && k.frame !== toFrame);
        moved.frame = toFrame;
        keyframes.push(moved);
        keyframes.sort((a, b) => a.frame - b.frame);
        ensureTotalFrames();
        updateStatus();
    }

    canvas.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (moveMode) {
            const hit = nearestKeyframe(e.clientX);
            if (!hit) return;
            draggingFrame = hit.frame;
            seekToFrame(hit.frame);
            window.addEventListener("mousemove", onWindowMouseMove);
            window.addEventListener("mouseup", onWindowMouseUp);
        } else {
            isScrubbing = true;
            stopPlayback();
            seekToFrame(frameFromClientX(e.clientX));
            window.addEventListener("mousemove", onWindowMouseMove);
            window.addEventListener("mouseup", onWindowMouseUp);
        }
    });

    function onWindowMouseMove(e) {
        if (moveMode && draggingFrame !== null) {
            const newFrame = frameFromClientX(e.clientX);
            if (newFrame !== draggingFrame) {
                moveKeyframeFrame(draggingFrame, newFrame);
                draggingFrame = newFrame;
                seekToFrame(newFrame, { silent: true });
                drawTimeline();
            }
        } else if (isScrubbing) {
            seekToFrame(frameFromClientX(e.clientX));
        }
    }

    function onWindowMouseUp() {
        if (draggingFrame !== null) {
            const finalFrame = draggingFrame;
            draggingFrame = null;
            seekToFrame(finalFrame);
            schedulePreviewRefresh();
        }
        isScrubbing = false;
        window.removeEventListener("mousemove", onWindowMouseMove);
        window.removeEventListener("mouseup", onWindowMouseUp);
    }

    moveBtn.onclick = () => {
        moveMode = !moveMode;
        moveBtn.style.background = moveMode ? "#7a4aa0" : "#333344";
        canvas.style.cursor = moveMode ? "grab" : "pointer";
    };

    // ----------------------------------------------------------------
    // フレーム移動(ボタン/数値入力)
    // ----------------------------------------------------------------
    gotoStartBtn.onclick = () => seekToFrame(0);
    prevBtn.onclick = () => seekToFrame(currentFrame - 1);
    nextBtn.onclick = () => seekToFrame(currentFrame + 1);

    frameInput.addEventListener("change", () => {
        seekToFrame(parseInt(frameInput.value, 10) || 0);
    });

    totalInput.addEventListener("change", () => {
        let v = parseInt(totalInput.value, 10);
        if (isNaN(v) || v < 1) v = 1;
        const maxKf = keyframes.reduce((m, k) => Math.max(m, k.frame), 0);
        v = Math.max(v, maxKf, 1);
        totalFrames = v;
        totalInput.value = String(v);
        if (currentFrame > totalFrames) seekToFrame(totalFrames);
        else drawTimeline();
    });

    fpsInput.addEventListener("change", () => {
        let v = parseInt(fpsInput.value, 10);
        if (isNaN(v) || v < 1) v = 1;
        if (v > 60) v = 60;
        fps = v;
        fpsInput.value = String(v);
        schedulePreviewRefresh();
    });

    // ----------------------------------------------------------------
    // プレビュー再生(自パネル駆動のタイマー方式)
    // - 旧実装はeditor.playVRMA()/isVRMAPlaying()/getVRMATime()に完全依存する「自己ロードバック方式」
    //   だったが、これだとポーズKFが1つも無い(カメラ/シェイプキーのみの)タイムラインでは
    //   _vrmaActionが存在せず再生ボタンが何もしなかったり、再生範囲がVRMAクリップのduration
    //   (=最後のポーズKFの時刻)までに制限され、totalFramesまで再生されない問題があった。
    // - PSD-Figure-Creator(feat/keyframe-video)のstartPlayback()と同じ、自前のrAFタイマーで
    //   フレームを進める方式に変更。毎フレームseekToFrame()を呼ぶことで、ポーズKFがあれば
    //   editor.seekVRMA()・カメラKFがあればapplyCameraForFrame()・シェイプキーKFがあれば
    //   applyShapeKeysForFrame()がそれぞれ独立して反映される。0〜totalFramesを再生し、
    //   末尾に達したら先頭へループする。
    // ----------------------------------------------------------------
    function startPlayback() {
        if (_playing) return;
        _playing = true;
        playBtn.textContent = "⏸";
        _lastTickTime = performance.now();
        const tick = () => {
            if (!_playing) return;
            const interval = 1000 / fps;
            const now = performance.now();
            if (now - _lastTickTime >= interval) {
                _lastTickTime += interval;
                // silent: シェイプキースライダーの全再構築(onShapeKeysApplied)は60fps相当で
                // 呼ぶとコストが大きいため、再生中は毎フレーム呼ばない(Poseタブ表示中の
                // スライダー値自体はapplyShapeKeysForFrameで更新されるが、UI再描画はスキップされる)
                seekToFrame((currentFrame + 1) % (totalFrames + 1), { silent: true });
                drawTimeline();
            }
            _playRafId = requestAnimationFrame(tick);
        };
        _playRafId = requestAnimationFrame(tick);
    }
    function stopPlayback() {
        _playing = false;
        if (_playRafId !== null) { cancelAnimationFrame(_playRafId); _playRafId = null; }
        playBtn.textContent = "▶";
    }

    async function refreshPreview() {
        // camera専用エントリはbonesを持たないためexportVrmaへは渡さない(渡すと例外になる)
        const poseKfs = keyframes.filter(k => k.bones);
        if (poseKfs.length === 0) {
            editor.clearVRMA();
            drawTimeline();
            stopPlayback();
            return;
        }
        try {
            const buf = await editor.exportVrma(poseKfs.map(k => ({ time: k.frame / fps, bones: k.bones })));
            await new Promise((resolve, reject) => {
                editor.loadVRMAFromBuffer(buf, resolve, (msg) => reject(new Error(msg)));
            });
            seekToFrame(currentFrame, { silent: true });
            drawTimeline();
            stopPlayback();
        } catch (e) {
            console.error("[KeyframePanel] preview refresh failed:", e);
        }
    }
    function schedulePreviewRefresh() {
        if (_debounceId !== null) clearTimeout(_debounceId);
        _debounceId = setTimeout(refreshPreview, 400);
    }

    playBtn.onclick = () => {
        if (_playing) stopPlayback(); else startPlayback();
    };

    // ----------------------------------------------------------------
    // ダウンロード
    // ----------------------------------------------------------------
    downloadBtn.onclick = async () => {
        const poseKfs = keyframes.filter(k => k.bones);
        if (poseKfs.length === 0) { alert("Add at least one keyframe pose first."); return; }
        downloadBtn.textContent = "⏳";
        try {
            const buf = await editor.exportVrma(poseKfs.map(k => ({ time: k.frame / fps, bones: k.bones })));
            await apiFetchJson("/pose_library/save_vrma", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data: arrayBufferToBase64(buf) }),
            });
            downloadBtn.textContent = "✅ Saved";
            setTimeout(() => { downloadBtn.textContent = "💾 Save .vrma"; }, 1500);
        } catch (e) {
            alert("Save failed: " + e.message);
            downloadBtn.textContent = "💾 Save .vrma";
        }
    };

    // ----------------------------------------------------------------
    // WebM / GIF 書き出し
    // - .vrma書き出し(exportVrma)と異なり、ポーズ・カメラ・シェイプキーすべてを含むタイムライン全体を
    //   フレームごとにseekToFrame()でシークしながら1枚ずつレンダリングして動画/GIF化する
    //   (glTF標準の.vrmaはFOV/カメラアニメーション非対応のため、それらを含めたい場合はこちらを使う)
    // - editor.renderClean()はcapture()と同じくボーンハンドル等のヘルパーを隠してレンダリングするが、
    //   PNGエンコード/デコードを挟まない分軽い(capture()はキャンバス直読みができない用途向けの薄いラッパー)
    // ----------------------------------------------------------------
    function computeExportSize(maxDim) {
        const src = editor.getCanvas();
        const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
        return {
            outW: Math.max(1, Math.round(src.width * scale)),
            outH: Math.max(1, Math.round(src.height * scale)),
        };
    }

    // ヘルパーを隠した状態で現在フレームをdestCanvas(2D)へ描画する(WebM/GIF共通)
    function renderFrameToOffscreen(destCanvas, outW, outH) {
        editor.renderClean();
        const src = editor.getCanvas();
        if (destCanvas.width !== outW) destCanvas.width = outW;
        if (destCanvas.height !== outH) destCanvas.height = outH;
        const ctx = destCanvas.getContext("2d");
        ctx.clearRect(0, 0, outW, outH);
        ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, outW, outH);
        return ctx;
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = el("a", { href: url, download: filename });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // アニメーション全体(0〜totalFrames)をWebM動画としてエクスポートする。
    // MediaRecorder + captureStream(0)の手動requestFrame()方式(1フレームごとに描画→push)。
    async function exportVideoWebM(onProgress) {
        const { outW, outH } = computeExportSize(768);
        const offCanvas = document.createElement("canvas");
        offCanvas.width = outW; offCanvas.height = outH;

        const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
            ? "video/webm;codecs=vp9" : "video/webm";
        const stream   = offCanvas.captureStream(0);
        const track    = stream.getVideoTracks()[0];
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
        const chunks   = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

        recorder.start();
        for (let f = 0; f <= totalFrames; f++) {
            seekToFrame(f, { silent: true });
            renderFrameToOffscreen(offCanvas, outW, outH);
            track.requestFrame();
            onProgress?.(`⏳ ${f + 1}/${totalFrames + 1}`);
            await new Promise(r => setTimeout(r, 0)); // レコーダーにフレームを渡す時間を確保
        }
        recorder.stop();
        await new Promise(r => { recorder.onstop = r; });
        return new Blob(chunks, { type: "video/webm" });
    }

    // アニメーション全体を透過GIFとしてエクスポートする(gif_encoder.jsを動的import)。
    async function exportAnimatedGif(onProgress) {
        const { AnimGifEncoder } = await import("./gif_encoder.js");
        const { outW, outH } = computeExportSize(480); // GIFは色量子化コストが大きいため控えめな解像度
        const offCanvas = document.createElement("canvas");
        offCanvas.width = outW; offCanvas.height = outH;
        const ctx = offCanvas.getContext("2d");

        const enc = new AnimGifEncoder(outW, outH);
        enc.setFps(fps);
        enc.setQuality(4);

        for (let f = 0; f <= totalFrames; f++) {
            seekToFrame(f, { silent: true });
            renderFrameToOffscreen(offCanvas, outW, outH);
            enc.addFrame(ctx.getImageData(0, 0, outW, outH));
            onProgress?.(`⏳ Capture ${f + 1}/${totalFrames + 1}`);
            await new Promise(r => setTimeout(r, 0));
        }
        // encode()はフレームごとにNeuQuant量子化(重い同期処理)を行うが内部でawaitして
        // イベントループへ制御を返すため、ここで長時間メインスレッドをブロックしない
        const bytes = await enc.encode((done, total) => onProgress?.(`⏳ Encode ${done}/${total}`));
        return new Blob([bytes], { type: "image/gif" });
    }

    async function runExport(btn, otherBtn, exportFn, filename) {
        stopPlayback();
        const savedFrame = currentFrame;
        const origLabel = btn.textContent;
        btn.disabled = true; otherBtn.disabled = true;
        try {
            const blob = await exportFn(text => { btn.textContent = text; });
            downloadBlob(blob, filename);
        } catch (e) {
            alert("Export failed: " + e.message);
        } finally {
            btn.textContent = origLabel;
            btn.disabled = false; otherBtn.disabled = false;
            seekToFrame(savedFrame);
        }
    }
    webmBtn.onclick = () => runExport(webmBtn, gifBtn, exportVideoWebM, "animation.webm");
    gifBtn.onclick  = () => runExport(gifBtn, webmBtn, exportAnimatedGif, "animation.gif");

    // ----------------------------------------------------------------
    // Reset Pose / Reset Camera (旧: ノード側ツールバーにあったRP/RCボタンをここへ移設)
    // ----------------------------------------------------------------
    rpBtn.onclick = () => editor.resetPose();
    rcBtn.onclick = () => editor.resetCamera();

    // ----------------------------------------------------------------
    // New (タイムラインの全クリア)
    // ----------------------------------------------------------------
    newBtn.onclick = () => {
        showOverlayDialog({
            title: "🆕 New Timeline",
            message: "現在のキーフレーム(ポーズ・カメラ)をすべて削除して新規作成します。保存していない変更は失われます。",
            okLabel: "Clear",
            okBg: "#8a3a3a",
            onOk: () => {
                keyframes = [];
                fps = 24; fpsInput.value = "24";
                totalFrames = 60; totalInput.value = "60";
                currentFrame = 0; frameInput.value = "0";
                poseCounter = 1;
                editor.clearVRMA();
                drawTimeline();
                updateStatus();
            },
        });
    };

    // ----------------------------------------------------------------
    // Proj (プロジェクト保存/読込、サーバー側 .kf_projects/ を使用)
    // ----------------------------------------------------------------
    async function apiFetchJson(url, opts) {
        const res = await fetch(url, opts);
        if (!res.ok) {
            const t = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
        }
        return res.json();
    }

    function currentProjectPayload() {
        return { fps, totalFrames, keyframes: JSON.parse(JSON.stringify(keyframes)) };
    }

    function applyProject(data) {
        fps = data.fps ?? 24;
        totalFrames = data.totalFrames ?? 60;
        keyframes = Array.isArray(data.keyframes) ? data.keyframes : [];
        keyframes.sort((a, b) => a.frame - b.frame);
        currentFrame = 0;
        fpsInput.value = String(fps);
        totalInput.value = String(totalFrames);
        frameInput.value = "0";
        drawTimeline();
        updateStatus();
        applyCameraForFrame(0);
        applyShapeKeysForFrame(0);
        schedulePreviewRefresh();
    }

    async function renderProjectList() {
        projView.innerHTML = "";
        const topRow = el("div", { style: "display:flex;gap:6px;margin-bottom:4px;" });
        const backBtn = mkBtn("← Back", "#444");
        backBtn.onclick = () => { projView.style.display = "none"; };
        const saveBtn2 = mkBtn("💾 Save Current as New Project", "#2a5a3a");
        saveBtn2.onclick = () => {
            showOverlayDialog({
                title: "💾 プロジェクト名を入力",
                showInput: true,
                okLabel: "Save",
                okBg: "#2a5a3a",
                onOk: async (name) => {
                    try {
                        await apiFetchJson("/kf_project/save", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name, project: currentProjectPayload() }),
                        });
                        renderProjectList();
                    } catch (e) {
                        console.error("[KeyframePanel] project save failed:", e);
                    }
                },
            });
        };
        topRow.append(backBtn, saveBtn2);
        projView.appendChild(topRow);

        const listWrap = el("div", { style: "display:flex;flex-direction:column;gap:4px;" });
        listWrap.appendChild(el("div", { style: "font-size:11px;color:#888;padding:4px 0;" }, "Loading projects…"));
        projView.appendChild(listWrap);

        try {
            const data = await apiFetchJson("/kf_project/list");
            listWrap.innerHTML = "";
            const projects = data.projects ?? [];
            if (projects.length === 0) {
                listWrap.appendChild(el("div", { style: "font-size:11px;color:#666;padding:4px 0;" }, "No saved projects."));
            }
            for (const proj of projects) {
                const row = el("div", {
                    style: "display:flex;align-items:center;gap:6px;padding:5px 8px;" +
                           "background:#2a2a3e;border-radius:4px;cursor:pointer;",
                });
                const info = el("div", { style: "flex:1;overflow:hidden;" });
                info.appendChild(el("div", {
                    style: "font-size:11px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                }, proj.name));
                info.appendChild(el("div", { style: "font-size:9px;color:#666;" },
                    `${proj.keyframeCount} KF · ${proj.fps}fps · ${proj.totalFrames}f`));
                const delBtn2 = el("button", {
                    style: "padding:2px 7px;background:#5a3a3a;color:#fff;border:none;border-radius:3px;" +
                           "cursor:pointer;font-size:11px;flex-shrink:0;",
                }, "✕");
                delBtn2.onclick = async (e) => {
                    e.stopPropagation();
                    try {
                        await apiFetchJson("/kf_project/delete", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: proj.id }),
                        });
                        renderProjectList();
                    } catch (err) {
                        console.error("[KeyframePanel] project delete failed:", err);
                    }
                };
                row.addEventListener("mouseenter", () => row.style.background = "#3a3a52");
                row.addEventListener("mouseleave", () => row.style.background = "#2a2a3e");
                row.addEventListener("click", async () => {
                    try {
                        const full = await apiFetchJson(`/kf_project/get/${proj.id}`);
                        applyProject(full);
                        projView.style.display = "none";
                    } catch (err) {
                        console.error("[KeyframePanel] project load failed:", err);
                    }
                });
                row.append(info, delBtn2);
                listWrap.appendChild(row);
            }
        } catch (e) {
            listWrap.innerHTML = "";
            listWrap.appendChild(el("div", { style: "font-size:11px;color:#e07a7a;padding:8px;" }, "Error: " + e.message));
        }
    }

    projBtn.onclick = () => {
        libView.style.display = "none";
        const willShow = projView.style.display === "none";
        projView.style.display = willShow ? "flex" : "none";
        if (willShow) renderProjectList();
    };

    // ----------------------------------------------------------------
    // 初期化
    // ----------------------------------------------------------------
    updateStatus();
    frameInput.value = "0";
    totalInput.value = String(totalFrames);
    fpsInput.value = String(fps);
    requestAnimationFrame(() => {
        resizeCanvas();
        resizeObserver = new ResizeObserver(resizeCanvas);
        resizeObserver.observe(canvas);
    });

    return { el: panel, destroy };
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "style") e.style.cssText = v;
        else e[k] = v;
    }
    if (text !== undefined) e.textContent = text;
    return e;
}

function mkBtn(label, bg, title = "") {
    const btn = el("button", {
        style: `padding:5px 11px;background:${bg};color:#fff;border:none;` +
               "border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;" +
               "white-space:nowrap;transition:opacity 0.15s;",
    }, label);
    if (title) btn.title = title;
    btn.addEventListener("mouseenter", () => btn.style.opacity = "0.8");
    btn.addEventListener("mouseleave", () => btn.style.opacity = "1");
    return btn;
}

function mkToggle(label, title = "") {
    const btn = el("button", {
        style: "padding:5px 11px;background:#333344;color:#fff;border:none;" +
               "border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;white-space:nowrap;",
    }, label);
    if (title) btn.title = title;
    return btn;
}

function mkNumInput(min, max, step, value) {
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = min; inp.max = max; inp.step = step;
    inp.value = value;
    inp.style.cssText =
        "width:48px;background:#111;border:1px solid #444;color:#ddd;" +
        "padding:3px 5px;border-radius:4px;font-size:11px;text-align:right;flex-shrink:0;" +
        "appearance:textfield;-moz-appearance:textfield;";
    inp.addEventListener("wheel",   e => e.stopPropagation(), { passive: true });
    inp.addEventListener("keydown", e => e.stopPropagation());
    return inp;
}

function sep() {
    return el("span", { style: "color:#333;margin:0 2px;" }, "|");
}

// ArrayBuffer(.vrma glbバイナリ)をbase64文字列に変換する。
// 大きいファイルでのコールスタックオーバーフローを避けるためチャンク単位でString.fromCharCodeする
function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

// 自作オーバーレイダイアログ(確認/名前入力)。window.alert/confirm/promptは使わない
// (ブラウザ自動操作環境でnative dialogがタブをブロックする問題を避けるため)。
function showOverlayDialog({ title, message, showInput = false, inputValue = "", okLabel = "OK", okBg = "#2a5a8a", onOk }) {
    const dlg = el("div", {
        style: "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100002;" +
               "display:flex;align-items:center;justify-content:center;",
    });
    const box = el("div", {
        style: "background:#1e1e3a;border-radius:8px;padding:16px;min-width:260px;" +
               "box-shadow:0 6px 24px rgba(0,0,0,0.7);font-family:sans-serif;",
    });
    box.appendChild(el("div", { style: "font-size:13px;font-weight:bold;color:#e0e0ff;margin-bottom:10px;" }, title));
    if (message) {
        box.appendChild(el("div", { style: "font-size:12px;color:#ccc;margin-bottom:10px;max-width:280px;" }, message));
    }
    let input = null;
    if (showInput) {
        input = el("input", {
            type: "text", value: inputValue, placeholder: "例: シーン1",
            style: "width:100%;box-sizing:border-box;background:#111;border:1px solid #555;" +
                   "color:#ddd;padding:6px 10px;border-radius:4px;font-size:13px;",
        });
        input.addEventListener("keydown", e => {
            e.stopPropagation();
            if (e.key === "Enter") ok();
            if (e.key === "Escape") dlg.remove();
        });
        box.appendChild(input);
    }
    const btnRow = el("div", { style: "display:flex;gap:6px;justify-content:flex-end;margin-top:10px;" });
    const cancelBtn = el("button", {
        style: "padding:5px 12px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;",
    }, "Cancel");
    const okBtn = el("button", {
        style: `padding:5px 12px;background:${okBg};color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;`,
    }, okLabel);
    function ok() {
        if (showInput) {
            const val = input.value.trim();
            if (!val) { input.style.border = "1px solid #a55"; return; }
            dlg.remove();
            onOk(val);
        } else {
            dlg.remove();
            onOk();
        }
    }
    cancelBtn.onclick = () => dlg.remove();
    okBtn.onclick = ok;
    btnRow.append(cancelBtn, okBtn);
    box.appendChild(btnRow);
    dlg.appendChild(box);
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.remove(); });
    document.body.appendChild(dlg);
    setTimeout(() => { (input ?? okBtn).focus(); input?.select(); }, 0);
    return dlg;
}
