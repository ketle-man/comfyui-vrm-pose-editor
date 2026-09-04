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
// 戻り値: { el, destroy, getState, importVrmaAsKeyframes } — el を呼び出し元のDOMへ追加し、
//   閉じる際に destroy() を呼ぶこと。importVrmaAsKeyframes(buffer, label) はPose Libraryの
//   「Import as Keyframes」ボタンから、選択中の.vrmaをPoseトラックへサンプリング読み込みするために使う。
// ----------------------------------------------------------------
// initialState: { keyframes, fps, totalFrames, currentFrame, poseCounter } (省略可)。
//   モーダルを閉じる際に getState() で取得した値を、呼び出し元(light_editor.js)が
//   editor側に保持しておき、再度開く際にここへ渡すことでタイムラインを復元する
//   (editorを閉じるたびにキーフレームが消えてしまう問題への対応)。
// nodeActions: { doCapture } (省略可)。ノード側(pose_editor_3d.js)にしか無い画像キャプチャ処理を
//   このパネルに複製したCaptureボタンから呼び出すためのブリッジ(pose_editor_3d.jsのdoCaptureをそのまま再利用)。
export function buildKeyframePanel(editor, getVrmBuffer, getShapeKeys, onShapeKeysApplied, initialState, nodeActions) {
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

    // ---- トラック選択(Pose/Camera/Light) ----
    // 統合タイムラインは選択中トラックのKFだけを表示し、Add/Delete KFボタンも選択中トラック用の
    // 1組に差し替える(以前はトラックごとに専用ボタンが並んでいたが、3トラック化で煩雑になったため統一)。
    const trackSelect = document.createElement("select");
    trackSelect.style.cssText =
        "background:#222236;color:#ddd;border:1px solid #444;border-radius:4px;" +
        "padding:4px 6px;font-size:11px;font-weight:bold;cursor:pointer;";
    trackSelect.title = "編集するトラックを選択";
    [["pose", "🕺 Pose"], ["camera", "📷 Camera"], ["cameraSwitch", "🎬 Cam Switch"], ["light", "💡 Light"], ["wind", "🌬 Wind"]].forEach(([v, t]) => {
        const opt = document.createElement("option");
        opt.value = v; opt.textContent = t;
        trackSelect.appendChild(opt);
    });
    trackSelect.addEventListener("wheel", e => e.stopPropagation(), { passive: true });

    const addBtn = mkBtn("✚ Add/Update KF", "#4a7a4a", "");
    const delBtn = mkBtn("− Delete KF", "#5a3a3a", "");
    const addFromLibBtn = mkBtn("📚 + From Library", "#4a4a8a", "ポーズライブラリから選んで現在フレームに追加/上書き");
    const moveBtn = mkToggle("🔀 Move", "ONの間はタイムライン上の(選択中トラックの)マーカーをドラッグして移動できます");
    const deleteModeBtn = mkToggle("🗑 Delete Mode", "ONの間はタイムライン上の(選択中トラックの)マーカーをクリック/ドラッグして削除できます");

    const gotoStartBtn = mkBtn("⏮", "#333344", "フレーム0へ");
    const prevBtn = mkBtn("❮", "#333344", "1フレーム戻る");
    const frameInput = mkNumInput(0, 100000, 1, 0);
    const slashLbl = el("span", { style: "font-size:11px;color:#666;" }, "/");
    const totalInput = mkNumInput(1, 100000, 1, 60);
    const nextBtn = mkBtn("❯", "#333344", "1フレーム進む");

    // ---- アクティブカメラ手動切替(要件: フレーム数入力・送りボタンの右端) ----
    // 選択すると即座にアクティブカメラを切り替えるだけで、キーフレーム記録は行わない
    // (記録は従来通りtrackSelectで"🎬 Cam Switch"を選びaddBtnを押す既存フローに統一)
    const activeCameraSelect = document.createElement("select");
    activeCameraSelect.style.cssText =
        "background:#222236;color:#ddd;border:1px solid #444;border-radius:4px;" +
        "padding:4px 6px;font-size:11px;cursor:pointer;";
    activeCameraSelect.title = "アクティブカメラを手動切替";
    activeCameraSelect.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    function refreshCameraSelect() {
        const cams = editor.getCameras?.() ?? [];
        const cur = editor.getActiveCameraId?.();
        activeCameraSelect.innerHTML = "";
        cams.forEach(c => {
            const opt = document.createElement("option");
            opt.value = String(c.id);
            opt.textContent = (c.isDefault ? "🎥 " : "📷 ") + c.name;
            activeCameraSelect.appendChild(opt);
        });
        activeCameraSelect.value = String(cur);
    }
    activeCameraSelect.addEventListener("change", () => {
        editor.setActiveCameraId?.(Number(activeCameraSelect.value));
    });
    refreshCameraSelect();

    toolbar.append(
        titleEl, trackSelect, addBtn, delBtn, addFromLibBtn,
        sep(), moveBtn, deleteModeBtn,
        sep(), gotoStartBtn, prevBtn, frameInput, slashLbl, totalInput, nextBtn,
        sep(), activeCameraSelect,
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
    // Look at Target ON/OFF(元はlight_editor.jsのPoseタブ Propertiesにあったが、VRMモデルの
    // 視線誘導というグローバル機能でカメラ固有の設定ではないため、常設のこちらへ移設した)
    const lookAtBtn = mkBtn("👁 OFF", "#444");
    function syncLookAtBtn() {
        const on = editor.getLookAtEnabled?.() ?? false;
        lookAtBtn.textContent = on ? "👁 ON" : "👁 OFF";
        lookAtBtn.style.background = on ? "#1a9a9a" : "#444";
        lookAtBtn.title = `LookAt Target: ${on ? "ON (drag the cyan marker)" : "OFF"}`;
    }
    syncLookAtBtn();
    lookAtBtn.onclick = () => { editor.toggleLookAt?.(); syncLookAtBtn(); };

    // ノード側にある「↔ Mirror Pose」の複製ボタン(pose_editor_3d.js)。左右反転したポーズをその場で
    // editor.mirrorPose()するだけなので、ノードコンテキストは不要でeditorから直接呼べる
    const mirrorBtn = mkBtn("↔ Mirror", "#5a6a7a", "Mirror Pose (flip left/right)");
    mirrorBtn.onclick = () => editor.mirrorPose();
    const playBtn = el("button", {
        style: "padding:4px 10px;background:#4a90d9;color:#fff;border:none;border-radius:3px;" +
               "cursor:pointer;font-size:12px;flex-shrink:0;",
    }, "▶");
    const downloadBtn = mkBtn("💾 Save .vrma", "#4a7a4a", "Export and save the animation to poses/ (visible in Pose Library)");
    // ノード側の「📸 Capture」の複製ボタン。実処理(image_data出力ウィジェットへの書き込み等)は
    // nodeActions.doCapture(pose_editor_3d.js)をそのまま呼び出す
    const captureBtn = mkBtn("📸 Capture", "#4a90d9", "Send pose to output");
    captureBtn.onclick = () => {
        nodeActions?.doCapture?.();
        captureBtn.textContent = "✅ Captured!";
        captureBtn.style.background = "#28a745";
        setTimeout(() => {
            captureBtn.textContent = "📸 Capture";
            captureBtn.style.background = "#4a90d9";
        }, 1500);
    };
    const webmBtn = mkBtn("🎬 WebM", "#3a6a8a", "タイムライン全体(ポーズ・カメラ・シェイプキー)をWebM動画としてダウンロード");
    const gifBtn = mkBtn("🎞️ GIF", "#3a6a8a", "タイムライン全体を透過GIFとしてダウンロード(フレーム数が多いと時間がかかります)");
    previewPanel.append(
        fpsLbl, fpsInput, newBtn, projBtn, rpBtn, rcBtn, statusMsg, lookAtBtn, mirrorBtn,
        playBtn, downloadBtn, captureBtn, webmBtn, gifBtn,
    );

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
    let deleteMode = false;
    let _deletingSession = false; // Deleteモード中、mousedown〜mouseupの間クリック/ドラッグで連続削除する
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
        const camSwitchCount = keyframes.filter(k => k.cameraId !== undefined).length;
        const lightCount = keyframes.filter(k => k.light).length;
        const windCount = keyframes.filter(k => k.wind).length;
        statusMsg.textContent = `${poseCount} pose · ${camCount} camera · ${camSwitchCount} cam-switch · ${lightCount} light · ${windCount} wind`;
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
        // カット切替(cameraSwitch)でアクティブカメラを先に確定させてから、連続値cameraトラックの
        // 補間値をそのカメラへ適用する(順序が逆だと古いアクティブカメラに位置を書いてしまう)
        applyCameraSwitchForFrame(currentFrame);
        applyCameraForFrame(currentFrame);
        applyShapeKeysForFrame(currentFrame);
        applyLookAtForFrame(currentFrame);
        applyLightForFrame(currentFrame);
        applyWindForFrame(currentFrame);
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

    // Look at Target(視線ターゲット)のON/OFF・座標のスナップショット。shapeKeysと同様、
    // ポーズKFに束ねて保存する(視線もキャラクターの姿勢の一部として扱う)。
    function captureLookAtSnapshot() {
        return { enabled: editor.getLookAtEnabled?.() ?? false, position: editor.getLookAtPosition?.() };
    }

    function captureAtCurrentFrame(label, bonesOverride) {
        let bones = bonesOverride;
        if (!bones) {
            const json = editor.exportPose?.();
            if (!json) { alert("No pose data available. Load a VRM model first."); return; }
            bones = JSON.parse(json).bones;
        }
        const shapeKeys = captureShapeKeysSnapshot();
        const lookAt = captureLookAtSnapshot();
        const existing = keyframes.find(k => k.frame === currentFrame);
        if (existing) {
            existing.bones = bones;
            if (shapeKeys) existing.shapeKeys = shapeKeys;
            existing.lookAt = lookAt;
            if (label) existing.label = label;
        } else {
            keyframes.push({
                frame: currentFrame, label: label ?? `Pose ${poseCounter++}`, bones,
                ...(shapeKeys ? { shapeKeys } : {}),
                lookAt,
            });
            keyframes.sort((a, b) => a.frame - b.frame);
        }
        ensureTotalFrames();
        drawTimeline();
        updateStatus();
        schedulePreviewRefresh();
    }

    // ポーズ(bones/shapeKeys/lookAt)のフィールドだけを削除する(camera/lightが残っていればエントリ自体は維持)。
    // PSD-Figure-Creatorのdeleteキーフレーム実装(pose/camera独立管理)を踏襲。
    function deleteAtCurrentFrame() {
        const idx = keyframes.findIndex(k => k.frame === currentFrame);
        if (idx === -1) return;
        const kf = keyframes[idx];
        if (!kf.bones) return;
        delete kf.bones;
        delete kf.label;
        delete kf.shapeKeys;
        delete kf.lookAt;
        if (!kf.camera && !kf.light && !kf.wind && kf.cameraId === undefined) keyframes.splice(idx, 1);
        drawTimeline();
        updateStatus();
        schedulePreviewRefresh();
    }

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

    function deleteCameraAtCurrentFrame() {
        const idx = keyframes.findIndex(k => k.frame === currentFrame);
        if (idx === -1) return;
        const kf = keyframes[idx];
        if (!kf.camera) return;
        delete kf.camera;
        if (!kf.bones && !kf.light && !kf.wind && kf.cameraId === undefined) keyframes.splice(idx, 1);
        drawTimeline();
        updateStatus();
        applyCameraSwitchForFrame(currentFrame);
        applyCameraForFrame(currentFrame);
    }

    // ----------------------------------------------------------------
    // ライトキーフレーム(プレビュー内シーク/再生専用、.vrma書き出しには含めない)
    // - editor.getLights()が返す全ライトのconfigをまるごとスナップショットする(カメラと同じ方式)。
    // - KF間の補間はライトIDでマッチングし、両側に存在するライトだけを対象にする(片側にしか
    //   存在しないライト = 追加/削除タイミングをまたぐ場合は補間せずそのまま保持する簡易対応)。
    // ----------------------------------------------------------------
    function captureLightAtCurrentFrame() {
        const lights = editor.getLights?.();
        if (!lights) return;
        const snapshot = { lights: JSON.parse(JSON.stringify(lights)) };
        const existing = keyframes.find(k => k.frame === currentFrame);
        if (existing) {
            existing.light = snapshot;
        } else {
            keyframes.push({ frame: currentFrame, light: snapshot });
            keyframes.sort((a, b) => a.frame - b.frame);
        }
        ensureTotalFrames();
        drawTimeline();
        updateStatus();
    }

    function deleteLightAtCurrentFrame() {
        const idx = keyframes.findIndex(k => k.frame === currentFrame);
        if (idx === -1) return;
        const kf = keyframes[idx];
        if (!kf.light) return;
        delete kf.light;
        if (!kf.bones && !kf.camera && !kf.wind && kf.cameraId === undefined) keyframes.splice(idx, 1);
        drawTimeline();
        updateStatus();
        applyLightForFrame(currentFrame);
    }

    // ----------------------------------------------------------------
    // Windキーフレーム(プレビュー内シーク/再生専用、.vrma書き出しには含めない)
    // 以前はLightタブ内Environmentサブタブで設定するためLightトラックへ束ねていたが、
    // 独立したタイムラインが必要という要望により専用トラックへ分離した。
    // ----------------------------------------------------------------
    function captureWindSnapshot() {
        return {
            enabled:        editor.getWindEnabled?.() ?? false,
            strength:       editor.getWindStrength?.() ?? 0,
            direction:      editor.getWindDirection?.() ?? 0,
            turbulence:     editor.getWindTurbulence?.() ?? 0,
            sourceEnabled:  editor.getWindSourceEnabled?.() ?? false,
            sourcePosition: editor.getWindSourcePosition?.() ?? { x: 0, y: 0, z: 0 },
        };
    }

    function captureWindAtCurrentFrame() {
        const wind = captureWindSnapshot();
        const existing = keyframes.find(k => k.frame === currentFrame);
        if (existing) {
            existing.wind = wind;
        } else {
            keyframes.push({ frame: currentFrame, wind });
            keyframes.sort((a, b) => a.frame - b.frame);
        }
        ensureTotalFrames();
        drawTimeline();
        updateStatus();
    }

    function deleteWindAtCurrentFrame() {
        const idx = keyframes.findIndex(k => k.frame === currentFrame);
        if (idx === -1) return;
        const kf = keyframes[idx];
        if (!kf.wind) return;
        delete kf.wind;
        if (!kf.bones && !kf.camera && !kf.light && kf.cameraId === undefined) keyframes.splice(idx, 1);
        drawTimeline();
        updateStatus();
        applyWindForFrame(currentFrame);
    }

    // ----------------------------------------------------------------
    // カメラ切替(カット)キーフレーム — 複数カメラのうち「どれがアクティブか」を離散的に記録・再生する。
    // 既存のcameraトラック(position/target/up/fovの連続値補間)とは別フィールド(cameraId)として
    // 同一エントリに同居させる。cameraIdはデフォルトカメラの0を取り得るためJSのfalsy判定に注意し、
    // 判定は必ず !== undefined で行うこと(truthyチェックすると id=0 のKFが無視されてしまう)。
    // 位置の線形補間はせず、Look at Target ON/OFFと同じ「区間終端で切り替わる」離散パターンを踏襲する。
    // ----------------------------------------------------------------
    function captureCameraSwitchAtCurrentFrame() {
        const id = editor.getActiveCameraId?.();
        if (id === undefined || id === null) return;
        const existing = keyframes.find(k => k.frame === currentFrame);
        if (existing) {
            existing.cameraId = id;
        } else {
            keyframes.push({ frame: currentFrame, cameraId: id });
            keyframes.sort((a, b) => a.frame - b.frame);
        }
        ensureTotalFrames();
        drawTimeline();
        updateStatus();
    }

    function deleteCameraSwitchAtCurrentFrame() {
        const idx = keyframes.findIndex(k => k.frame === currentFrame);
        if (idx === -1) return;
        const kf = keyframes[idx];
        if (kf.cameraId === undefined) return;
        delete kf.cameraId;
        if (!kf.bones && !kf.camera && !kf.light && !kf.wind) keyframes.splice(idx, 1);
        drawTimeline();
        updateStatus();
        applyCameraSwitchForFrame(currentFrame);
    }

    // cameraIdを持つエントリだけを対象に、指定フレーム以前で最後に打たれたカメラ切替KFの
    // cameraIdをアクティブカメラへ適用する(区間終端で切り替わる離散パターン、線形補間はしない)。
    // カメラ切替KFが1つも無ければ何もしない(手動のカメラ選択操作を妨げない)。
    function applyCameraSwitchForFrame(frame) {
        const kfs = keyframes.filter(k => k.cameraId !== undefined).sort((a, b) => a.frame - b.frame);
        if (kfs.length === 0) return;
        let before = null;
        for (const k of kfs) { if (k.frame <= frame) before = k; }
        const target = before ?? kfs[0]; // 先頭KFより前のフレームでは先頭KFのカメラを採用
        if (editor.getActiveCameraId?.() !== target.cameraId) {
            editor.setActiveCameraId?.(target.cameraId);
            refreshCameraSelect(); // 再生中(rAFループ)の毎フレーム呼び出しでDOM再構築しないよう、切替時のみ更新
        }
    }

    // ----------------------------------------------------------------
    // トラック選択(Pose/Camera/Light)と、Add/Delete KFボタンの選択中トラックへのディスパッチ
    // ----------------------------------------------------------------
    const TRACKS = {
        pose: {
            field: "bones", color: "#ffdd44",
            addLabel: "✚ Add/Update Pose KF", addColor: "#4a7a4a",
            addTitle: "現在フレームに、今のポーズ(シェイプキー・Look at Target含む)をキーフレームとして追加/上書き",
            delLabel: "− Delete Pose KF",
            delTitle: "現在フレームのポーズキーフレームを削除",
            capture: () => captureAtCurrentFrame(), delete: () => deleteAtCurrentFrame(),
        },
        camera: {
            field: "camera", color: "#cc66ff",
            addLabel: "📷 + Cam KF", addColor: "#3a6a8a",
            addTitle: "現在フレームに、今のカメラ位置をキーフレームとして追加/上書き",
            delLabel: "📷 − Cam KF",
            delTitle: "現在フレームのカメラキーフレームを削除",
            capture: () => captureCameraAtCurrentFrame(), delete: () => deleteCameraAtCurrentFrame(),
        },
        cameraSwitch: {
            field: "cameraId", color: "#66ddff",
            addLabel: "🎬 + Cam Switch", addColor: "#2a6a8a",
            addTitle: "現在フレームに、今アクティブなカメラへの切替(カット)をキーフレームとして追加/上書き",
            delLabel: "🎬 − Cam Switch",
            delTitle: "現在フレームのカメラ切替キーフレームを削除",
            capture: () => captureCameraSwitchAtCurrentFrame(), delete: () => deleteCameraSwitchAtCurrentFrame(),
        },
        light: {
            field: "light", color: "#ff9f40",
            addLabel: "💡 + Light KF", addColor: "#8a6a2a",
            addTitle: "現在フレームに、今のライト設定をキーフレームとして追加/上書き",
            delLabel: "💡 − Light KF",
            delTitle: "現在フレームのライトキーフレームを削除",
            capture: () => captureLightAtCurrentFrame(), delete: () => deleteLightAtCurrentFrame(),
        },
        wind: {
            field: "wind", color: "#33ccff",
            addLabel: "🌬 + Wind KF", addColor: "#2a6a8a",
            addTitle: "現在フレームに、今のWind設定をキーフレームとして追加/上書き",
            delLabel: "🌬 − Wind KF",
            delTitle: "現在フレームのWindキーフレームを削除",
            capture: () => captureWindAtCurrentFrame(), delete: () => deleteWindAtCurrentFrame(),
        },
    };
    let selectedTrack = "pose";

    function applyTrackUI() {
        const t = TRACKS[selectedTrack];
        addBtn.textContent = t.addLabel; addBtn.title = t.addTitle; addBtn.style.background = t.addColor;
        delBtn.textContent = t.delLabel; delBtn.title = t.delTitle;
        // ポーズライブラリからの追加はポーズトラック専用の機能
        addFromLibBtn.style.display = selectedTrack === "pose" ? "" : "none";
        drawTimeline();
    }
    trackSelect.value = selectedTrack;
    trackSelect.addEventListener("change", () => { selectedTrack = trackSelect.value; applyTrackUI(); });
    addBtn.onclick = () => TRACKS[selectedTrack].capture();
    delBtn.onclick = () => TRACKS[selectedTrack].delete();
    applyTrackUI();

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
    // ライト補間 — プレビュー内シーク/再生専用。config内の数値フィールド(intensity/angle/penumbra/
    // decay/distance/width/height)とposition/targetは線形補間し、color/type/enabled等の非連続値は
    // 区間の終端(t=1)で後方KFの値に切り替える(lookAtのenabledと同じ扱い)。
    // ----------------------------------------------------------------
    function lerpLightConfig(a, b, t) {
        const result = { ...a };
        for (const key of Object.keys(b)) {
            const av = a[key], bv = b[key];
            if (typeof av === "number" && typeof bv === "number") {
                result[key] = lerp(av, bv, t);
            } else if (av && bv && typeof av === "object" && typeof bv === "object" && "x" in av && "x" in bv) {
                result[key] = lerpVec3(av, bv, t); // position / target
            } else {
                result[key] = t < 1 ? av : bv; // color / type / enabled / castShadow 等
            }
        }
        return result;
    }

    function lerpLightsState(a, b, t) {
        const bMap = new Map(b.lights.map(l => [l.id, l]));
        return {
            lights: a.lights.map(la => {
                const lb = bMap.get(la.id);
                // 片側のKFにしか存在しないライト(区間をまたいで追加/削除された)は補間せずそのまま保持する
                return lb ? lerpLightConfig(la, lb, t) : la;
            }),
        };
    }

    // light を持つエントリだけを対象に、指定フレームの状態を前後から線形補間して全ライトへ適用する。
    // ライトKFが1つも無ければ何もしない(ユーザーの手動編集を妨げない)。
    function applyLightForFrame(frame) {
        const lightKfs = keyframes.filter(k => k.light).sort((a, b) => a.frame - b.frame);
        if (lightKfs.length === 0) return;
        let before = null, after = null;
        for (const k of lightKfs) {
            if (k.frame <= frame) before = k;
            if (k.frame >= frame && !after) after = k;
        }
        let state;
        if (before && after) {
            state = before.frame === after.frame
                ? before.light
                : lerpLightsState(before.light, after.light, (frame - before.frame) / (after.frame - before.frame));
        } else {
            state = (before ?? after).light;
        }
        state.lights.forEach(cfg => editor.updateLight?.(cfg.id, cfg));
    }

    // wind を持つエントリだけを対象に、指定フレームの状態を前後から線形補間してWindへ適用する。
    // 数値フィールド(strength/direction/turbulence)とsourcePosition(x/y/z)は線形補間、
    // enabled/sourceEnabledは区間の終端で切り替わる — lerpLightConfig()はフィールド形状を見て
    // 汎用的に処理するため、ライトconfigと同じ関数をそのまま再利用できる。
    // WindKFが1つも無ければ何もしない(ユーザーの手動編集を妨げない)。
    function applyWindForFrame(frame) {
        const windKfs = keyframes.filter(k => k.wind).sort((a, b) => a.frame - b.frame);
        if (windKfs.length === 0) return;
        let before = null, after = null;
        for (const k of windKfs) {
            if (k.frame <= frame) before = k;
            if (k.frame >= frame && !after) after = k;
        }
        let state;
        if (before && after) {
            state = before.frame === after.frame
                ? before.wind
                : lerpLightConfig(before.wind, after.wind, (frame - before.frame) / (after.frame - before.frame));
        } else {
            state = (before ?? after).wind;
        }
        editor.setWindEnabled?.(state.enabled);
        editor.setWindStrength?.(state.strength);
        editor.setWindDirection?.(state.direction);
        editor.setWindTurbulence?.(state.turbulence);
        editor.setWindSourceEnabled?.(state.sourceEnabled);
        editor.setWindSourcePosition?.(state.sourcePosition);
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
    // Look at Target(視線ターゲット)補間 — プレビュー内シーク/再生専用。座標は前後のlookAt KFから
    // 線形補間するが、ON/OFFは連続値ではないため前方のKFの値をそのまま引き継ぐ(補間区間の終端t=1で
    // 後方KFの値に切り替わる)。
    // ----------------------------------------------------------------
    function lerpLookAtState(a, b, t) {
        return {
            enabled: t < 1 ? a.enabled : b.enabled,
            position: lerpVec3(a.position, b.position, t),
        };
    }

    function applyLookAtForFrame(frame) {
        const laKfs = keyframes.filter(k => k.lookAt).sort((a, b) => a.frame - b.frame);
        if (laKfs.length === 0) return;
        let before = null, after = null;
        for (const k of laKfs) {
            if (k.frame <= frame) before = k;
            if (k.frame >= frame && !after) after = k;
        }
        let state;
        if (before && after) {
            state = before.frame === after.frame
                ? before.lookAt
                : lerpLookAtState(before.lookAt, after.lookAt, (frame - before.frame) / (after.frame - before.frame));
        } else {
            state = (before ?? after).lookAt;
        }
        editor.setLookAtEnabled?.(state.enabled);
        editor.setLookAtPosition?.(state.position);
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

        // 選択中トラック(Pose/Camera/Light)のKFだけを表示する
        const trackField = TRACKS[selectedTrack].field;
        const trackColor = TRACKS[selectedTrack].color;
        // Cam Switchトラックのみ、どのカメラへの切替かをキーの色で見分けられるようにする
        const cameraColorMap = selectedTrack === "cameraSwitch"
            ? new Map((editor.getCameras?.() ?? []).map(c => [c.id, c.color]))
            : null;
        keyframes.filter(kf => kf[trackField] !== undefined).forEach(kf => {
            const x = xForFrame(kf.frame, cssW);
            const isCurrent = kf.frame === currentFrame;
            const size = isCurrent ? 9 : 7;
            const color = cameraColorMap ? (cameraColorMap.get(kf.cameraId) ?? trackColor) : trackColor;
            ctx.save();
            ctx.translate(x, midY);
            ctx.rotate(Math.PI / 4);
            if (isCurrent) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
            ctx.fillStyle = color;
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

    // 選択中トラックのKFだけを候補にする(他トラックのマーカーは非表示のためドラッグ対象にもしない)
    function nearestKeyframe(clientX) {
        const rect = canvas.getBoundingClientRect();
        const usableW = Math.max(1, rect.width - 12);
        const trackField = TRACKS[selectedTrack].field;
        let best = null, bestDist = Infinity;
        keyframes.filter(kf => kf[trackField] !== undefined).forEach(kf => {
            const t = totalFrames > 0 ? kf.frame / totalFrames : 0;
            const x = rect.left + 6 + t * usableW;
            const dist = Math.abs(clientX - x);
            if (dist < bestDist) { bestDist = dist; best = kf; }
        });
        return bestDist <= 10 ? best : null;
    }

    // 移動先に既存KFがあれば、選択中トラックのフィールドだけを上書きしてマージする(他トラックの
    // データが非表示のまま移動先に残っている場合でも、それを消さないようにするため)。
    function moveKeyframeFrame(fromFrame, toFrame) {
        if (fromFrame === toFrame) return;
        const idx = keyframes.findIndex(k => k.frame === fromFrame);
        if (idx === -1) return;
        const moved = keyframes[idx];
        keyframes.splice(idx, 1);
        const destIdx = keyframes.findIndex(k => k.frame === toFrame);
        if (destIdx !== -1) {
            Object.assign(keyframes[destIdx], moved, { frame: toFrame });
        } else {
            moved.frame = toFrame;
            keyframes.push(moved);
        }
        keyframes.sort((a, b) => a.frame - b.frame);
        ensureTotalFrames();
        updateStatus();
    }

    // Deleteモード: クリックまたはドラッグでなぞった位置の(選択中トラックの)キーフレームを
    // 連続的に削除する(消しゴムツールと同様のUX)。既存のTRACKS[track].delete()は常に
    // currentFrameを対象にする実装のため、削除対象フレームへ一時的にcurrentFrameを差し替えて
    // 呼び出し、直後に元のフレームへ戻す(表示上のシークは行わず、削除処理のためだけの一時退避)。
    function deleteKeyframeAtClientX(clientX) {
        const hit = nearestKeyframe(clientX);
        if (!hit) return;
        const prevFrame = currentFrame;
        currentFrame = hit.frame;
        TRACKS[selectedTrack].delete();
        currentFrame = prevFrame;
        // delete()内部のdrawTimeline()は一時退避フレーム(hit.frame)を基準に描画してしまっている
        // ため、元のフレームへ戻した上で再描画してプレイヘッド位置のズレを解消する
        seekToFrame(prevFrame, { silent: true });
        drawTimeline();
    }

    canvas.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (deleteMode) {
            _deletingSession = true;
            deleteKeyframeAtClientX(e.clientX);
            window.addEventListener("mousemove", onWindowMouseMove);
            window.addEventListener("mouseup", onWindowMouseUp);
        } else if (moveMode) {
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
        if (deleteMode && _deletingSession) {
            deleteKeyframeAtClientX(e.clientX);
        } else if (moveMode && draggingFrame !== null) {
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
        _deletingSession = false;
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
        if (moveMode) { deleteMode = false; deleteModeBtn.style.background = "#333344"; }
        moveBtn.style.background = moveMode ? "#7a4aa0" : "#333344";
        canvas.style.cursor = moveMode ? "grab" : (deleteMode ? "crosshair" : "pointer");
    };

    deleteModeBtn.onclick = () => {
        deleteMode = !deleteMode;
        if (deleteMode) { moveMode = false; moveBtn.style.background = "#333344"; }
        deleteModeBtn.style.background = deleteMode ? "#8a3a3a" : "#333344";
        canvas.style.cursor = deleteMode ? "crosshair" : (moveMode ? "grab" : "pointer");
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
            message: "現在のキーフレーム(ポーズ・カメラ・ライト・Wind)をすべて削除して新規作成します。保存していない変更は失われます。",
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
        applyCameraSwitchForFrame(0);
        applyCameraForFrame(0);
        applyShapeKeysForFrame(0);
        applyLookAtForFrame(0);
        applyLightForFrame(0);
        applyWindForFrame(0);
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
    // 状態の取得/復元(モーダル再オープン時の永続化用)
    // ----------------------------------------------------------------
    function getState() {
        return {
            keyframes: JSON.parse(JSON.stringify(keyframes)),
            fps, totalFrames, currentFrame, poseCounter,
        };
    }

    function restoreState(state) {
        fps = state.fps ?? fps;
        totalFrames = state.totalFrames ?? totalFrames;
        keyframes = Array.isArray(state.keyframes) ? state.keyframes : keyframes;
        keyframes.sort((a, b) => a.frame - b.frame);
        poseCounter = state.poseCounter ?? poseCounter;
        currentFrame = clampFrame(state.currentFrame ?? 0);
        fpsInput.value = String(fps);
        totalInput.value = String(totalFrames);
        frameInput.value = String(currentFrame);
        drawTimeline();
        updateStatus();
        applyCameraSwitchForFrame(currentFrame);
        applyCameraForFrame(currentFrame);
        applyShapeKeysForFrame(currentFrame);
        applyLookAtForFrame(currentFrame);
        applyLightForFrame(currentFrame);
        applyWindForFrame(currentFrame);
        schedulePreviewRefresh();
    }

    // ----------------------------------------------------------------
    // Pose Libraryで選択した.vrmaを、Poseトラックのキーフレーム列としてサンプリング読み込みする
    // (pose_library.jsの「Import as Keyframes」ボタンから呼ばれる)。
    // 各フレーム(現在のfps設定に基づく: frame = 0..round(duration*fps))でeditor.seekVRMA()→
    // editor.exportPose()を呼び、通常のポーズKF追加と同じ形でkeyframesへ書き込む。
    // 既存のPose KFがある場合は確認ダイアログの上ですべて置き換える(camera/light/windの各トラックは
    // フィールドごとの削除のため触れない)。読み込み終わったらexport元の外部VRMAクリップは
    // クリアし、以降は通常どおりcaptured KFsからrefreshPreview()が自前のプレビューを再生成する。
    // ----------------------------------------------------------------
    async function importVrmaAsKeyframes(buffer, label) {
        const hasExistingPose = keyframes.some(k => k.bones);
        if (hasExistingPose) {
            const proceed = await new Promise(resolve => {
                showOverlayDialog({
                    title: "⬇ Import VRMA as Keyframes",
                    message: "既存のポーズキーフレームをすべて削除して、この.vrmaからポーズKF列を読み込み直します。" +
                             "カメラ・ライト・Windのキーフレームはそのまま残ります。保存していない変更は失われます。",
                    okLabel: "Import", okBg: "#2a5a8a",
                    onOk: () => resolve(true),
                    onCancel: () => resolve(false),
                });
            });
            if (!proceed) return;
        }

        stopPlayback();
        await new Promise((resolve, reject) => {
            editor.loadVRMAFromBuffer(buffer, resolve, (msg) => reject(new Error(msg)));
        });

        // 既存エントリからポーズ関連フィールドだけを取り除く(camera/cameraId/light/windは維持)
        for (let i = keyframes.length - 1; i >= 0; i--) {
            const kf = keyframes[i];
            if (kf.bones) { delete kf.bones; delete kf.label; delete kf.shapeKeys; delete kf.lookAt; }
            if (!kf.bones && !kf.camera && !kf.light && !kf.wind && kf.cameraId === undefined) keyframes.splice(i, 1);
        }

        const duration = editor.getVRMADuration();
        const frameCount = Math.max(1, Math.round(duration * fps));
        for (let f = 0; f <= frameCount; f++) {
            editor.seekVRMA(f / fps);
            const json = editor.exportPose();
            if (!json) continue;
            const bones = JSON.parse(json).bones;
            const kfLabel = label ? `${label} ${f}` : `Pose ${poseCounter++}`;
            const existing = keyframes.find(k => k.frame === f);
            if (existing) {
                existing.bones = bones;
                existing.label = kfLabel;
            } else {
                keyframes.push({ frame: f, label: kfLabel, bones });
            }
            // 長い.vrmaでもメインスレッドを固め続けないよう、数フレームごとにイベントループへ制御を返す
            if (f % 8 === 0) await new Promise(r => setTimeout(r, 0));
        }
        keyframes.sort((a, b) => a.frame - b.frame);
        editor.clearVRMA();

        if (frameCount > totalFrames) { totalFrames = frameCount; totalInput.value = String(totalFrames); }
        selectedTrack = "pose";
        trackSelect.value = "pose";
        applyTrackUI();
        seekToFrame(0);
        updateStatus();
        schedulePreviewRefresh();
    }

    // ----------------------------------------------------------------
    // 初期化
    // ----------------------------------------------------------------
    if (initialState) {
        restoreState(initialState);
    } else {
        updateStatus();
        frameInput.value = "0";
        totalInput.value = String(totalFrames);
        fpsInput.value = String(fps);
    }
    requestAnimationFrame(() => {
        resizeCanvas();
        resizeObserver = new ResizeObserver(resizeCanvas);
        resizeObserver.observe(canvas);
    });

    return { el: panel, destroy, getState, importVrmaAsKeyframes, refreshCameraSelect, syncLookAtBtn, refreshTimeline: drawTimeline };
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
function showOverlayDialog({ title, message, showInput = false, inputValue = "", okLabel = "OK", okBg = "#2a5a8a", onOk, onCancel }) {
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
            if (e.key === "Escape") cancel();
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
    function cancel() { dlg.remove(); onCancel?.(); }
    cancelBtn.onclick = cancel;
    okBtn.onclick = ok;
    btnRow.append(cancelBtn, okBtn);
    box.appendChild(btnRow);
    dlg.appendChild(box);
    dlg.addEventListener("click", e => { if (e.target === dlg) cancel(); });
    document.body.appendChild(dlg);
    setTimeout(() => { (input ?? okBtn).focus(); input?.select(); }, 0);
    return dlg;
}
