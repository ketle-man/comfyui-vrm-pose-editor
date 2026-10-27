// image_pose.js — Light & Pose Editor の「Image」タブ: 画像 → SAM 3D Body(ComfyUI ネイティブノード) → GLB → VRM ポーズ
// 動画を読み込んだときは 動画 → SAM 3D Body → BVH → VRM のモーション(キーフレーム)。BVH の変換は bvh_retarget.js
//
// ライセンス上の方針: SAM 3D Body のコード・モデル重みはこのリポジトリに一切含めない。
// ComfyUI 本体(0.38 以降)に同梱のネイティブノード(SAM3DBody_Loader / SAM3DBody_Predict / BuildPoseFile / SaveGLB)を
// ComfyUI の HTTP API(/upload/image → /prompt → /history → /view)でワークフローとして実行し、
// 出力された GLB をバイト列として受け取って解析するだけにしている。モデルはユーザーが各自のライセンスに同意して導入する。

import { fetchApi, clientId } from "./comfy_api.js";
import {
    classifyGlb, parseOpenposeGlb, parseMeshHands, samToPose,
    solvePose, defaultSolveOptions, captureRig, applySolvedPose,
} from "./image_pose_solver.js";
import { bvhTextToVrmaBuffer, peekBvh } from "./bvh_retarget.js";
import { askBvhImportOptions } from "./bvh_import_dialog.js";

const REQUIRED_NODES = ["SAM3DBody_Loader", "SAM3DBody_Predict", "BuildPoseFile", "SaveGLB"];
const VIDEO_NODES = ["LoadVideo", "Video Slice", "GetVideoComponents"];
const DEFAULT_VIDEO_SEC = 10; // 長い動画は既定で先頭 10 秒だけ取り込む(全フレームを推定するため)
const PREFERRED_MODEL = "sam_3d_body_dinov3_bf16.safetensors";

// ================================================================
// ComfyUI 実行
// ================================================================

async function getJson(path) {
    const res = await fetchApi(path);
    if (!res.ok) throw new Error(`ComfyUI ${path}: HTTP ${res.status}`);
    return res.json();
}

// object_info の COMBO 入力の選択肢(V1: [[...], {...}] / V3: ["COMBO", {options: [...]}] の両方に対応)
function comboOptions(spec) {
    if (!Array.isArray(spec)) return [];
    if (Array.isArray(spec[0])) return spec[0];
    return spec[1]?.options ?? [];
}

// ネイティブ SAM3D ノードの有無と、選べるモデルファイル一覧を返す
export async function checkSam3dAvailable() {
    const info = await getJson("/object_info");
    const missing = REQUIRED_NODES.filter(n => !info[n]);
    if (missing.length) {
        return { ok: false, models: [], message: `ComfyUI に SAM3D Body のネイティブノードがありません(${missing.join(", ")})。ComfyUI 0.38 以降に更新してください` };
    }
    const models = comboOptions(info.SAM3DBody_Loader?.input?.required?.model_file);
    if (!models.length) {
        return { ok: false, models, message: `SAM3D Body のモデルが見つかりません。models/detection/ に ${PREFERRED_MODEL} を置いてください` };
    }
    return { ok: true, models, message: "", videoOk: VIDEO_NODES.every(n => info[n]) };
}

function buildWorkflow(imageName, modelFile, prefix, handRefine = true) {
    const buildPose = (format) => ({
        class_type: "BuildPoseFile",
        inputs: {
            pose_data: ["3", 0], ...format, fps: 24.0, camera_translation: "off", track_index: -1, sam3d_body_model: ["2", 0],
        },
    });
    return {
        1: { class_type: "LoadImage", inputs: { image: imageName } },
        2: { class_type: "SAM3DBody_Loader", inputs: { model_file: modelFile } },
        3: {
            class_type: "SAM3DBody_Predict",
            inputs: { sam3d_body_model: ["2", 0], image: ["1", 0], run_hand_refinement: handRefine, fov: 0.0, batch_size: 64 },
        },
        // 3D 位置(骨名つきマーカー)。体の向きを解くのに使う
        4: buildPose({
            format: "glb", "format.mesh_style": "openpose", "format.mesh_style.marker_radius_m": 0.01,
            "format.mesh_style.stick_radius_m": 0.008, "format.mesh_style.include_hands": false,
            "format.mesh_style.hand_marker_radius_m": 0.005, "format.mesh_style.hand_stick_radius_m": 0.003,
            "format.mesh_style.face_style": "disabled", "format.mesh_style.face_marker_radius_m": 0.0,
            "format.bone_smooth_window": 0,
        }),
        // 人体メッシュ(MHR 骨格)。手首の向きと指の形を読むのに使う
        5: buildPose({
            format: "glb", "format.mesh_style": "body_mesh", "format.mesh_style.bone_vis": "off",
            "format.mesh_style.shader": "default", "format.bone_smooth_window": 0,
        }),
        6: { class_type: "SaveGLB", inputs: { mesh: ["4", 0], filename_prefix: `${prefix}_openpose` } },
        7: { class_type: "SaveGLB", inputs: { mesh: ["5", 0], filename_prefix: `${prefix}_mesh` } },
    };
}

