/**
 * VRMA Keyframe Panel (フレームベース)
 * - フレーム番号ベースでキーフレームを管理する（PSD-Figure-Creator, feat/keyframe-video の
 *   psd_loader.js のUXパターンを参考: 現在位置に追加/削除ボタン、タイムライン上でドラッグ移動）
 * - editor.exportVrma() は秒単位のtimeを要求するため、fps設定で time = frame / fps に変換して渡す
 * - プレビュー再生は「自己ロードバック」方式: 生成したglbをそのまま editor.loadVRMAFromBuffer() に渡し、
 *   既存のVRMA再生機構(playVRMA/pauseVRMA/seekVRMA等)をそのまま流用する
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
// 戻り値: { el, destroy } — el を呼び出し元のDOMへ追加し、閉じる際に destroy() を呼ぶこと
// ----------------------------------------------------------------
export function buildKeyframePanel(editor, getVrmBuffer) {
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
    const moveBtn = mkToggle("🔀 Move", "ONの間はタイムライン上のマーカーをドラッグして移動できます");

    const gotoStartBtn = mkBtn("⏮", "#333344", "フレーム0へ");
    const prevBtn = mkBtn("❮", "#333344", "1フレーム戻る");
    const frameInput = mkNumInput(0, 100000, 1, 0);
    const slashLbl = el("span", { style: "font-size:11px;color:#666;" }, "/");
    const totalInput = mkNumInput(1, 100000, 1, 60);
    const nextBtn = mkBtn("❯", "#333344", "1フレーム進む");

    toolbar.append(
        titleEl, addBtn, delBtn, addFromLibBtn,
        sep(), moveBtn,
        sep(), gotoStartBtn, prevBtn, frameInput, slashLbl, totalInput, nextBtn,
    );

    // ---- ライブラリピッカー(サブビュー、通常は非表示) ----
    const libView = el("div", {
        style: "display:none;flex-direction:column;gap:4px;max-height:140px;overflow-y:auto;" +
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
    const statusMsg = el("span", { style: "flex:1;font-size:11px;color:#888;min-width:80px;" }, "0 keyframes");
    const playBtn = el("button", {
        style: "padding:4px 10px;background:#4a90d9;color:#fff;border:none;border-radius:3px;" +
               "cursor:pointer;font-size:12px;flex-shrink:0;",
    }, "▶");
    const downloadBtn = mkBtn("⬇️ Download .vrma", "#4a7a4a", "Export and download the animation as .vrma");
    previewPanel.append(fpsLbl, fpsInput, statusMsg, playBtn, downloadBtn);

    panel.append(toolbar, libView, timelineWrap, previewPanel);

    // ----------------------------------------------------------------
    // 状態
    // ----------------------------------------------------------------
    let keyframes = [];      // { frame:number, label:string, bones } (frame昇順)
    let fps = 24;
    let totalFrames = 60;
    let currentFrame = 0;
    let moveMode = false;
    let poseCounter = 1;

    let dpr = window.devicePixelRatio || 1;
    let resizeObserver = null;
    let _uiSyncId = null;    // プレビュー再生中のフレーム表示追従rAF
    let _debounceId = null;  // プレビュー再生成のデバウンス
    let draggingFrame = null; // Moveモード中、ドラッグ中のKFの現在フレーム値
    let isScrubbing = false;  // 非Moveモード中のタイムラインドラッグ(スクラブ)

    function destroy() {
        if (_uiSyncId !== null) { cancelAnimationFrame(_uiSyncId); _uiSyncId = null; }
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
        statusMsg.textContent = `${keyframes.length} keyframe${keyframes.length === 1 ? "" : "s"}`;
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
        if (!opts.silent) drawTimeline();
    }

    // ----------------------------------------------------------------
    // 現在フレームへのキーフレーム追加/上書き・削除
    // ----------------------------------------------------------------
    function captureAtCurrentFrame(label, bonesOverride) {
        let bones = bonesOverride;
        if (!bones) {
            const json = editor.exportPose?.();
            if (!json) { alert("No pose data available. Load a VRM model first."); return; }
            bones = JSON.parse(json).bones;
        }
        const existing = keyframes.find(k => k.frame === currentFrame);
        if (existing) {
            existing.bones = bones;
            if (label) existing.label = label;
        } else {
            keyframes.push({ frame: currentFrame, label: label ?? `Pose ${poseCounter++}`, bones });
            keyframes.sort((a, b) => a.frame - b.frame);
        }
        ensureTotalFrames();
        drawTimeline();
        updateStatus();
        schedulePreviewRefresh();
    }
    addBtn.onclick = () => captureAtCurrentFrame();

    function deleteAtCurrentFrame() {
        const before = keyframes.length;
        keyframes = keyframes.filter(k => k.frame !== currentFrame);
        if (keyframes.length !== before) {
            drawTimeline();
            updateStatus();
            schedulePreviewRefresh();
        }
    }
    delBtn.onclick = deleteAtCurrentFrame;

    // ----------------------------------------------------------------
    // 「ポーズライブラリから追加」(簡易一覧サブビュー)
    // ----------------------------------------------------------------
    async function apiFetch(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async function openLibraryPicker() {
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

            const poses = data.poses ?? [];
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
            ctx.save();
            ctx.translate(x, midY);
            ctx.rotate(Math.PI / 4);
            if (isCurrent) { ctx.shadowColor = "#ffe066"; ctx.shadowBlur = 8; }
            ctx.fillStyle = isCurrent ? "#ffe066" : "#ffdd44";
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
            if (editor.isVRMAPlaying()) { editor.pauseVRMA(); _setPlayingUI(false); }
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
    // プレビュー再生(自己ロードバック方式)
    // ----------------------------------------------------------------
    function _startUiSync() {
        if (_uiSyncId !== null) return;
        const tick = () => {
            if (!editor.isVRMAPlaying()) { _uiSyncId = null; return; }
            currentFrame = clampFrame(editor.getVRMATime() * fps);
            frameInput.value = String(currentFrame);
            drawTimeline();
            _uiSyncId = requestAnimationFrame(tick);
        };
        _uiSyncId = requestAnimationFrame(tick);
    }
    function _setPlayingUI(playing) {
        playBtn.textContent = playing ? "⏸" : "▶";
        if (playing) _startUiSync();
    }

    async function refreshPreview() {
        if (keyframes.length === 0) {
            editor.clearVRMA();
            return;
        }
        try {
            const buf = await editor.exportVrma(keyframes.map(k => ({ time: k.frame / fps, bones: k.bones })));
            await new Promise((resolve, reject) => {
                editor.loadVRMAFromBuffer(buf, resolve, (msg) => reject(new Error(msg)));
            });
            seekToFrame(currentFrame, { silent: true });
            drawTimeline();
            _setPlayingUI(false);
        } catch (e) {
            console.error("[KeyframePanel] preview refresh failed:", e);
        }
    }
    function schedulePreviewRefresh() {
        if (_debounceId !== null) clearTimeout(_debounceId);
        _debounceId = setTimeout(refreshPreview, 400);
    }

    playBtn.onclick = () => {
        if (!editor.hasVRMA()) return;
        if (editor.isVRMAPlaying()) { editor.pauseVRMA(); _setPlayingUI(false); }
        else { editor.playVRMA(); _setPlayingUI(true); }
    };

    // ----------------------------------------------------------------
    // ダウンロード
    // ----------------------------------------------------------------
    downloadBtn.onclick = async () => {
        if (keyframes.length === 0) { alert("Add at least one keyframe pose first."); return; }
        downloadBtn.textContent = "⏳";
        try {
            const buf = await editor.exportVrma(keyframes.map(k => ({ time: k.frame / fps, bones: k.bones })));
            const blob = new Blob([buf], { type: "model/gltf-binary" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "animation.vrma";
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (e) {
            alert("Export failed: " + e.message);
        } finally {
            downloadBtn.textContent = "⬇️ Download .vrma";
        }
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
