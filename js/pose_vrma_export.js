/**
 * VRMA Timeline Editor UI
 * - 複数の静止ポーズ(ポーズライブラリ or 現在編集中のポーズ)を時刻付きキーフレームとして並べる
 * - editor.exportVrma() でTHREE.AnimationClip化 → GLTFExporterでglb(.vrma)化
 * - プレビュー再生は「自己ロードバック」方式: 生成したglbをそのまま editor.loadVRMAFromBuffer() に渡し、
 *   既存のVRMA再生機構(playVRMA/pauseVRMA/seekVRMA等)をそのまま流用する
 * - 本バージョンはブラウザダウンロードのみ(サーバー保存は未対応)
 */

// ----------------------------------------------------------------
// エントリポイント
// editor: initPoseEditor3D の戻り値（exportPose / exportVrma / loadVRMAFromBuffer 等を持つ）
// vrmBuffer: 現在ロード済みのVRMバッファ (ArrayBuffer|null、未使用だが将来のサムネイル生成用に受け取っておく)
// ----------------------------------------------------------------
export function openVrmaTimelineEditor(editor, vrmBuffer) {
    if (document.getElementById("vrma-export-modal")) return;
    document.body.appendChild(buildModal(editor, vrmBuffer));
}

function buildModal(editor, vrmBuffer) {
    const overlay = el("div", {
        id: "vrma-export-modal",
        style: "position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:99999;" +
               "display:flex;align-items:center;justify-content:center;",
    });

    const dialog = el("div", {
        style: "background:#1e1e2e;color:#ccc;border-radius:10px;" +
               "width:min(94vw,720px);max-height:min(90vh,700px);display:flex;flex-direction:column;" +
               "box-shadow:0 8px 40px rgba(0,0,0,0.85);overflow:hidden;font-family:sans-serif;",
    });

    // ---- ヘッダー ----
    const header = el("div", {
        style: "display:flex;align-items:center;gap:8px;padding:10px 14px;" +
               "background:#16213e;border-bottom:1px solid #333;flex-shrink:0;",
    });
    const titleEl  = el("span", { style: "font-size:15px;font-weight:bold;color:#e0e0ff;flex:1;" }, "🎬 VRMA Timeline Editor");
    const closeBtn = el("button", {
        style: "background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;padding:4px 8px;",
    }, "✕");
    header.append(titleEl, closeBtn);

    // ---- ツールバー(キーフレーム追加) ----
    const toolbar = el("div", {
        style: "display:flex;align-items:center;gap:6px;padding:7px 12px;" +
               "background:#1a1a2e;border-bottom:1px solid #2a2a4a;flex-shrink:0;flex-wrap:wrap;",
    });
    const addFromLibBtn = mkBtn("📚 + From Library", "#4a4a8a", "Add a pose from the pose library as a keyframe");
    const addCurrentBtn = mkBtn("✚ + Current Pose", "#4a7a4a", "Add the currently edited pose as a keyframe");
    const hint = el("span", { style: "font-size:10px;color:#666;margin-left:auto;" }, "VRM1 models recommended");
    toolbar.append(addFromLibBtn, addCurrentBtn, hint);

    // ---- コンテンツ(キーフレーム一覧 / ライブラリ選択サブビュー) ----
    const content = el("div", { style: "flex:1;overflow-y:auto;padding:10px 12px;box-sizing:border-box;min-height:120px;" });
    const listEl  = el("div", { style: "display:flex;flex-direction:column;gap:4px;" });
    const libView = el("div", { style: "display:none;flex-direction:column;gap:4px;" });
    content.append(listEl, libView);

    // ---- プレビューパネル ----
    const previewPanel = el("div", {
        style: "display:flex;align-items:center;gap:8px;padding:8px 14px;" +
               "background:#16213e;border-top:1px solid #2a2a4a;flex-shrink:0;",
    });
    const playBtn = el("button", {
        style: "padding:4px 10px;background:#4a90d9;color:#fff;border:none;border-radius:3px;" +
               "cursor:pointer;font-size:12px;flex-shrink:0;",
    }, "▶");
    const seekBar = el("input", {
        type: "range", min: "0", max: "1", step: "0.001", value: "0",
        style: "flex:1;height:14px;accent-color:#4a90d9;cursor:pointer;",
    });
    const timeLabel = el("span", { style: "font-size:10px;color:#aaa;white-space:nowrap;flex-shrink:0;" }, "0.0 / 0.0s");
    previewPanel.append(playBtn, seekBar, timeLabel);

    // ---- フッター(エクスポート) ----
    const footer = el("div", {
        style: "display:flex;align-items:center;gap:8px;padding:10px 14px;" +
               "background:#111;border-top:1px solid #2a2a3a;flex-shrink:0;",
    });
    const statusMsg = el("span", { style: "flex:1;font-size:11px;color:#888;" }, "0 keyframes");
    const downloadBtn = mkBtn("⬇️ Download .vrma", "#4a7a4a", "Export and download the animation as .vrma");
    footer.append(statusMsg, downloadBtn);

    dialog.append(header, toolbar, content, previewPanel, footer);
    overlay.appendChild(dialog);

    // ----------------------------------------------------------------
    // 状態
    // ----------------------------------------------------------------
    let keyframes = []; // { id, time, label, bones }
    let nextId = 1;
    let _uiSyncId = null;   // プレビュー再生中のシークバー追従rAF
    let _debounceId = null; // プレビュー再生成のデバウンス

    function close() {
        if (_uiSyncId !== null) { cancelAnimationFrame(_uiSyncId); _uiSyncId = null; }
        if (_debounceId !== null) { clearTimeout(_debounceId); _debounceId = null; }
        editor.clearVRMA();
        overlay.remove();
    }
    closeBtn.onclick = close;
    overlay.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    overlay.addEventListener("click",   e => { if (e.target === overlay) close(); });

    function nextTime() {
        if (!keyframes.length) return 0;
        return Math.round((Math.max(...keyframes.map(k => k.time)) + 1) * 10) / 10;
    }

    // ----------------------------------------------------------------
    // キーフレーム一覧の描画
    // ----------------------------------------------------------------
    function renderList() {
        listEl.innerHTML = "";
        keyframes.sort((a, b) => a.time - b.time);
        if (keyframes.length === 0) {
            listEl.appendChild(el("div", { style: "font-size:11px;color:#666;padding:8px;" },
                "No keyframes yet. Add poses from the library or the current pose above."));
        }
        keyframes.forEach(kf => {
            const row = el("div", {
                style: "display:flex;align-items:center;gap:6px;padding:5px 8px;" +
                       "background:#2a2a3e;border-radius:4px;",
            });
            const timeInput = el("input", {
                type: "number", step: "0.1", min: "0", value: String(kf.time),
                style: "width:60px;background:#111;border:1px solid #444;color:#ddd;" +
                       "padding:3px 5px;border-radius:3px;font-size:11px;",
            });
            timeInput.addEventListener("wheel", e => { e.stopPropagation(); }, { passive: true });
            timeInput.addEventListener("input", () => {
                kf.time = Math.max(0, parseFloat(timeInput.value) || 0);
                schedulePreviewRefresh();
            });
            timeInput.addEventListener("change", renderList); // 確定時にソートし直す

            const labelEl = el("span", {
                style: "flex:1;font-size:11px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
            }, kf.label);

            const delBtn = el("button", {
                style: "padding:2px 7px;background:#5a3a3a;color:#fff;border:none;border-radius:3px;" +
                       "cursor:pointer;font-size:11px;flex-shrink:0;",
            }, "✕");
            delBtn.onclick = () => {
                keyframes = keyframes.filter(k => k.id !== kf.id);
                renderList();
                schedulePreviewRefresh();
            };

            row.append(el("span", { style: "font-size:10px;color:#666;" }, "⏱"), timeInput,
                       el("span", { style: "font-size:10px;color:#666;" }, "s"), labelEl, delBtn);
            listEl.appendChild(row);
        });
        statusMsg.textContent = `${keyframes.length} keyframe${keyframes.length === 1 ? "" : "s"}`;
    }
    renderList();

    // ----------------------------------------------------------------
    // 「現在のポーズを追加」
    // ----------------------------------------------------------------
    let poseCounter = 1;
    addCurrentBtn.onclick = () => {
        const json = editor.exportPose?.();
        if (!json) { alert("No pose data available. Load a VRM model first."); return; }
        const parsed = JSON.parse(json);
        keyframes.push({ id: nextId++, time: nextTime(), label: `Pose ${poseCounter++}`, bones: parsed.bones });
        renderList();
        schedulePreviewRefresh();
    };

    // ----------------------------------------------------------------
    // 「ポーズライブラリから追加」(簡易一覧サブビュー)
    // ----------------------------------------------------------------
    async function apiFetch(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async function openLibraryPicker() {
        listEl.style.display = "none";
        libView.style.display = "flex";
        libView.innerHTML = "";
        libView.appendChild(el("div", { style: "font-size:11px;color:#888;padding:4px 0;" }, "Loading poses…"));
        try {
            const data = await apiFetch("/pose_library/list");
            libView.innerHTML = "";
            const backRow = el("div", { style: "margin-bottom:4px;" });
            const backBtn = mkBtn("← Back", "#444");
            backBtn.onclick = () => { libView.style.display = "none"; listEl.style.display = "flex"; };
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
                }, );
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
                        keyframes.push({ id: nextId++, time: nextTime(), label: pose.name, bones: normalized.bones });
                        renderList();
                        libView.style.display = "none";
                        listEl.style.display = "flex";
                        schedulePreviewRefresh();
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
    // プレビュー再生(自己ロードバック方式)
    // ----------------------------------------------------------------
    function _formatTime() {
        const dur = editor.getVRMADuration();
        const t = editor.getVRMATime();
        timeLabel.textContent = `${t.toFixed(1)} / ${dur.toFixed(1)}s`;
        seekBar.value = String(t);
    }
    function _startUiSync() {
        if (_uiSyncId !== null) return;
        const tick = () => {
            if (!editor.isVRMAPlaying()) { _uiSyncId = null; return; }
            _formatTime();
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
            seekBar.max = "1"; seekBar.value = "0";
            timeLabel.textContent = "0.0 / 0.0s";
            return;
        }
        try {
            const buf = await editor.exportVrma(keyframes.map(k => ({ time: k.time, bones: k.bones })));
            await new Promise((resolve, reject) => {
                editor.loadVRMAFromBuffer(buf, resolve, (msg) => reject(new Error(msg)));
            });
            seekBar.max = String(editor.getVRMADuration());
            _formatTime();
            _setPlayingUI(false);
        } catch (e) {
            console.error("[VrmaTimelineEditor] preview refresh failed:", e);
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
    seekBar.addEventListener("wheel", e => { e.stopPropagation(); }, { passive: true });
    seekBar.addEventListener("pointerdown", () => {
        if (editor.isVRMAPlaying()) { editor.pauseVRMA(); _setPlayingUI(false); }
    });
    seekBar.addEventListener("input", () => {
        if (!editor.hasVRMA()) return;
        editor.seekVRMA(parseFloat(seekBar.value));
        _formatTime();
    });

    // ----------------------------------------------------------------
    // ダウンロード
    // ----------------------------------------------------------------
    downloadBtn.onclick = async () => {
        if (keyframes.length === 0) { alert("Add at least one keyframe pose first."); return; }
        downloadBtn.textContent = "⏳";
        try {
            const buf = await editor.exportVrma(keyframes.map(k => ({ time: k.time, bones: k.bones })));
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

    return overlay;
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