// 動画 → BVH。fps は動画の値をつなぎ、腰の移動は 1 フレーム目からの変位(centered)にする。
// track_index -1(BVH は骨格 1 つ。複数人の追跡は SAM3 Video Track が要るので、ここでは扱わない)
function buildVideoWorkflow(videoName, modelFile, prefix, { startSec, durationSec, handRefine = true }) {
    return {
        1: { class_type: "LoadVideo", inputs: { file: videoName } },
        2: { class_type: "Video Slice", inputs: { video: ["1", 0], start_time: startSec, duration: durationSec, strict_duration: false } },
        3: { class_type: "GetVideoComponents", inputs: { video: ["2", 0] } },
        4: { class_type: "SAM3DBody_Loader", inputs: { model_file: modelFile } },
        5: {
            class_type: "SAM3DBody_Predict",
            inputs: { sam3d_body_model: ["4", 0], image: ["3", 0], run_hand_refinement: handRefine, fov: 0.0, batch_size: 64 },
        },
        6: {
            class_type: "BuildPoseFile",
            inputs: {
                pose_data: ["5", 0], format: "bvh", "format.units": "cm", fps: ["3", 2],
                camera_translation: "centered", track_index: -1, sam3d_body_model: ["4", 0],
            },
        },
        7: { class_type: "SaveGLB", inputs: { mesh: ["6", 0], filename_prefix: prefix } },
    };
}

async function downloadOutput(o) {
    const q = new URLSearchParams({ filename: o.filename, subfolder: o.subfolder ?? "", type: o.type ?? "output" });
    const res = await fetchApi(`/view?${q}`);
    if (!res.ok) throw new Error(`ComfyUI の出力を取得できません: ${o.filename} (HTTP ${res.status})`);
    return res.arrayBuffer();
}

// ComfyUI の input へファイルを送り、ワークフローから参照する名前(subfolder/name)を返す
async function uploadInput(blob, name, signal) {
    const form = new FormData();
    form.append("image", blob, name);
    form.append("overwrite", "true");
    const up = await fetchApi("/upload/image", { method: "POST", body: form, signal });
    if (!up.ok) throw new Error(`ComfyUI へのファイル送信に失敗しました (HTTP ${up.status})`);
    const uploaded = await up.json();
    return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

// ワークフローを投入し、outputIds の各ノードの 3D 出力がそろうまで待つ。戻り値は outputIds 順の出力情報
async function queueAndWait(workflow, outputIds, runningMsg, onStatus, signal, timeoutMin = 10) {
    const res = await fetchApi("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId() }),
        signal,
    });
    const submitted = await res.json().catch(() => ({}));
    if (!res.ok || !submitted.prompt_id) {
        const nodeErr = Object.values(submitted.node_errors ?? {})[0]?.errors?.[0];
        const detail = nodeErr ? `${nodeErr.message}: ${nodeErr.details ?? ""}` : (submitted.error?.message ?? `HTTP ${res.status}`);
        throw new Error(`ComfyUI がワークフローを受け付けませんでした: ${detail}`);
    }

    const started = Date.now();
    for (;;) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        const sec = (Date.now() - started) / 1000;
        if (sec > timeoutMin * 60) throw new Error(`ComfyUI の実行が ${timeoutMin} 分以内に終わりませんでした`);
        onStatus(`${runningMsg}(${Math.round(sec)} 秒)`);
        await new Promise(r => setTimeout(r, 1000));
        const hist = await getJson(`/history/${submitted.prompt_id}`);
        const entry = hist[submitted.prompt_id];
        if (!entry) continue;
        if (entry.status?.status_str === "error") {
            const err = entry.status.messages?.find(m => m[0] === "execution_error")?.[1];
            throw new Error(`ComfyUI の実行エラー: ${String(err?.exception_message ?? "不明")}`);
        }
        const outs = outputIds.map(id => entry.outputs?.[id]?.["3d"]?.[0]);
        if (outs.every(Boolean)) return outs;
        if (entry.status?.completed) throw new Error("ComfyUI の実行は終わりましたが 3D ファイルが出力されませんでした(人物が検出されなかった可能性があります)");
    }
}

// 手の補正(run_hand_refinement)は、モデルが fp16 で動く環境で dtype の不一致で落ちる(Comfy-Org/ComfyUI #16963)。
// その場合は手の補正をオフにしてやり直す
async function withHandFallback(run, onStatus) {
    try {
        return await run(true);
    } catch (e) {
        if (e?.name === "AbortError" || !/dtype|Half/i.test(String(e?.message))) throw e;
        onStatus("手の補正(hand refinement)で ComfyUI がエラーになったため、オフにしてやり直します…");
        return run(false);
    }
}

// 画像を ComfyUI に渡して SAM3D Body を実行し、openpose / body_mesh の 2 種類の GLB を受け取る
export async function runSam3d(imageBlob, imageExt, modelFile, onStatus, signal) {
    onStatus("画像を ComfyUI に送信中…");
    const imageName = await uploadInput(imageBlob, `vrmpose_sam_input.${imageExt || "png"}`, signal);
    const prefix = `3d/vrmpose_sam_${Date.now()}`;
    const [op, mesh] = await withHandFallback(hand => queueAndWait(
        buildWorkflow(imageName, modelFile, prefix, hand), ["6", "7"],
        "SAM3D Body を実行中…初回はモデル読み込みで数十秒かかることがあります", onStatus, signal), onStatus);
    onStatus("結果を取得中…");
    const [openpose, meshBuf] = await Promise.all([downloadOutput(op), downloadOutput(mesh)]);
    return { openpose, mesh: meshBuf };
}

// 動画を ComfyUI に渡して SAM3D Body を全フレームに実行し、BVH(テキスト)を受け取る。range: { startSec, durationSec }
export async function runSam3dVideo(videoBlob, videoExt, modelFile, range, onStatus, signal) {
    onStatus("動画を ComfyUI に送信中…");
    const videoName = await uploadInput(videoBlob, `vrmpose_sam_input.${videoExt || "mp4"}`, signal);
    const prefix = `3d/vrmpose_motion_${Date.now()}`;
    const [bvh] = await withHandFallback(hand => queueAndWait(
        buildVideoWorkflow(videoName, modelFile, prefix, { ...range, handRefine: hand }), ["7"],
        "SAM3D Body で動画の全フレームを推定中…フレーム数に比例して時間がかかります", onStatus, signal, 60), onStatus);
    onStatus("結果を取得中…");
    return { text: new TextDecoder().decode(await downloadOutput(bvh)), filename: bvh.filename };
}

// ================================================================
// Image タブ UI
// ================================================================
// editor._imagePoseState にタブの状態(画像・SAM3D 結果・オプション)を保持し、モーダルを閉じて開き直しても残す。

function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "style") e.style.cssText = v;
        else e.setAttribute(k, v);
    }
    for (const c of children) e.append(c);
    return e;
}

function mkBtn(label, bg) {
    return el("button", {
        style: `padding:4px 9px;background:${bg};color:#fff;border:none;border-radius:4px;` +
               "cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap;",
    }, label);
}

function sectionTitle(t) {
    return el("div", {
        style: "font-size:10px;font-weight:bold;color:#6a8a9a;margin:8px 0 3px;" +
               "border-bottom:1px solid #252535;padding-bottom:2px;letter-spacing:.4px;",
    }, t.toUpperCase());
}

function mkCheck(label, checked, title) {
    const input = el("input", { type: "checkbox" });
    input.checked = checked;
    const row = el("label", { style: "display:flex;align-items:center;gap:6px;font-size:11px;color:#bbb;padding:2px 0;cursor:pointer;" });
    if (title) row.title = title;
    row.append(input, label);
    return [row, input];
}

function mkSlider(label, min, max, step, value, fmt) {
    const input = el("input", {
        type: "range", min: String(min), max: String(max), step: String(step), value: String(value),
        style: "flex:1;min-width:0;height:12px;accent-color:#4a90d9;cursor:pointer;",
    });
    input.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    const val = el("span", { style: "font-size:10px;color:#888;width:34px;text-align:right;flex-shrink:0;" }, fmt(value));
    input.addEventListener("input", () => { val.textContent = fmt(parseFloat(input.value)); });
    const row = el("div", { style: "display:flex;align-items:center;gap:6px;padding:2px 0;" });
    row.append(el("span", { style: "font-size:10px;color:#888;width:64px;flex-shrink:0;" }, label), input, val);
    return [row, input];
}

// 戻り値: { leftEl, propEl, onShow }
//   leftEl: 左ペイン(270px、画像・動画の読み込み・表示)
//   propEl: 右ペイン(280px、SAM3D 実行・オプション・適用)
//   onShow: Image タブが表示されるたびに呼ぶ(ComfyUI のノード/モデル確認)
// hooks.importKeyframes(vrmaBuffer, name): 動画から作ったモーションをキーフレームパネルへ取り込む(無ければ動画は使えない)
export function buildImagePosePanel(editor, hooks = {}) {
    const state = editor._imagePoseState ??= {
        imageFile: null,     // File | Blob(画像または動画)
        imageUrl: null,      // object URL(プレビュー用)
        imageName: "",
        isVideo: false,
        videoDuration: 0,    // 秒(動画のメタデータから)
        videoStart: 0,
        videoLength: 0,      // 0 = 最後まで
        sam: null,           // parseOpenposeGlb の結果
        hands: null,         // parseMeshHands の結果
        source: "",          // 結果の出どころ(表示用)
        model: "",
        opts: { ...defaultSolveOptions, useHands: true, ground: true },
        undoPose: null,      // 最初に適用する直前のポーズ(exportPose JSON)
        undoVrm: null,       // undoPose を取ったときの VRM
    };

    // ---------------- 左ペイン: 画像 ----------------
    const leftEl = el("div", {
        style: "width:270px;flex-shrink:0;display:none;flex-direction:column;" +
               "border-right:1px solid #2a2a4a;background:#161622;overflow:hidden;",
    });
    const leftHeader = el("div", {
        style: "display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid #2a2a4a;flex-shrink:0;",
    });
    const loadImgBtn = mkBtn("📂 Load Image", "#2a5a8a");
    loadImgBtn.title = "画像(1 ポーズ)または動画(モーション)を読み込む";
    const imgInput = el("input", {
        type: "file", accept: "image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime", style: "display:none;",
    });
    loadImgBtn.onclick = () => imgInput.click();
    leftHeader.append(el("span", { style: "font-size:12px;font-weight:bold;color:#aaa;flex:1;" }, "Image"), loadImgBtn, imgInput);

    const dropZone = el("div", {
        style: "flex:1;margin:8px;border:2px dashed #33334a;border-radius:6px;display:flex;align-items:center;" +
               "justify-content:center;overflow:hidden;min-height:0;position:relative;background:#12121c;",
    });
    const placeholder = el("div", {
        style: "font-size:11px;color:#556;text-align:center;line-height:1.7;padding:10px;",
    }, "画像・動画をドロップ\nまたは「Load Image」");
    placeholder.style.whiteSpace = "pre-line";
    const preview = el("img", { style: "max-width:100%;max-height:100%;object-fit:contain;display:none;" });
    const vpreview = el("video", { style: "max-width:100%;max-height:100%;object-fit:contain;display:none;" });
    vpreview.controls = true;
    vpreview.muted = true;
    vpreview.addEventListener("loadedmetadata", () => {
        const fresh = !state.videoDuration; // 新しく読み込んだ動画(モーダルを開き直したときは利用者の範囲を残す)
        state.videoDuration = Number.isFinite(vpreview.duration) ? vpreview.duration : 0;
        if (fresh && state.videoDuration > 0) state.videoLength = Math.min(state.videoDuration, DEFAULT_VIDEO_SEC);
        refreshVideoRange();
    });
    dropZone.append(placeholder, preview, vpreview);
    const imgInfo = el("div", {
        style: "font-size:10px;color:#778;padding:0 10px 8px;word-break:break-all;flex-shrink:0;",
    });
    const tips = el("div", {
        style: "font-size:10px;color:#556;padding:0 10px 10px;line-height:1.6;flex-shrink:0;",
    }, "1人・全身が写り、手足が隠れていない画像・動画が最適です。自撮りなど左右反転した画像は「Mirror」をオンにしてください。");
    leftEl.append(leftHeader, dropZone, imgInfo, tips);

    const isMedia = (f) => f?.type?.startsWith("image/") || f?.type?.startsWith("video/");
    function setImage(file) {
        if (!isMedia(file)) return;
        if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
        state.imageFile = file;
        state.imageName = file.name ?? "image";
        state.imageUrl = URL.createObjectURL(file);
        state.isVideo = file.type.startsWith("video/");
        state.videoDuration = 0;
        state.videoStart = 0;
        state.videoLength = 0;
        setStatus(state.isVideo ? "動画を読み込みました。取り込む範囲を決めて「Run SAM3D (Video)」を押してください"
                                : "画像を読み込みました。「Run SAM3D」を押してください");
        // 別の画像に変えたら、前の画像の SAM3D 結果は無効
        state.sam = null;
        state.hands = null;
        state.source = "";
        refreshImage();
        refreshStatus();
    }
    function refreshImage() {
        const has = !!state.imageUrl;
        const vid = has && state.isVideo;
        preview.style.display = has && !vid ? "" : "none";
        vpreview.style.display = vid ? "" : "none";
        placeholder.style.display = has ? "none" : "";
        if (has && !vid && preview.src !== state.imageUrl) preview.src = state.imageUrl;
        if (vid && vpreview.src !== state.imageUrl) vpreview.src = state.imageUrl;
        if (!vid && vpreview.src) { vpreview.pause(); vpreview.removeAttribute("src"); vpreview.load(); }
        imgInfo.textContent = has ? state.imageName : "";
        runBtn.textContent = vid ? "▶ Run SAM3D (Video)" : "▶ Run SAM3D";
        imageOnly.style.display = vid ? "none" : "";
        videoOnly.style.display = vid ? "" : "none";
        runBtn.disabled = !has || busy;
        runBtn.style.opacity = runBtn.disabled ? "0.5" : "1";
    }
    imgInput.addEventListener("change", () => { setImage(imgInput.files[0]); imgInput.value = ""; });
    dropZone.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); dropZone.style.borderColor = "#4a90d9"; });
    dropZone.addEventListener("dragleave", () => { dropZone.style.borderColor = "#33334a"; });
    dropZone.addEventListener("drop", e => {
        e.preventDefault(); e.stopPropagation();
        dropZone.style.borderColor = "#33334a";
        const files = [...(e.dataTransfer?.files ?? [])];
        const img = files.find(isMedia);
        if (img) setImage(img);
        const glbs = files.filter(f => /\.glb$/i.test(f.name));
        if (glbs.length) void loadGlbFiles(glbs);
    });

    // ---------------- 右ペイン: SAM3D・オプション ----------------
    const propEl = el("div", {
        style: "width:280px;flex-shrink:0;display:none;flex-direction:column;background:#181826;",
    });
    propEl.append(el("div", {
        style: "font-size:11px;font-weight:bold;color:#7a9aaa;padding:7px 12px;border-bottom:1px solid #2a2a4a;flex-shrink:0;",
    }, "Image → Pose (SAM 3D Body)"));
    const propBody = el("div", { style: "flex:1;overflow-y:auto;padding:6px 12px 10px;" });
    propEl.append(propBody);

    // SAM3D 実行
    const modelSel = el("select", {
        style: "flex:1;min-width:0;background:#222;color:#ccc;border:1px solid #444;border-radius:3px;font-size:10px;padding:2px;",
    });
    modelSel.addEventListener("change", () => { state.model = modelSel.value; });
    const runBtn = mkBtn("▶ Run SAM3D", "#3a7a4a");
    runBtn.style.flex = "1";
    const cancelBtn = mkBtn("■", "#6a3a3a");
    cancelBtn.title = "Cancel (結果の待機を中止)";
    cancelBtn.style.display = "none";
    const statusEl = el("div", {
        style: "font-size:10px;color:#889;padding:4px 0;line-height:1.5;white-space:pre-wrap;word-break:break-word;",
    });

    // 手動 GLB 読み込み(ComfyUI で別途作った openpose / body_mesh の GLB)
    const glbBtn = mkBtn("📂 Load GLB", "#5a5a7a");
    glbBtn.title = "SAM3D の GLB(BuildPoseFile → SaveGLB、mesh_style=openpose / body_mesh)を読み込む。複数選択可";
    const glbInput = el("input", { type: "file", accept: ".glb", multiple: "", style: "display:none;" });
    glbBtn.onclick = () => glbInput.click();
    glbInput.addEventListener("change", () => { void loadGlbFiles([...glbInput.files]); glbInput.value = ""; });

    // オプション
    const o = state.opts;
    const [mirrorRow, mirrorChk] = mkCheck("Mirror (鏡像として扱う)", o.mirror, "自撮りなど左右反転した画像のとき");
    const [handsRow, handsChk] = mkCheck("Hands (SAM3D の指・手首を使う)", o.useHands, "body_mesh の手の骨から指の形と手首の向きを取り込む");
    const [fingersRow, fingersChk] = mkCheck("Fingers (指を解く)", o.fingers);
    const [yawRow, yawChk] = mkCheck("Face front (体の向きを正面に)", o.removeYaw, "カメラに対する体全体のヨーを除去する");
    const [groundRow, groundChk] = mkCheck("Ground (足を床に合わせる)", o.ground);
    const [headRow, headSl] = mkSlider("Head pitch", -30, 45, 1, o.headPitchDeg, v => `${v}°`);
    const [twistRow, twistSl] = mkSlider("Wrist twist", 0, 1, 0.05, o.twistSplit, v => v.toFixed(2));
    twistRow.title = "手首のねじれを前腕に分配する割合";

    const applyBtn = mkBtn("✔ Apply to VRM", "#4a6a9a");
    applyBtn.style.flex = "1";
    const revertBtn = mkBtn("↶ Revert", "#6a5a3a");
    revertBtn.title = "Image タブで最初に適用する前のポーズへ戻す";

    const row = (...items) => {
        const r = el("div", { style: "display:flex;align-items:center;gap:5px;padding:2px 0;" });
        r.append(...items);
        return r;
    };

    // 動画: 取り込む範囲(秒)。SAM3D は全フレームを推定するので、長いほど時間・メモリがかかる
    const secInput = () => {
        const i = el("input", {
            type: "number", min: "0", step: "0.5",
            style: "width:52px;background:#222;color:#ccc;border:1px solid #444;border-radius:3px;font-size:10px;padding:2px;",
        });
        i.addEventListener("keydown", e => e.stopPropagation());
        return i;
    };
    const vStartIn = secInput(), vLenIn = secInput();
    const vInfo = el("div", { style: "font-size:10px;color:#9ab;padding:2px 0;" });
    vStartIn.addEventListener("change", () => { state.videoStart = Math.max(0, parseFloat(vStartIn.value) || 0); refreshVideoRange(); });
    vLenIn.addEventListener("change", () => { state.videoLength = Math.max(0, parseFloat(vLenIn.value) || 0); refreshVideoRange(); });
    const label = (t) => el("span", { style: "font-size:10px;color:#888;flex-shrink:0;" }, t);
    function refreshVideoRange() {
        const d = state.videoDuration;
        if (d > 0) state.videoStart = Math.min(state.videoStart, Math.max(0, d - 0.1));
        vStartIn.value = String(+state.videoStart.toFixed(2));
        vLenIn.value = String(+state.videoLength.toFixed(2));
        vInfo.textContent = d > 0 ? `動画の長さ: ${d.toFixed(1)} 秒 → ${state.videoStart.toFixed(1)}〜${Math.min(d, state.videoStart + (state.videoLength || d)).toFixed(1)} 秒を取り込み` : "";
    }
    const videoOnly = el("div");
    videoOnly.append(
        sectionTitle("Video → Motion"),
        vInfo,
        row(label("Start"), vStartIn, label("s"), label("  Length"), vLenIn, label("s")),
        el("div", {
            style: "font-size:10px;color:#556;line-height:1.6;margin-top:4px;",
        }, "全フレームを SAM3D Body で推定して BVH を作り、キーフレームへ取り込みます(取り込み設定のダイアログが開きます)。長さ 0 = 最後まで。目安: RTX 4070 で 3 秒(90 フレーム)が約 20 秒。BVH は ComfyUI の output/3d にも保存されます。"),
    );
    const imageOnly = el("div");
    imageOnly.append(
        sectionTitle("Options"),
        mirrorRow, handsRow, fingersRow, yawRow, groundRow, headRow, twistRow,
        sectionTitle("Apply"),
        row(applyBtn, revertBtn),
    );
    propBody.append(
        sectionTitle("SAM 3D Body (ComfyUI)"),
        row(el("span", { style: "font-size:10px;color:#888;flex-shrink:0;" }, "Model"), modelSel),
        row(runBtn, cancelBtn),
        row(glbBtn, glbInput),
        statusEl,
        imageOnly,
        videoOnly,
        el("div", {
            style: "font-size:10px;color:#556;line-height:1.6;margin-top:8px;",
        }, "SAM 3D Body は ComfyUI 本体のネイティブノードで実行します(このノードには同梱していません)。モデルは models/detection/ に配置してください。適用後は Pose タブやキーフレームでそのまま微調整・保存できます。"),
    );

    // ---------------- 動作 ----------------
    let busy = false;
    let abort = null;
    let lastMessage = "";

    function setStatus(msg, kind) {
        lastMessage = msg;
        statusEl.textContent = msg;
        statusEl.style.color = kind === "error" ? "#e88" : kind === "ok" ? "#8c8" : "#889";
    }
    function refreshStatus() {
        const has = !!state.sam;
        applyBtn.disabled = !has;
        applyBtn.style.opacity = has ? "1" : "0.5";
        revertBtn.disabled = !state.undoPose;
        revertBtn.style.opacity = state.undoPose ? "1" : "0.5";
        if (!busy && !lastMessage) {
            setStatus(has ? `結果あり: ${state.source}` : "画像を読み込んで「Run SAM3D」を押してください");
        }
    }
    function setBusy(b) {
        busy = b;
        cancelBtn.style.display = b ? "" : "none";
        glbBtn.disabled = b;
        refreshImage();
    }

    function readOpts() {
        o.mirror = mirrorChk.checked;
        o.useHands = handsChk.checked;
        o.fingers = fingersChk.checked;
        o.removeYaw = yawChk.checked;
        o.ground = groundChk.checked;
        o.headPitchDeg = parseFloat(headSl.value);
        o.twistSplit = parseFloat(twistSl.value);
        return o;
    }

    // SAM3D 結果 → ソルブ → VRM へ適用
    function solveAndApply(silent) {
        if (!state.sam) return false;
        const vrm = editor.getVRM?.();
        if (!vrm?.humanoid) {
            setStatus("VRM モデル(humanoid 付き)を読み込んでください。GLB/GLTF モデルには適用できません", "error");
            return false;
        }
        const opt = readOpts();
        const hands = opt.useHands ? state.hands : null;
        const input = {
            pose: samToPose(state.sam, hands),
            leftHand: hands?.left, rightHand: hands?.right,
            leftHandSide: hands?.leftSide, rightHandSide: hands?.rightSide,
        };
        const rig = captureRig(vrm);
        // Revert 用のポーズは同じモデルに対してだけ有効(モデルを差し替えたら取り直す)
        if (state.undoVrm !== vrm) { state.undoPose = null; state.undoVrm = vrm; }
        if (!state.undoPose) state.undoPose = editor.exportPose();
        const res = solvePose(input, rig, opt);
        applySolvedPose(editor, vrm, rig, res.rotations, opt.ground);
        refreshStatus();
        if (!silent) {
            const sk = res.skipped.length ? `\n(推定できず: ${res.skipped.join(", ")})` : "";
            setStatus(`VRM に適用しました: ${state.source}${sk}`, "ok");
        }
        return true;
    }

    // オプションを変えたら、結果があれば即再適用
    for (const c of [mirrorChk, handsChk, fingersChk, yawChk, groundChk]) {
        c.addEventListener("change", () => { readOpts(); if (state.sam) solveAndApply(true); });
    }
    for (const s of [headSl, twistSl]) {
        s.addEventListener("change", () => { readOpts(); if (state.sam) solveAndApply(true); });
    }

    applyBtn.onclick = () => solveAndApply(false);
    revertBtn.onclick = () => {
        if (!state.undoPose) return;
        if (state.undoVrm !== editor.getVRM?.()) {
            state.undoPose = null;
            setStatus("モデルが変わったため、戻すポーズがありません");
            refreshStatus();
            return;
        }
        editor.importPose(state.undoPose);
        state.undoPose = null;
        setStatus("適用前のポーズに戻しました");
        refreshStatus();
    };

    async function applyGlbBuffer(buf, name) {
        const kind = classifyGlb(buf);
        if (kind === "openpose") {
            state.sam = parseOpenposeGlb(buf);
            state.source = name;
        } else if (kind === "mesh") {
            state.hands = parseMeshHands(buf);
        } else {
            throw new Error(`${name}: SAM3D Body の GLB ではありません(format=glb、mesh_style は openpose か body_mesh)`);
        }
        return kind;
    }

    async function loadGlbFiles(files) {
        try {
            // body_mesh(手)を先に読み、openpose(体)を後に読んでから適用する
            const bufs = await Promise.all(files.map(async f => ({ name: f.name, buf: await f.arrayBuffer() })));
            const rank = x => (classifyGlb(x.buf) === "mesh" ? 0 : 1);
            bufs.sort((a, b) => rank(a) - rank(b));
            const kinds = [];
            for (const { name, buf } of bufs) kinds.push(await applyGlbBuffer(buf, name));
            if (state.sam) {
                if (solveAndApply(true)) setStatus(`GLB を読み込んで適用しました(${kinds.join(" + ")})`, "ok");
            } else {
                setStatus("body_mesh の GLB を読み込みました。体の向きには openpose の GLB も必要です");
            }
        } catch (e) {
            setStatus(String(e.message ?? e), "error");
        }
        refreshStatus();
    }

    runBtn.onclick = async () => {
        if (busy || !state.imageFile) return;
        if (!editor.getVRM?.()?.humanoid) {
            setStatus("先に VRM モデルを読み込んでください", "error");
            return;
        }
        const modelFile = modelSel.value;
        if (!modelFile) { await refreshAvailability(); if (!modelSel.value) return; }
        if (state.isVideo) {
            if (!hooks.importKeyframes) { setStatus("この画面からは動画のモーションを取り込めません", "error"); return; }
            if (!videoOk) { setStatus(`ComfyUI に動画用のノードがありません(${VIDEO_NODES.join(", ")})。ComfyUI を更新してください`, "error"); return; }
        }
        setBusy(true);
        abort = new AbortController();
        const t0 = performance.now();
        try {
            const ext = (state.imageName.split(".").pop() ?? "png").toLowerCase();
            if (state.isVideo) { await runVideo(ext, t0); return; }
            const r = await runSam3d(state.imageFile, ext, modelSel.value, msg => setStatus(msg), abort.signal);
            state.hands = parseMeshHands(r.mesh);
            state.sam = parseOpenposeGlb(r.openpose);
            state.source = `SAM3D (${state.imageName})`;
            solveAndApply(true);
            setStatus(`SAM3D 推定・適用完了(${((performance.now() - t0) / 1000).toFixed(1)} 秒)`, "ok");
        } catch (e) {
            if (e?.name === "AbortError") setStatus("中止しました(ComfyUI のキューに残ったジョブは ComfyUI 側で取り消してください)");
            else setStatus(String(e.message ?? e), "error");
        } finally {
            abort = null;
            setBusy(false);
            refreshStatus();
        }
    };
    cancelBtn.onclick = () => abort?.abort();

    // 動画 → BVH → 取り込み設定 → .vrma → キーフレーム
    async function runVideo(ext, t0) {
        const range = { startSec: state.videoStart, durationSec: state.videoLength };
        const r = await runSam3dVideo(state.imageFile, ext, modelSel.value, range, msg => setStatus(msg), abort.signal);
        const sec = ((performance.now() - t0) / 1000).toFixed(1);
        setStatus(`BVH を受け取りました(${sec} 秒、${r.filename})。取り込み設定を選んでください`);
        const opts = await askBvhImportOptions(r.filename, undefined, peekBvh(r.text));
        if (!opts) { setStatus(`取り込みを取り消しました(BVH は ComfyUI の output/3d/${r.filename} に保存済み)`); return; }
        const buf = await bvhTextToVrmaBuffer(editor, r.text, opts);
        hooks.importKeyframes(buf, state.imageName.replace(/\.[^.]+$/, ""));
        setStatus(`動画のモーションをキーフレームに取り込みました(推定 ${sec} 秒、${r.filename})`, "ok");
    }

    let availabilityChecked = false;
    let videoOk = false;
    async function refreshAvailability() {
        try {
            const r = await checkSam3dAvailable();
            modelSel.replaceChildren(...r.models.map(m => el("option", { value: m }, m)));
            const pick = r.models.includes(state.model) ? state.model
                : r.models.includes(PREFERRED_MODEL) ? PREFERRED_MODEL
                : r.models.find(m => /sam_3d_body|sam3d/i.test(m)) ?? r.models[0] ?? "";
            modelSel.value = pick;
            state.model = pick;
            if (!r.ok) setStatus(r.message, "error");
            availabilityChecked = r.ok;
            videoOk = !!r.videoOk;
        } catch (e) {
            setStatus(`ComfyUI のノード情報を取得できません: ${e.message ?? e}`, "error");
        }
    }

    refreshImage();
    refreshVideoRange();
    refreshStatus();

    return {
        leftEl,
        propEl,
        onShow() {
            if (!availabilityChecked) void refreshAvailability();
        },
    };
}
